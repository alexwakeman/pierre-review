import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import type {
  ConflictCommitBody,
  ConflictLandErrorCode,
  ConflictOpenBody,
  ConflictSessionEvent,
} from '@pierre-review/shared';
import { assertPushTarget } from '../../coding/git.js';
import { gitSupportsMergeTree } from '../../conflict/git.js';
import { conflictModelHash } from '../../conflict/hash.js';
import { landConflictResolution, type ConflictLandError } from '../../conflict/land.js';
import { buildConflictModel, conflictFileContent } from '../../conflict/model.js';
import {
  claimCommitSlot,
  claimSession,
  dropSession,
  getSession,
  sessionView,
  setCommitPhase,
  setPreparePhase,
  settleCommitDone,
  settleCommitFailed,
  settleFailed,
  settleReady,
  subscribe,
  type ConflictSessionRecord,
} from '../../conflict/session.js';
import { getPrWriteContext, WRITE_PERMISSIONS } from '../../db/queries.js';
import { accountIdOf } from '../plugins/auth.js';

/**
 * THE MERGE-CONFLICT RESOLVER'S SIX ROUTES (CORE / free, BOTH MODES).
 *
 * ⚠ REGISTERED UNCONDITIONALLY. These were local-only; they are not any more. There is still no
 * `CONFLICT_RESOLVER_ENABLED` and there must not be one, because a per-handler env check LOOKS
 * like a gate while being one Railway variable away from not being one.
 *
 * ⚠ WHAT MAKES THEM SAFE IN A MULTI-TENANT PROCESS is not anything in this file's cloud story —
 * it is that nothing here was ever single-tenant. Ownership is `getPrWriteContext(id, accountId)`
 * on every route, and every git fetch goes out under the CALLER'S OWN token
 * (`fetchRefIntoClone`), into a ref namespaced by session id. The clone cache is shared across
 * accounts and holds OBJECTS, never permission: a tenant who cannot read a private repository
 * cannot fetch from it, whoever else has cloned it.
 *
 *   POST   /api/prs/:id/conflicts               open  → 202 + a `preparing` session
 *   GET    /api/prs/:id/conflicts?session=      the manifest (no regions)
 *   GET    /api/prs/:id/conflicts/stream        the ONE SSE channel — prepare AND commit
 *   GET    /api/prs/:id/conflicts/files/:index  one file's regions
 *   POST   /api/prs/:id/conflicts/commit        the push → 202, phases on the stream
 *   DELETE /api/prs/:id/conflicts?session=      drop the server session
 *
 * ⚠ NOTHING ON THIS WIRE ACCEPTS FILE CONTENT. Every request field is an index, an id or an
 * enum member; an accepted model suggestion travels as an opaque `suggestionId` addressing text
 * the SERVER holds. That is what makes "no free typing" a property of the protocol.
 *
 * WHY OPEN AND COMMIT ARE ASYNCHRONOUS. Fastify's `requestTimeout` is 60s and a git command may
 * take 120; a cold `ensureClone` on a large repository blows straight past both. So each of the
 * two POSTs validates everything CHEAP synchronously — ownership, permission, the JSON schema,
 * the session match, the SHA pins, the branch name, decision completeness — and refuses with a
 * real status code. Only then does it answer 202 and run. A malformed request never gets a
 * terminal stream frame where an error belongs.
 *
 * ⚠ THE SESSION ID IS NOT AUTHORISATION. Ownership is re-checked on EVERY route through
 * `getPrWriteContext` (→ 404, no existence oracle) and write permission (→ 403). `sessionId` is
 * a concurrency token: a commit whose id no longer matches is `SessionExpired`.
 */

const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

const sessionQuerySchema = {
  ...idParamSchema,
  querystring: {
    type: 'object',
    required: ['session'],
    properties: { session: { type: 'string', minLength: 1, maxLength: 100 } },
  },
};

const openSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      autoApply: { type: 'boolean' },
      restart: { type: 'boolean' },
    },
  },
};

const fileSchema = {
  params: {
    type: 'object',
    required: ['id', 'fileIndex'],
    properties: {
      id: { type: 'integer' },
      fileIndex: { type: 'integer', minimum: 0 },
    },
  },
  querystring: sessionQuerySchema.querystring,
};

const commitSchema = {
  ...idParamSchema,
  body: {
    type: 'object',
    required: ['sessionId', 'expectedHeadSha', 'expectedBaseSha', 'modelHash', 'strategy', 'target', 'files'],
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 100 },
      expectedHeadSha: { type: 'string', minLength: 4, maxLength: 64 },
      expectedBaseSha: { type: 'string', minLength: 4, maxLength: 64 },
      modelHash: { type: 'string', minLength: 4, maxLength: 128 },
      strategy: { type: 'string', enum: ['merge', 'rebase'] },
      target: {
        type: 'object',
        required: ['kind'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['pr_branch', 'new_branch'] },
          branch: { type: 'string', minLength: 1, maxLength: 255 },
          openPr: { type: 'boolean' },
        },
      },
      files: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          required: ['index', 'decisions'],
          additionalProperties: false,
          properties: {
            index: { type: 'integer', minimum: 0 },
            decisions: {
              type: 'array',
              maxItems: 2000,
              items: {
                type: 'object',
                required: ['id', 'decision'],
                additionalProperties: false,
                properties: {
                  id: { type: 'integer', minimum: 0 },
                  decision: {
                    type: 'string',
                    enum: [
                      'base',
                      'ours',
                      'theirs',
                      'both_ours_first',
                      'both_theirs_first',
                      'disjoint_merge',
                      'suggestion',
                    ],
                  },
                  suggestionId: { type: 'string', minLength: 1, maxLength: 100 },
                },
              },
            },
          },
        },
      },
    },
  },
};

interface ErrorBody {
  error: string;
  message: string;
}

/** Every refusal is `{error, message}` with ONE sentence that states the fact and stops. No
 *  sentence here names a region, a hunk, a slot, a stage or an engine. */
function refuse(reply: FastifyReply, status: number, error: string, message: string): ErrorBody {
  reply.status(status);
  return { error, message };
}

const notFound = (reply: FastifyReply, id: number): ErrorBody =>
  refuse(reply, 404, 'NotFound', `PR ${id} not found`);

const SESSION_EXPIRED = 'This session is no longer open. Reopen it and take your decisions again.';

/**
 * The `(accountId, prId)` a request may act on, or a refusal.
 *
 * ⚠ ONE RESOLVER FOR ALL SIX ROUTES. A 404 for another tenant's id is what keeps the family from
 * being an existence oracle, and a per-handler copy of that rule is a per-handler chance to
 * forget it.
 */
async function requireWritablePr(
  reply: FastifyReply,
  accountId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; body: ErrorBody }> {
  const ctx = await getPrWriteContext(id, accountId);
  if (!ctx) return { ok: false, body: notFound(reply, id) };
  if (!WRITE_PERMISSIONS.has(ctx.viewerPermission ?? '')) {
    return {
      ok: false,
      body: refuse(
        reply,
        403,
        'NotPermitted',
        'You need write access to resolve conflicts on this pull request.',
      ),
    };
  }
  return { ok: true };
}

/**
 * FOUR REFUSALS, FOUR FACTS. A claim can fail for four different reasons and they are NOT
 * interchangeable sentences — nor one sentence with a variable in it.
 *
 * ⚠ THE READER IS ONLY EVER TOLD ABOUT THEIR OWN WORK. "You already have one open" is a fact
 * about this account; "the service is busy" is a fact about the service. Neither names a count,
 * an account or a pull request belonging to anyone else. The predecessor collapsed the last two
 * into "Two pull requests are already being prepared", which in cloud was both false about the
 * reader's work and a disclosure about somebody else's.
 */
const BUSY_PR = 'This pull request is already being worked on. Give it a moment.';
const BUSY_ACCOUNT = 'You’re already resolving another pull request. Finish that one first.';
const BUSY_SERVICE = 'The service is busy. Try again in a moment.';
const RESTARTING = 'This server is restarting. Try again in a moment.';
/** A fact about the reader's own windows, like `BUSY_ACCOUNT` — never about the service. */
const TOO_MANY_STREAMS = 'This resolver is open in too many windows. Close one and try again.';

/** Live streams one session may hold. Two or three tabs is the real ceiling; past that it is
 *  not a reader. */
const MAX_STREAM_SUBSCRIBERS = 4;
/** How long the server holds one hijacked socket before ending it itself. Inside Railway's
 *  15-minute request ceiling on purpose, so the close is OURS and the client's recovery path is
 *  the one that runs. */
const STREAM_MAX_MS = 10 * 60_000;

/** One mapper, so the six routes cannot disagree about what a claim refusal means. */
function refuseBusy(
  reply: FastifyReply,
  reason: 'pr' | 'account' | 'capacity' | 'shutdown',
): ErrorBody {
  switch (reason) {
    case 'pr':
      return refuse(reply, 409, 'Busy', BUSY_PR);
    case 'account':
      return refuse(reply, 409, 'Busy', BUSY_ACCOUNT);
    case 'capacity':
      // 503, not 409: nothing about THIS request conflicts with anything — the service has no
      // room, and the honest status for that is "try later".
      return refuse(reply, 503, 'Busy', BUSY_SERVICE);
    case 'shutdown':
      return refuse(reply, 503, 'Restarting', RESTARTING);
  }
}

export async function conflictRoutes(app: FastifyInstance): Promise<void> {
  // ---- 1. Open ----------------------------------------------------------------------------
  app.post('/api/prs/:id/conflicts', { schema: openSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const body = (req.body ?? {}) as ConflictOpenBody;
    const accountId = accountIdOf(req);

    const allowed = await requireWritablePr(reply, accountId, id);
    if (!allowed.ok) return allowed.body;
    // `merge-tree --write-tree` needs git 2.38. Probed ONCE per process, here rather than on
    // `/api/me` — a version probe on every SPA boot answers a question this route can answer
    // once, and only this route can do anything about the answer.
    if (!(await gitSupportsMergeTree())) {
      return refuse(
        reply,
        501,
        'GitUnavailable',
        'git isn’t available here. Resolve conflicts on GitHub.',
      );
    }

    const claim = claimSession(accountId, id, {
      restart: body.restart === true,
      autoApply: body.autoApply !== false,
    });
    if (claim.kind === 'busy') return refuseBusy(reply, claim.reason);
    if (claim.kind === 'reused') {
      // Re-attaching to the live session is the whole answer to a second tab: no second clone,
      // no second model, and the stream the client is about to subscribe to is already running.
      reply.status(claim.session.status === 'preparing' ? 202 : 200);
      return sessionView(claim.session);
    }

    const rec = claim.session;
    reply.status(202);
    void runOpen(rec, req.log);
    return sessionView(rec);
  });

  // ---- 2. The manifest --------------------------------------------------------------------
  app.get('/api/prs/:id/conflicts', { schema: sessionQuerySchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { session } = req.query as { session: string };
    const accountId = accountIdOf(req);

    const allowed = await requireWritablePr(reply, accountId, id);
    if (!allowed.ok) return allowed.body;

    const rec = getSession(accountId, id, session);
    if (!rec) return refuse(reply, 409, 'SessionExpired', SESSION_EXPIRED);
    return sessionView(rec);
  });

  // ---- 3. The ONE stream ------------------------------------------------------------------
  //
  // Prepare progress AND the commit's phases arrive here; there is no second channel and no
  // second job registry. It is a GET, so `req.raw.on('close')` IS the disconnect signal — the
  // reply-socket rule is a POST rule (a POST's request `close` fires the moment Fastify has read
  // the body), and both POSTs in this family answer in milliseconds and hold no disconnect state.
  app.get('/api/prs/:id/conflicts/stream', { schema: sessionQuerySchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { session } = req.query as { session: string };
    const accountId = accountIdOf(req);

    // ⚠ BEFORE `reply.hijack()`. Once the socket is hijacked there is no clean way to 404, and
    // an ownership check that runs after it is an ownership check that cannot refuse.
    const allowed = await requireWritablePr(reply, accountId, id);
    if (!allowed.ok) return allowed.body;

    const rec = getSession(accountId, id, session);
    if (!rec) return refuse(reply, 409, 'SessionExpired', SESSION_EXPIRED);
    // ⚠ ALSO BEFORE `reply.hijack()`. A hijacked socket is held until the client drops it or the
    // session ends, and nothing else bounds how many of them one caller may hold: this route is
    // on the 600/min `read` bucket, so a client that opens streams and never reads them
    // accumulates sockets and 15-second heartbeat timers until the proxy's own request ceiling
    // reaps them — about 9,000 of each in cloud. A real reader has one per open tab.
    if (rec.subscribers.size >= MAX_STREAM_SUBSCRIBERS) {
      return refuse(reply, 409, 'Busy', TOO_MANY_STREAMS);
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (e: ConflictSessionEvent): void => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    let closed = false;
    const hb = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15_000);
    // ⚠ THE SERVER ENDS IT FIRST, DELIBERATELY. A stream is otherwise held for as long as the
    // client keeps the socket open, and the session outliving the stream is the design — so the
    // SPA already recovers from a stream that ends (`useConflictSession` falls through to the
    // manifest poll, which carries the whole commit state). Ending it ourselves, well inside the
    // proxy's 15-minute request ceiling, costs the reader nothing and is what stops a held socket
    // being unbounded in a process every tenant shares.
    const lifetime = setTimeout(() => cleanup(), STREAM_MAX_MS);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      clearTimeout(lifetime);
      unsub();
      if (!raw.writableEnded) raw.end();
    };
    // ⚠ SUBSCRIBE, THEN SNAPSHOT. The build is already running by the time a client can reach
    // this route, so a `ready` emitted between the snapshot and the subscribe would be lost and
    // the overlay would sit on "Reading the conflicting files…" forever.
    const unsub = subscribe(rec, (e) => {
      send(e);
      if (e.type === 'done') cleanup();
    });
    req.raw.on('close', cleanup);
    send({ type: 'snapshot', session: sessionView(rec) });
    // Deliberately NOT terminal on a settled session: a `ready` session's commit phases arrive
    // on this same stream, minutes later. The client closes it, or the session is dropped.
  });

  // ---- 4. One file's regions --------------------------------------------------------------
  app.get('/api/prs/:id/conflicts/files/:fileIndex', { schema: fileSchema }, async (req, reply) => {
    const { id, fileIndex } = req.params as { id: number; fileIndex: number };
    const { session } = req.query as { session: string };
    const accountId = accountIdOf(req);

    const allowed = await requireWritablePr(reply, accountId, id);
    if (!allowed.ok) return allowed.body;

    const rec = getSession(accountId, id, session);
    if (!rec) return refuse(reply, 409, 'SessionExpired', SESSION_EXPIRED);
    const model = rec.model;
    const content = model ? conflictFileContent(model, fileIndex, rec.autoApply) : null;
    if (!content) {
      return refuse(
        reply,
        400,
        'UnknownFileIndex',
        'That file isn’t part of this session. Reopen the resolver.',
      );
    }
    return content;
  });

  // ---- 5. Commit --------------------------------------------------------------------------
  app.post('/api/prs/:id/conflicts/commit', { schema: commitSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const body = req.body as ConflictCommitBody;
    const accountId = accountIdOf(req);

    const allowed = await requireWritablePr(reply, accountId, id);
    if (!allowed.ok) return allowed.body;

    const rec = getSession(accountId, id, body.sessionId);
    if (!rec) return refuse(reply, 409, 'SessionExpired', SESSION_EXPIRED);
    const model = rec.model;
    if (!model) return refuse(reply, 409, 'SessionExpired', SESSION_EXPIRED);
    if (rec.status === 'clean' || model.files.length === 0) {
      return refuse(
        reply,
        409,
        'NoConflicts',
        `This pull request no longer conflicts with ${model.baseRef}.`,
      );
    }

    // ---- the pins ----
    // A decision made against different bytes is not a decision. Three separate facts, three
    // separate sentences: which commit the branch was on, which one the base was on, and
    // whether the merge itself came out the same. `modelHash` is the only one that can catch a
    // fold or chunker change (`CONFLICT_MODEL_VERSION` is folded into it), and it is checked
    // against the SESSION's hash rather than a recomputation so the two cannot drift.
    if (body.expectedHeadSha !== model.headSha) {
      return refuse(
        reply,
        409,
        'HeadMoved',
        `Someone pushed to ${model.headRef} while you were resolving. Reopen the resolver.`,
      );
    }
    if (body.expectedBaseSha !== model.baseSha) {
      return refuse(
        reply,
        409,
        'BaseMoved',
        `${model.baseRef} moved and the conflicts changed. Reopen the resolver.`,
      );
    }
    if (body.modelHash !== rec.modelHash) {
      return refuse(
        reply,
        409,
        'ModelStale',
        'The conflicts changed while you were resolving them. Reopen the resolver.',
      );
    }
    if (body.strategy === 'rebase' && !model.strategies.includes('rebase')) {
      return refuse(
        reply,
        409,
        'RebaseNotOffered',
        model.rebaseUnavailableReason ??
          `This branch has ${model.commitsAboveBase} commits. Rebasing can conflict once per commit — merge instead.`,
      );
    }

    if (body.target.kind === 'new_branch') {
      const branchRefusal = await checkNewBranch(reply, model.reservedBranchNames, model.baseRef, body.target.branch);
      if (branchRefusal) return branchRefusal;
    }

    const planRefusal = preflightDecisions(reply, rec, body);
    if (planRefusal) return planRefusal;

    // ⚠ CLAIMED SYNCHRONOUSLY, with no `await` between the check and the write: two clicks a
    // tick apart must not become two pushes.
    const slot = claimCommitSlot(rec);
    if (!slot.ok) return refuseBusy(reply, slot.reason);

    reply.status(202);
    void runCommit(rec, body, slot.signal, req.log);
    return sessionView(rec);
  });

  // ---- 6. Close -------------------------------------------------------------------------
  app.delete('/api/prs/:id/conflicts', { schema: sessionQuerySchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const { session } = req.query as { session: string };
    const accountId = accountIdOf(req);

    const allowed = await requireWritablePr(reply, accountId, id);
    if (!allowed.ok) return allowed.body;

    // 204 whether or not there was anything to drop: "it is not there" is what the caller asked
    // for, and a session that expired on its own is not an error the reader can act on.
    dropSession(accountId, id, session);
    reply.status(204);
    return null;
  });
}

/* ═════════════════════════════ the two jobs ═════════════════════════════ */

/**
 * Build the model behind the 202.
 *
 * ⚠ NEVER REJECTS. It is fired with `void`, so an escaping rejection is an unhandled one — and
 * the session it was building would sit at `preparing` until the TTL, with the overlay reading
 * "Reading the conflicting files…" the whole time.
 */
async function runOpen(rec: ConflictSessionRecord, log: FastifyBaseLogger): Promise<void> {
  try {
    const result = await buildConflictModel({
      accountId: rec.accountId,
      prId: rec.prId,
      // ⚠ THE SAME id the session was opened with, twice over: it namespaces the fetch refs
      // (`refs/pierre/conflict/<sessionId>/…`, never FETCH_HEAD, which is one file per clone
      // and shared across jobs) and it names the two refs the land path's teardown deletes.
      sessionId: rec.sessionId,
      onPhase: (p) => setPreparePhase(rec, p),
    });
    if (!result) {
      // The PR stopped being this account's between the ownership check and here.
      settleFailed(rec, 'objects_unavailable', 'This pull request is no longer available.');
      return;
    }
    switch (result.status) {
      case 'ready':
      case 'clean':
        settleReady(rec, result.model, conflictModelHash(result.model), result.status === 'clean');
        return;
      case 'failed':
        settleFailed(rec, result.code, result.message);
        return;
      case 'moved':
        // Unreachable: the open pins nothing, so the builder has nothing to find moved. Settled
        // rather than ignored, because a session stuck at `preparing` is a spinner forever.
        settleFailed(rec, 'objects_unavailable', 'This pull request moved while it was opening.');
        return;
    }
  } catch (err) {
    log.error({ err, prId: rec.prId }, 'conflict model build failed');
    settleFailed(
      rec,
      'objects_unavailable',
      'Couldn’t work out the conflicts in this pull request.',
    );
  }
}

/** Land the resolution behind the 202. NEVER REJECTS, for the same reason `runOpen` does not. */
async function runCommit(
  rec: ConflictSessionRecord,
  body: ConflictCommitBody,
  signal: AbortSignal,
  log: FastifyBaseLogger,
): Promise<void> {
  const model = rec.model;
  if (!model) {
    settleCommitFailed(rec, 'SessionExpired', SESSION_EXPIRED);
    return;
  }
  try {
    const result = await landConflictResolution({
      accountId: rec.accountId,
      prId: rec.prId,
      sessionId: rec.sessionId,
      model,
      body,
      suggestions: rec.suggestions,
      onPhase: (p) => setCommitPhase(rec, p),
      signal,
      log,
    });
    settleCommitDone(rec, result);
  } catch (err) {
    const code = (err as ConflictLandError | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (isLandErrorCode(code)) {
      settleCommitFailed(rec, code, message);
      return;
    }
    log.error({ err, prId: rec.prId }, 'conflict commit failed');
    settleCommitFailed(rec, 'GitFailed', 'The resolved commit didn’t reach GitHub.');
  }
}

const LAND_ERROR_CODES = new Set<string>([
  'ModelStale',
  'HeadMoved',
  'BaseMoved',
  'SessionExpired',
  'NoConflicts',
  'NotPermitted',
  'NothingToCommit',
  'UnknownFileIndex',
  'IncompleteDecisions',
  'UnknownSuggestion',
  'InvalidBranch',
  'ReservedBranch',
  'BranchExists',
  'PushDenied',
  'RebaseNotOffered',
  'GitFailed',
  'Cancelled',
]);

function isLandErrorCode(code: unknown): code is ConflictLandErrorCode {
  return typeof code === 'string' && LAND_ERROR_CODES.has(code);
}

/* ═════════════════════════════ the cheap pre-flight ═════════════════════════════ */

/**
 * The new-branch name, before the 202.
 *
 * ⚠ THIS IS A PRE-FLIGHT, NOT THE AUTHORITY. `land.ts` validates the name again on its own path
 * — it has to, because it is also reachable with a name this never saw. What this buys is a
 * real status code and the table's own sentence instead of a 202 followed by a failure frame.
 * `assertPushTarget` is the SAME guard the push itself goes through (`coding/git.ts`), so the
 * two cannot disagree about what git accepts.
 */
async function checkNewBranch(
  reply: FastifyReply,
  reserved: readonly string[],
  baseRef: string,
  branch: string | undefined,
): Promise<ErrorBody | null> {
  const wanted = (branch ?? '').trim();
  if (!wanted) {
    return refuse(reply, 400, 'InvalidBranch', 'Give the new branch a name.');
  }
  const lowered = wanted.toLowerCase();
  // Reserved first: these are real, well-formed branch names, so the format check would pass
  // them and the reader would be told the name is malformed when it is merely taken.
  if (reserved.some((r) => r.toLowerCase() === lowered)) {
    const what =
      lowered === baseRef.toLowerCase() ? 'this PR’s base branch' : 'the default branch';
    return refuse(reply, 409, 'ReservedBranch', `${wanted} is ${what}. Pick another name.`);
  }
  try {
    await assertPushTarget(wanted, [...reserved]);
  } catch {
    return refuse(
      reply,
      400,
      'InvalidBranch',
      'Branch names start with a letter or digit and can use letters, digits, . _ / and -.',
    );
  }
  return null;
}

/**
 * The decisions, before the 202: is every file in this model, and is every change decided?
 *
 * ⚠ ALSO A PRE-FLIGHT. `land.ts`'s `planResolution` is the authority and re-runs all of it
 * against the REBUILT model — which is the one that matters, because the base may have moved
 * since. This exists so an incomplete set is a 400 naming the file rather than a 202 followed by
 * a failure frame. Both call the same `allowedDecisions`; neither invents a default, because a
 * silently defaulted region is a line of code nobody chose.
 */
function preflightDecisions(
  reply: FastifyReply,
  rec: ConflictSessionRecord,
  body: ConflictCommitBody,
): ErrorBody | null {
  const model = rec.model;
  if (!model) return refuse(reply, 409, 'SessionExpired', SESSION_EXPIRED);
  const byIndex = new Map(model.files.map((f) => [f.index, f]));
  const seen = new Set<number>();

  for (const req of body.files) {
    const file = byIndex.get(req.index);
    if (!file || seen.has(req.index)) {
      return refuse(
        reply,
        400,
        'UnknownFileIndex',
        'That file isn’t part of this session. Reopen the resolver.',
      );
    }
    seen.add(req.index);

    const decided = new Set<number>();
    for (const d of req.decisions) {
      decided.add(d.id);
      if (d.decision !== 'suggestion') continue;
      if (d.suggestionId == null || !rec.suggestions.has(d.suggestionId)) {
        return refuse(
          reply,
          400,
          'UnknownSuggestion',
          'That suggestion has expired. Ask Claude again.',
        );
      }
    }
    // Rule 2 of the fold: EXHAUSTIVE over the file's non-`unchanged` regions. A one-sided change
    // is decidable too — leaving it out is not "keep the default", it is nobody choosing.
    const missing = file.regions.filter(
      (r) => r.kind !== 'unchanged' && !decided.has(r.id),
    ).length;
    if (missing > 0) {
      return refuse(
        reply,
        400,
        'IncompleteDecisions',
        `${file.path} still has ${missing} conflict${missing === 1 ? '' : 's'} to decide.`,
      );
    }
  }
  return null;
}
