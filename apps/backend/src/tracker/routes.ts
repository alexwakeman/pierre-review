import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  TRACKER_PROVIDERS_AVAILABLE,
  type JiraAcFieldBody,
  type JiraFieldListResponse,
  type JiraTicketDetails,
  type JiraTicketRefreshBody,
  type LinearConnectionCheck,
  type WorkspaceTrackerSettings,
  type WorkspaceTrackerUpdate,
} from '@pierre-review/shared';
import { githubAccessFor, ownedWorkspaceId, type TrackerContext } from './context.js';
import { detectPrTickets } from './enricher.js';
import { maybeAdapterFor } from './registry.js';
import {
  readWorkspaceTracker,
  readWorkspaceTrackerAccess,
  readWorkspaceTrackerRow,
  trackerPatchError,
  writeWorkspaceTracker,
} from './settings.js';
import { MSG_NO_READING_TRACKER, prepareTrackerCall } from './calls.js';
import { ownedPr } from './stories.js';
import type { JiraTransport } from './jira/fetch.js';
import { fetchJiraFields, isJiraFieldId, jiraErrorMessage } from './jira/client.js';
import { fetchLinearViewer } from './linear/client.js';
import { linearSiteRoot } from '@pierre-review/shared';
import { JiraFetchError } from './jira/fetch.js';
import {
  hasContent,
  markDue,
  parseCandidates,
  readStoredTickets,
  rederiveAcForIssueType,
  toDetails,
  writeAcFieldSetting,
  type StoredTicketRow,
} from './store.js';
import { accessFingerprint, backoffCode, kickTrackerSync, syncOnePrNow } from './worker.js';
import { registerTicketLinksRoute } from './links.js';
import { registerTicketMergedPrsRoute } from './merged.js';

// THE TRACKER'S HTTP SURFACE — CORE and FREE, both modes (the plugin's `/api/pro/*` Jira routes until
// apiVersion 23). Every route that can spend the customer's tracker quota sits on the `search`
// rate-limit tier in `tierFor` (api/plugins/rate-limit.ts), spelled by exact path.
//
//   GET  /api/workspaces/:id/tracker                  this workspace's tracker (404 if not yours).
//   PUT  /api/workspaces/:id/tracker                  a partial patch; a changed tracker or token
//                                                     kicks the worker for the account.
//   GET  /api/workspaces/:id/tracker/jira-fields      the Settings CONNECTION CHECK (lists the
//                                                     site's custom fields with the SAVED token).
//   GET  /api/workspaces/:id/tracker/linear-check     the Linear CONNECTION CHECK (one call with the
//                                                     SAVED key: who it is, and which Linear workspace).
//   GET  /api/prs/:id/tracker-ticket?key=<KEY>        one detected ticket's STORED row: title,
//                                                     description, issue type, status, assignee, the
//                                                     criteria the server picked and every candidate
//                                                     text field. NO tracker call when the worker has
//                                                     read it; a ticket it never reached is read
//                                                     ONCE, through the worker's own path, and stored.
//   POST /api/prs/:id/tracker-ticket/refresh          { key } — read it again NOW (backoff bypassed).
//   PUT  /api/prs/:id/tracker-ticket/ac-field         { key, fieldId|null } — the criteria field for
//                                                     this ticket's ISSUE TYPE in the PR's workspace.
//   POST /api/ticket-links                            ./links.ts — the Open PRs ticket row.
//   GET  /api/ticket-merged-prs                       ./merged.ts — the stacks' "Merged (n)" panel.
//
// ⚠ LIMN IS NOT A TRACKER PROXY. The ticket routes address a PULL REQUEST (ownership-scoped → 404),
// resolve that PR's workspace exactly as the enricher does, RE-RUN detection on it and answer only
// for a key detection found. A key typed into the URL that the PR does not carry is refused, so the
// saved token can read the tickets this workspace's PRs name and nothing else.
//
// ⚠ EVERY TRACKER FAILURE IS A 502 WITH A SENTENCE WE WROTE — never the tracker's body, never the
// URL with a token in it, never the header. The log line carries account + workspace + the error
// CODE only.

const MSG_NOT_JIRA = 'This workspace does not use Jira. Set Jira as the issue tracker in Settings.';

function jiraFailed(
  ctx: TrackerContext,
  reply: FastifyReply,
  err: unknown,
  where: { accountId: number; workspaceId: number; route: string },
  // The provider whose words the sentence uses (its adapter's `errorMessage`); Jira by default.
  provider: string | null = 'jira',
): FastifyReply {
  const code = err instanceof Error && 'code' in err ? (err as { code: unknown }).code : 'unknown';
  // ⚠ NOT `{ err }`: never serialise the error object on this path (defence in depth — nothing on
  // it carries the header today, and a log is not where to find out it started to).
  ctx.log.warn({ ...where, code }, 'tracker request failed');
  const message = maybeAdapterFor(provider)?.reader?.errorMessage(err) ?? jiraErrorMessage(err);
  return reply.code(502).send({ error: 'JiraError', code, message });
}

// A ticket key in a request: Jira/Linear `PROJ-123`, or a GitHub issue `owner/repo#12`.
const KEY_MAX_CHARS = 160;

const wsIdParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const notFound = (reply: FastifyReply, id: number): FastifyReply =>
  reply.code(404).send({ error: 'NotFound', message: `Workspace ${id} not found` });

// The PUT body. ⚠ EVERY KEY MUST BE LISTED: ajv runs with `removeAdditional` and this schema is
// `additionalProperties: false`, so an unlisted property is SILENTLY STRIPPED and the PUT still
// answers 200 — on `token` that would read as "saved" while nothing was stored.
const trackerBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issue: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Only the providers an adapter implements (shared `TRACKER_PROVIDERS_AVAILABLE`).
        provider: { type: ['string', 'null'], enum: [...TRACKER_PROVIDERS_AVAILABLE, null] },
        baseUrl: { type: ['string', 'null'], maxLength: 2048 },
        // Optional project-key allowlist. The store normalises/caps; [] or null clears it.
        projectKeys: { type: ['array', 'null'], items: { type: 'string', maxLength: 20 }, maxItems: 50 },
        matchScope: { type: 'string', enum: ['title', 'title_branch'] },
      },
    },
    jira: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // '' or null clears. No whitespace, and no ':' — a colon in the user half of HTTP Basic
        // would split the credential in the wrong place.
        email: { type: ['string', 'null'], maxLength: 320, pattern: '^$|^[^\\s:@]+@[^\\s:@]+$' },
        // WRITE-ONLY. Never echoed: the response carries `jira.hasToken` only.
        token: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S+$' },
        clearToken: { type: 'boolean' },
      },
    },
  },
} as const;

export function registerTrackerRoutes(
  app: FastifyInstance,
  ctx: TrackerContext,
  opts: { transport?: JiraTransport } = {},
): void {
  // ---- the workspace's tracker (settings) ----
  // `:id` is a PATH id, so ownership → 404 like every `/api/workspaces/:id/*` route. Tenancy is
  // ALSO structural: the named composite FK on `workspace_trackers` makes a cross-account
  // (workspace, account) pair fail in the database.
  app.get<{ Params: { id: number } }>(
    '/api/workspaces/:id/tracker',
    { schema: { params: wsIdParam } },
    async (req, reply): Promise<WorkspaceTrackerSettings | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (ws == null) return notFound(reply, req.params.id);
      return readWorkspaceTracker(ctx, accountId, ws);
    },
  );

  app.put<{ Params: { id: number }; Body: WorkspaceTrackerUpdate }>(
    '/api/workspaces/:id/tracker',
    { schema: { params: wsIdParam, body: trackerBodySchema } },
    async (req, reply): Promise<WorkspaceTrackerSettings | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const ws = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (ws == null) return notFound(reply, req.params.id);
      const body = req.body ?? {};
      const refused = trackerPatchError(await readWorkspaceTrackerRow(ctx, accountId, ws), body);
      if (refused != null) return reply.code(400).send({ error: 'InvalidTrackerToken', message: refused });
      const saved = await writeWorkspaceTracker(ctx, accountId, ws, body);
      // A changed tracker or token: read this account's tickets with it now, not at the next tick
      // (fire-and-forget; a no-op while the worker is off).
      if ('issue' in body || 'jira' in body) void kickTrackerSync(ctx, accountId);
      return saved;
    },
  );

  // The Settings CONNECTION CHECK — one call to the tracker with the SAVED token.
  app.get<{ Params: { id: number } }>(
    '/api/workspaces/:id/tracker/jira-fields',
    { schema: { params: wsIdParam } },
    async (req, reply): Promise<JiraFieldListResponse | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (workspaceId == null) return notFound(reply, req.params.id);
      const access = await readWorkspaceTrackerAccess(ctx, accountId, workspaceId);
      if (access.issue.provider !== 'jira') {
        return reply.code(400).send({ error: 'NotJira', message: MSG_NOT_JIRA });
      }
      const prepared = prepareTrackerCall(access, { cloud: ctx.host.isCloud, transport: opts.transport });
      if (!prepared.ok) return reply.code(prepared.status).send({ error: prepared.error, message: prepared.message });
      try {
        const fields = await fetchJiraFields(prepared.call);
        return { workspaceId, fields };
      } catch (err) {
        return jiraFailed(ctx, reply, err, { accountId, workspaceId, route: 'fields' });
      }
    },
  );

  // The Linear CONNECTION CHECK — one call (`viewer` + `organization`) with the SAVED key. It answers
  // which Linear workspace the key belongs to, so Settings can say when that is not the URL saved
  // above it (the reader refuses such a pair: every ticket would be keyed on the wrong workspace).
  app.get<{ Params: { id: number } }>(
    '/api/workspaces/:id/tracker/linear-check',
    { schema: { params: wsIdParam } },
    async (req, reply): Promise<LinearConnectionCheck | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await ownedWorkspaceId(ctx, accountId, req.params.id);
      if (workspaceId == null) return notFound(reply, req.params.id);
      const access = await readWorkspaceTrackerAccess(ctx, accountId, workspaceId);
      if (access.issue.provider !== 'linear') {
        return reply.code(400).send({
          error: 'NotLinear',
          message: 'This workspace does not use Linear. Set Linear as the issue tracker in Settings.',
        });
      }
      const prepared = prepareTrackerCall(access, { cloud: ctx.host.isCloud, transport: opts.transport });
      if (!prepared.ok) return reply.code(prepared.status).send({ error: prepared.error, message: prepared.message });
      try {
        const v = await fetchLinearViewer(prepared.call);
        return {
          workspaceId,
          viewerName: v.viewerName,
          organizationName: v.organizationName,
          organizationUrl: v.organizationUrl,
          matchesBaseUrl: linearSiteRoot(access.issue.baseUrl) === v.organizationUrl,
        };
      } catch (err) {
        return jiraFailed(ctx, reply, err, { accountId, workspaceId, route: 'linear-check' }, 'linear');
      }
    },
  );

  registerTicketLinksRoute(app, ctx, opts);
  registerTicketMergedPrsRoute(app, ctx);

  const idParams = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer', minimum: 1 } },
  } as const;

  app.get<{ Params: { id: number }; Querystring: { key: string } }>(
    '/api/prs/:id/tracker-ticket',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', minLength: 3, maxLength: KEY_MAX_CHARS } },
        },
      },
    },
    async (req, reply): Promise<JiraTicketDetails | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const gate = await detectedTicketGate(ctx, reply, accountId, req.params.id, req.query.key, opts.transport);
      if (gate.reply) return gate.reply;
      let row = await storedRow(ctx, accountId, gate.prId, gate.key, gate.apiRoot);
      if (row == null) {
        // Never reached by the worker (a PR synced before it ran): read it once, the worker's way.
        await syncOnePrNow(ctx, accountId, gate.prId, [gate.key], { force: false, transport: opts.transport });
        row = await storedRow(ctx, accountId, gate.prId, gate.key, gate.apiRoot);
      }
      return answerRow(ctx, reply, accountId, gate, row);
    },
  );

  app.post<{ Params: { id: number }; Body: JiraTicketRefreshBody }>(
    '/api/prs/:id/tracker-ticket/refresh',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['key'],
          additionalProperties: false,
          properties: { key: { type: 'string', minLength: 3, maxLength: KEY_MAX_CHARS } },
        },
      },
    },
    async (req, reply): Promise<JiraTicketDetails | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const gate = await detectedTicketGate(ctx, reply, accountId, req.params.id, req.body.key, opts.transport);
      if (gate.reply) return gate.reply;
      await syncOnePrNow(ctx, accountId, gate.prId, [gate.key], { force: true, transport: opts.transport });
      const row = await storedRow(ctx, accountId, gate.prId, gate.key, gate.apiRoot);
      return answerRow(ctx, reply, accountId, gate, row);
    },
  );

  app.put<{ Params: { id: number }; Body: JiraAcFieldBody }>(
    '/api/prs/:id/tracker-ticket/ac-field',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['key', 'fieldId'],
          additionalProperties: false,
          properties: {
            key: { type: 'string', minLength: 3, maxLength: KEY_MAX_CHARS },
            fieldId: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (req, reply): Promise<JiraTicketDetails | FastifyReply> => {
      const accountId = ctx.accountIdOf(req);
      const gate = await detectedTicketGate(ctx, reply, accountId, req.params.id, req.body.key, opts.transport);
      if (gate.reply) return gate.reply;
      const row = await storedRow(ctx, accountId, gate.prId, gate.key, gate.apiRoot);
      if (row == null || !hasContent(row) || row.issueTypeId == null) {
        return reply.code(409).send({
          error: 'TicketNotRead',
          message: `Limn has not read ${gate.key} from the tracker yet. Refresh it first.`,
        });
      }
      const fieldId = req.body.fieldId;
      let field: { id: string; name: string } | null = null;
      if (fieldId != null) {
        // The picker offers this ticket's own text fields; anything else is refused.
        const c = isJiraFieldId(fieldId) ? parseCandidates(row.candidatesJson).find((x) => x.id === fieldId) : undefined;
        if (c == null) {
          return reply.code(400).send({
            error: 'UnknownField',
            message: `${gate.key} has no field ${fieldId} with text.`,
          });
        }
        field = { id: c.id, name: c.name };
      }
      await writeAcFieldSetting(ctx, accountId, gate.workspaceId, gate.apiRoot, row.issueTypeId, field, new Date());
      // Every stored ticket of this type picks the new field at once (no Jira call), and is due for
      // a fresh read; this one is read again now.
      const touched = await rederiveAcForIssueType(
        ctx,
        accountId,
        gate.workspaceId,
        gate.apiRoot,
        row.issueTypeId,
        field?.id ?? null,
      );
      await markDue(ctx, accountId, touched.filter((id) => id !== row.id));
      await syncOnePrNow(ctx, accountId, gate.prId, [gate.key], { force: true, transport: opts.transport });
      return answerRow(ctx, reply, accountId, gate, await storedRow(ctx, accountId, gate.prId, gate.key, gate.apiRoot));
    },
  );
}

type Gate =
  | { reply: FastifyReply; prId: number; key: string; workspaceId: number; apiRoot: string; fp: string; provider: string | null }
  | { reply: null; prId: number; key: string; workspaceId: number; apiRoot: string; fp: string; provider: string | null };

/**
 * ⚠ THE NOT-A-PROXY GATE, shared by the three ticket routes: the PR must be this account's, its
 * workspace must use Jira with a usable token, and the key must be one detection found on it.
 */
async function detectedTicketGate(
  ctx: TrackerContext,
  reply: FastifyReply,
  accountId: number,
  prId: number,
  rawKey: string,
  transport: JiraTransport | undefined,
): Promise<Gate> {
  let key = rawKey.trim();
  const fail = (r: FastifyReply): Gate => ({ reply: r, prId, key, workspaceId: 0, apiRoot: '', fp: '', provider: null });
  const pr = await ownedPr(ctx, accountId, prId);
  if (pr == null) return fail(reply.code(404).send({ error: 'NotFound', message: `PR ${prId} not found` }));
  const found = await detectPrTickets(ctx, accountId, pr);
  const adapter = maybeAdapterFor(found?.access.issue.provider);
  if (found == null || adapter?.reader == null) {
    return fail(reply.code(400).send({ error: 'NotJira', message: MSG_NO_READING_TRACKER }));
  }
  key = adapter.normalizeKey(key) ?? key.toUpperCase();
  if (!found.keys.includes(key)) {
    return fail(
      reply.code(400).send({
        error: 'TicketNotDetected',
        message: `${key} is not a ticket Limn found on this pull request.`,
      }),
    );
  }
  const prepared = prepareTrackerCall(found.access, {
    cloud: ctx.host.isCloud,
    transport,
    github: githubAccessFor(ctx, accountId),
  });
  if (!prepared.ok) return fail(reply.code(prepared.status).send({ error: prepared.error, message: prepared.message }));
  return {
    reply: null,
    prId,
    key,
    workspaceId: found.workspaceId,
    apiRoot: prepared.call.apiRoot,
    fp: accessFingerprint(prepared.call),
    provider: prepared.call.provider,
  };
}

async function storedRow(
  ctx: TrackerContext,
  accountId: number,
  prId: number,
  key: string,
  apiRoot: string,
): Promise<StoredTicketRow | null> {
  const rows = await readStoredTickets(ctx, accountId, [prId]);
  return rows.find((r) => r.issueKey === key && r.apiRoot === apiRoot) ?? null;
}

/** A stored row → the ticket, or the refusal it remembers as a 502 with our own sentence. */
function answerRow(
  ctx: TrackerContext,
  reply: FastifyReply,
  accountId: number,
  gate: Gate,
  row: StoredTicketRow | null,
): JiraTicketDetails | FastifyReply {
  if (row != null && hasContent(row)) return toDetails(gate.prId, row);
  // Nothing readable: the remembered refusal, or the error that put the workspace in backoff (no
  // row is written for a workspace-wide refusal).
  const code = (row?.errorCode ??
    backoffCode(accountId, gate.workspaceId, gate.fp, Date.now()) ??
    'network') as ConstructorParameters<typeof JiraFetchError>[0];
  return jiraFailed(
    ctx,
    reply,
    new JiraFetchError(code),
    { accountId, workspaceId: gate.workspaceId, route: 'ticket' },
    gate.provider,
  );
}
