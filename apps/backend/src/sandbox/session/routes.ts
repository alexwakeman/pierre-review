// THE SESSION ROUTES (docs/SANDBOX.md § Sessions; contracts in docs/API.md § Implement story — workspace
// sessions). Registered ONLY from review/agentic.ts `registerAgenticRoutes`, so nothing answers when AI
// is off. Start, read, stream and discard live on the shared `STORY_BUILD_API` paths; the push and diff
// routes are coding/story-build/routes-build.ts, since a session stores its patch where Push reads it.
//
// TENANCY: `?workspace=` / `workspaceId` resolve through `resolveWorkspaceScope` (absent / unknown /
// another account's ⇒ this account's Default, echoed); a session id is read through the account-scoped
// getter (another account's ⇒ 404). Every path has a rate-limit tier (api/plugins/rate-limit.ts).
//
// ⚠ The stream is a GET, so its request's close IS the client going away (a POST's fires early).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BUILD_PLAN_API,
  BUILD_PLAN_LIMITS,
  DEFAULT_CLAUDE_REVIEW_MODEL,
  SANDBOX_MESSAGE_MAX,
  SANDBOX_SESSION_API,
  STORY_BUILD_API,
  TICKET_IDENT_MAX_CHARS,
  parseTicketIdent,
  type BuildPlanApproveBody,
  type BuildPlanDecisionBody,
  type BuildPlanErrorCode,
  type BuildPlanReplyBody,
  type BuildPlanRevisionResponse,
  type BuildPlanView,
  type SandboxNetworkAllowBody,
  type SandboxNetworkAllowResponse,
  type SandboxSessionActionResponse,
  type SandboxSessionBuildBody,
  type SandboxSessionDiffResponse,
  type SandboxSessionErrorCode,
  type SandboxSessionMessageBody,
  type SandboxSessionStartBody,
  type SandboxSessionStreamEvent,
  type StoryBuild,
  type StoryBuildDiscardResponse,
  type StoryBuildErrorCode,
  type StoryBuildForTicketResponse,
  type StoryBuildStartResponse,
} from '@pierre-review/shared';
import { preflightFor, resolveManualRunChoice } from '../../ai/run-choice.js';
import { getStoryBuildRow, listStoryBuildRepoRows, listStoryBuildRowsFor, storyBuildRepoNames, toStoryBuildSummary } from '../../coding/story-build/persist.js';
import { registerStoryBuildBuildRoutes } from '../../coding/story-build/routes-build.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import type { AgentContext } from '../../review/agent-context.js';
import { AGENTIC_AI_ENABLED } from '../../review/claude-review/manager.js';
import { resolveSandboxAgentChoice } from '../drivers/index.js';
import {
  allowSessionHost,
  approveSessionPlan,
  decideSessionPlan,
  replySessionPlan,
  sessionPlanRevision,
  discardSession,
  interruptSession,
  resumeSession,
  sendSessionMessage,
  sessionDocsAvailable,
  sessionStoryInputs,
  sessionWire,
  startSession,
  startSessionBuild,
  subscribeSession,
  type ResumeResult,
  type SessionActionResult,
} from './manager.js';

type ErrorCode = StoryBuildErrorCode | SandboxSessionErrorCode | BuildPlanErrorCode;
type ErrorBody = { error: ErrorCode; message: string };

const fail = (reply: FastifyReply, status: number, error: ErrorCode, message: string): ErrorBody => {
  reply.status(status);
  return { error, message };
};

const featureOff = (reply: FastifyReply): ErrorBody => fail(reply, 404, 'NotFound', 'Implementing a story runs on your machine: npx limn-review');
const notFound = (reply: FastifyReply): ErrorBody => fail(reply, 404, 'NotFound', 'Not found.');

const isTrackerIdent = (ident: string): boolean => {
  const p = parseTicketIdent(ident);
  return p != null;
};

const parseId = (raw: string | undefined): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const idParams = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]{1,12}$' } } } };
const idOf = (req: FastifyRequest): number | null => parseId((req.params as { id: string }).id);

/** One action's answer: 202 `{ buildId }`, or the refusal it maps to. */
function sendAction(reply: FastifyReply, r: SessionActionResult | ResumeResult): SandboxSessionActionResponse | ErrorBody {
  switch (r.status) {
    case 'queued':
      reply.status(202);
      return { buildId: r.id };
    case 'not_found':
      return notFound(reply);
    case 'not_live':
      return fail(reply, 409, 'NotLive', r.message);
    case 'agent_busy':
      return fail(reply, 409, 'AgentBusy', 'The agent is still working on the last message. Wait, or press Stop.');
    case 'build_busy':
      return fail(reply, 409, 'BuildBusy', 'Another session is building. One build runs at a time.');
    case 'not_ready':
      return fail(reply, 409, 'NotReady', r.message);
    case 'no_runtime':
      return fail(reply, 409, 'NoRuntime', r.message);
    case 'too_many':
      return fail(reply, 409, 'TooManySessions', r.message);
    case 'not_resumable':
      return fail(reply, 409, 'NotResumable', r.message);
    case 'rejected':
      return fail(reply, r.code === 'NotFound' ? 404 : 409, r.code as ErrorCode, r.message);
  }
}

export function registerSandboxSessionRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // ---- GET the ticket's latest session + the earlier ones ----
  app.get(
    STORY_BUILD_API.list,
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['ident'],
          properties: { ident: { type: 'string', minLength: 1, maxLength: TICKET_IDENT_MAX_CHARS }, workspace: { type: 'string' } },
        },
      },
    },
    async (req, reply): Promise<StoryBuildForTicketResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const { ident, workspace } = req.query as { ident: string; workspace?: string };
      if (!isTrackerIdent(ident)) return fail(reply, 400, 'BadRequest', 'Not a tracker ticket.');
      const accountId = ctx.accountIdOf(req);
      const { workspaceId } = await resolveWorkspaceScope(accountId, workspace ?? null);
      const [latest, ...earlier] = await listStoryBuildRowsFor(ctx, accountId, workspaceId, ident, 20);
      return { workspaceId, build: latest != null ? await sessionWire(ctx, accountId, latest) : null, earlier: earlier.map(toStoryBuildSummary) };
    },
  );

  // ---- GET one session ----
  app.get(STORY_BUILD_API.one, { schema: idParams }, async (req, reply): Promise<StoryBuild | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = idOf(req);
    const accountId = ctx.accountIdOf(req);
    const row = id == null ? null : await getStoryBuildRow(ctx, accountId, id);
    if (row == null) return notFound(reply);
    return sessionWire(ctx, accountId, row);
  });

  // ---- SSE: one snapshot, then every change while the sandbox runs; `done` when it closes ----
  app.get(STORY_BUILD_API.stream, { schema: idParams }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = idOf(req);
    const accountId = ctx.accountIdOf(req);
    // Ownership BEFORE hijack (a 404 cannot be sent after).
    const row = id == null ? null : await getStoryBuildRow(ctx, accountId, id);
    if (row == null || id == null) return notFound(reply);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false;
    let unsub: (() => void) | null = null;
    const hb = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15_000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      unsub?.();
      if (!raw.writableEnded) raw.end();
    };
    const send = (e: SandboxSessionStreamEvent): void => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    req.raw.on('close', cleanup);
    // Subscribe BEFORE the snapshot, buffering, so a frame between the two is never lost.
    const held: SandboxSessionStreamEvent[] = [];
    let ready = false;
    unsub = subscribeSession(id, accountId, (e) => {
      if (!ready) return void held.push(e);
      send(e);
      if (e.type === 'done') cleanup();
    });
    const wire = await sessionWire(ctx, accountId, row).catch(() => null);
    if (wire?.session) send({ type: 'snapshot', session: wire.session });
    ready = true;
    for (const e of held) {
      send(e);
      if (e.type === 'done') return cleanup();
    }
    if (unsub == null) {
      send({ type: 'done' });
      cleanup();
    }
  });

  // ---- POST start: claim the row, boot the sandbox in the background ----
  app.post(
    STORY_BUILD_API.list,
    {
      schema: {
        body: {
          type: 'object',
          required: ['ident'],
          additionalProperties: false,
          properties: {
            // Any value: a non-integer falls back to Default through resolveWorkspaceScope, never a 400.
            workspaceId: {},
            ident: { type: 'string', minLength: 1, maxLength: TICKET_IDENT_MAX_CHARS },
            action: { type: 'string', enum: ['implement', 'fill_gaps'] },
            provider: { type: 'string', maxLength: 20 },
            model: { type: 'string', maxLength: 80 },
            // The old start's diagram switch, accepted and ignored.
            diagram: { type: 'boolean' },
            // "Implement with docs": a read-only copy of part of the reference library goes into the sandbox.
            docs: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply): Promise<StoryBuildStartResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const body = req.body as SandboxSessionStartBody;
      if (!isTrackerIdent(body.ident)) return fail(reply, 400, 'BadRequest', 'Not a tracker ticket.');
      const accountId = ctx.accountIdOf(req);
      const rawWs: unknown = body.workspaceId;
      const scope = await resolveWorkspaceScope(accountId, typeof rawWs === 'number' || typeof rawWs === 'string' ? rawWs : null);
      // A MANUAL run with a model menu (the reader's pick, validated); the default depth is deep.
      const picked = resolveManualRunChoice({ provider: body.provider, model: body.model }, 'story_build', {
        defaultModel: DEFAULT_CLAUDE_REVIEW_MODEL,
        detect: preflightFor(ctx),
      });
      if (!picked.ok) {
        const code: StoryBuildErrorCode = picked.error === 'ModelNotOnProvider' || picked.error === 'NoClaudeAuth' ? picked.error : 'BadRequest';
        return fail(reply, 400, code, picked.message);
      }
      // The cheap DB check first (the fresh tracker read happens in the boot): no story ⇒ no sandbox.
      const inputs = await sessionStoryInputs(ctx, accountId, scope.workspaceId, body.ident);
      if (inputs == null || inputs.empty) return fail(reply, 400, 'NoStory', 'This ticket has no story or criteria to build from.');
      if (body.docs === true && !(await sessionDocsAvailable(accountId, scope.workspaceId))) {
        return fail(reply, 400, 'NoDocs', 'No reference documents are built for this workspace.');
      }
      const r = await startSession(ctx, {
        accountId,
        workspaceId: scope.workspaceId,
        memberRepoIds: scope.repoIds,
        ident: body.ident,
        ticketKey: inputs.ticketKey,
        ticketTitle: inputs.title,
        action: body.action === 'fill_gaps' ? 'fill_gaps' : 'implement',
        docs: body.docs === true,
        choice: resolveSandboxAgentChoice({ provider: picked.provider, model: picked.model }),
      });
      if (r.outcome === 'no_runtime') return fail(reply, 409, 'NoRuntime', r.message);
      if (r.outcome === 'too_many') return fail(reply, 409, 'TooManySessions', r.message);
      reply.status(r.outcome === 'started' ? 202 : 200);
      return { outcome: r.outcome, buildId: r.id };
    },
  );

  // ---- POST a message: one chat turn (or, after Start build, one build turn) ----
  app.post(
    SANDBOX_SESSION_API.messages,
    { schema: { ...idParams, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } } } },
    async (req, reply) => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = idOf(req);
      if (id == null) return notFound(reply);
      const text = (req.body as SandboxSessionMessageBody).text.trim();
      if (text === '') return fail(reply, 400, 'BadRequest', 'Write a message first.');
      if (text.length > SANDBOX_MESSAGE_MAX) return fail(reply, 400, 'BadRequest', `Keep the message under ${SANDBOX_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
      return sendAction(reply, await sendSessionMessage(ctx, ctx.accountIdOf(req), id, text));
    },
  );

  // ---- POST Stop ----
  app.post(SANDBOX_SESSION_API.interrupt, { schema: idParams }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = idOf(req);
    if (id == null) return notFound(reply);
    const r = await interruptSession(ctx, ctx.accountIdOf(req), id);
    if (r.status === 'stopping' || r.status === 'idle') return { status: r.status };
    return sendAction(reply, r);
  });

  // ---- POST Start build ----
  app.post(
    SANDBOX_SESSION_API.build,
    { schema: idParams },
    async (req, reply) => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = idOf(req);
      if (id == null) return notFound(reply);
      // The body is optional (`{}` or none); `text`, when sent, must be a string.
      const body = req.body as SandboxSessionBuildBody | null | undefined;
      if (body != null && (typeof body !== 'object' || (body.text !== undefined && typeof body.text !== 'string'))) {
        return fail(reply, 400, 'BadRequest', '`text` must be a string.');
      }
      const extra = (body?.text ?? '').trim();
      if (extra.length > SANDBOX_MESSAGE_MAX) return fail(reply, 400, 'BadRequest', `Keep the message under ${SANDBOX_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
      return sendAction(reply, await startSessionBuild(ctx, ctx.accountIdOf(req), id, extra === '' ? null : extra));
    },
  );

  // ---- POST an Allow click (the reader's, never automatic) ----
  app.post(
    SANDBOX_SESSION_API.networkAllow,
    {
      schema: {
        ...idParams,
        body: {
          type: 'object',
          required: ['rule', 'scope'],
          additionalProperties: false,
          properties: { rule: { type: 'string', minLength: 1, maxLength: 260 }, scope: { type: 'string', enum: ['session', 'workspace'] } },
        },
      },
    },
    async (req, reply) => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = idOf(req);
      if (id == null) return notFound(reply);
      const body = req.body as SandboxNetworkAllowBody;
      const r = await allowSessionHost(ctx, ctx.accountIdOf(req), id, body.rule, body.scope);
      if (r.status === 'allowed') {
        const out: SandboxNetworkAllowResponse = { rule: r.rule, scope: body.scope };
        return out;
      }
      if (r.status === 'refused') return fail(reply, 400, 'NetworkRule', r.reason);
      return sendAction(reply, r);
    },
  );

  // ---- GET every repository's stored patch ----
  app.get(SANDBOX_SESSION_API.diff, { schema: idParams }, async (req, reply): Promise<SandboxSessionDiffResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = idOf(req);
    const accountId = ctx.accountIdOf(req);
    const row = id == null ? null : await getStoryBuildRow(ctx, accountId, id);
    if (row == null || id == null) return notFound(reply);
    const repos = await listStoryBuildRepoRows(ctx, accountId, id);
    const names = await storyBuildRepoNames(ctx, accountId, repos.map((r) => r.repoId));
    return {
      repos: repos
        .filter((r) => (r.patch ?? '') !== '')
        .map((r) => ({
          repoId: r.repoId,
          fullName: names.get(r.repoId) ?? `#${r.repoId}`,
          baseSha: r.baseSha,
          patch: r.patch ?? null,
          filesChanged: r.filesChangedJson ?? [],
          insertions: r.statJson?.insertions ?? null,
          deletions: r.statJson?.deletions ?? null,
        })),
    };
  });

  // ---- POST resume: boot a closed session again from its stored patches ----
  app.post(SANDBOX_SESSION_API.resume, { schema: idParams }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = idOf(req);
    if (id == null) return notFound(reply);
    return sendAction(reply, await resumeSession(ctx, ctx.accountIdOf(req), id));
  });

  // ---- POST discard: tear everything down (any state, except while a push runs) ----
  app.post(STORY_BUILD_API.discard, { schema: idParams }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = idOf(req);
    if (id == null) return notFound(reply);
    const res = await discardSession(ctx, ctx.accountIdOf(req), id);
    if (res.status === 'not_found') return notFound(reply);
    if (res.status === 'not_ready') return fail(reply, 409, 'NotReady', 'Wait for the push to finish.');
    const out: StoryBuildDiscardResponse = { status: res.status };
    return out;
  });

  // ---- PLAN FIRST (docs/STORY-BUILD.md § Plan first) ----

  // GET one stored revision (the history list).
  app.get(
    BUILD_PLAN_API.plan,
    { schema: { ...idParams, querystring: { type: 'object', required: ['revision'], properties: { revision: { type: 'string', pattern: '^[0-9]{1,4}$' } } } } },
    async (req, reply): Promise<BuildPlanRevisionResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = idOf(req);
      if (id == null) return notFound(reply);
      const got = await sessionPlanRevision(ctx, ctx.accountIdOf(req), id, Number((req.query as { revision: string }).revision));
      return got ?? notFound(reply);
    },
  );

  // POST Agree / Keep the story / clear: DB only, no turn.
  app.post(
    BUILD_PLAN_API.decisions,
    {
      schema: {
        ...idParams,
        body: {
          type: 'object',
          required: ['revision', 'contentionId', 'decision'],
          additionalProperties: false,
          properties: {
            revision: { type: 'integer', minimum: 1 },
            contentionId: { type: 'string', pattern: '^C[1-9][0-9]?$' },
            decision: { type: ['string', 'null'], enum: ['agree', 'keep_story', null] },
          },
        },
      },
    },
    async (req, reply): Promise<BuildPlanView | ErrorBody | SandboxSessionActionResponse> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = idOf(req);
      if (id == null) return notFound(reply);
      const r = await decideSessionPlan(ctx, ctx.accountIdOf(req), id, req.body as BuildPlanDecisionBody);
      if (r.status === 'plan') return r.plan;
      return sendAction(reply, r);
    },
  );

  // POST Reply: a revision turn.
  app.post(
    BUILD_PLAN_API.reply,
    {
      schema: {
        ...idParams,
        body: {
          type: 'object',
          required: ['revision', 'contentionId', 'text'],
          additionalProperties: false,
          properties: {
            revision: { type: 'integer', minimum: 1 },
            contentionId: { type: ['string', 'null'], pattern: '^C[1-9][0-9]?$' },
            text: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = idOf(req);
      if (id == null) return notFound(reply);
      const body = req.body as BuildPlanReplyBody;
      const text = body.text.trim();
      if (text === '') return fail(reply, 400, 'BadRequest', 'Write a reply first.');
      if (text.length > BUILD_PLAN_LIMITS.reply) return fail(reply, 400, 'BadRequest', `Keep the reply under ${BUILD_PLAN_LIMITS.reply.toLocaleString('en-US')} characters.`);
      return sendAction(reply, await replySessionPlan(ctx, ctx.accountIdOf(req), id, { revision: body.revision, contentionId: body.contentionId, text }));
    },
  );

  // POST Approve and start: the build turn (the ONE build slot).
  app.post(
    BUILD_PLAN_API.approve,
    {
      schema: {
        ...idParams,
        body: { type: 'object', required: ['revision'], additionalProperties: false, properties: { revision: { type: 'integer', minimum: 1 }, text: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = idOf(req);
      if (id == null) return notFound(reply);
      const body = req.body as BuildPlanApproveBody;
      const extra = (body.text ?? '').trim();
      if (extra.length > SANDBOX_MESSAGE_MAX) return fail(reply, 400, 'BadRequest', `Keep the message under ${SANDBOX_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
      return sendAction(reply, await approveSessionPlan(ctx, ctx.accountIdOf(req), id, { revision: body.revision, text: extra === '' ? null : extra }));
    },
  );

  // The push + per-repository diff routes (coding/story-build/routes-build.ts): a session stores its
  // patches exactly where Push reads them.
  registerStoryBuildBuildRoutes(app, ctx);
}
