import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_CLAUDE_REVIEW_MODEL,
  STORY_BUILD_API,
  STORY_BUILD_MESSAGE_MAX,
  STORY_BUILD_PLAN_MAX_REVISIONS,
  TICKET_IDENT_MAX_CHARS,
  parseTicketIdent,
  type StoryBuild,
  type StoryBuildAcceptBody,
  type StoryBuildErrorCode,
  type StoryBuildForTicketResponse,
  type StoryBuildPlanMessageBody,
  type StoryBuildStartBody,
  type StoryBuildStartResponse,
} from '@pierre-review/shared';
import { preflightFor, resolveManualRunChoice } from '../../ai/run-choice.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import type { AgentContext } from '../../review/agent-context.js';
import { AGENTIC_AI_ENABLED } from '../../review/claude-review/manager.js';
import { storyBuildLimits } from './limits.js';
import {
  acceptStoryPlan,
  cancelStoryBuild,
  discardStoryBuild,
  registerStoryBuildManagerLane,
  isStoryBuildLive,
  sendStoryPlanMessage,
  startStoryBuild,
  storyBuildInputsFor,
  storyBuildLiveProgress,
  subscribeStoryBuild,
  type StoryBuildActionResult,
} from './manager.js';
import {
  getStoryBuildRow,
  listStoryBuildRepoRows,
  listStoryBuildRowsFor,
  storyBuildRepoNames,
  toStoryBuild,
  toStoryBuildSummary,
  type StoryBuildRow,
} from './persist.js';
import { registerStoryBuildBuildRoutes } from './routes-build.js';
import { registerStoryBuildDocsRoutes } from './routes-docs.js';

// "IMPLEMENT STORY" ROUTES (docs/STORY-BUILD.md § Routes; contracts in docs/API.md). Registered ONLY from
// review/agentic.ts `registerAgenticRoutes`, so nothing answers when AI is off (the paths 404); the
// AGENTIC_AI_ENABLED checks are the second guard. Every path is spelled once in packages/shared
// `STORY_BUILD_API`; every `:id` read scopes the account (a wrong owner is 404); each path has a rate-limit
// tier (api/plugins/rate-limit.ts, rate-limit.test.ts).
//
// THREE FILES, ONE PER WORK PACKAGE, so the packages never edit the same lines:
//   routes.ts        WP1  GET list/one/stream · POST start · plan/message · accept · cancel · discard
//   routes-build.ts  WP2  GET …/repos/:repoId/{checks,diff} · POST …/repos/:repoId/{retry,push} · POST …/push
//   routes-docs.ts   WP3  POST …/docs · PUT …/docs/decisions
//
// TENANCY: `?workspace=` / `workspaceId` resolve through `resolveWorkspaceScope` (absent / unknown /
// another account's ⇒ this account's Default, echoed); a session id is read through the account-scoped
// getter (another account's ⇒ 404). The session row's composite FK refuses a cross-account workspace.

type ErrorBody = { error: StoryBuildErrorCode; message: string };

const fail = (reply: FastifyReply, status: number, error: StoryBuildErrorCode, message: string): ErrorBody => {
  reply.status(status);
  return { error, message };
};

function featureOff(reply: FastifyReply): ErrorBody {
  return fail(reply, 404, 'NotFound', 'Implementing a story runs on your machine: npx limn-review');
}

const notFound = (reply: FastifyReply): ErrorBody => fail(reply, 404, 'NotFound', 'Not found.');

const isTrackerIdent = (ident: string): boolean => {
  const p = parseTicketIdent(ident);
  return p != null && p.kind !== 'manual';
};

const parseId = (raw: string | undefined): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const idParams = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]{1,12}$' } } } };

/** The wire session (the caller has already scoped `row` to `accountId`). */
export async function storyBuildWire(ctx: AgentContext, accountId: number, row: StoryBuildRow): Promise<StoryBuild> {
  const repos = await listStoryBuildRepoRows(ctx, accountId, row.id);
  const names = await storyBuildRepoNames(ctx, accountId, [...repos.map((r) => r.repoId), ...(row.candidatesJson ?? []).map((c) => c.repoId)]);
  return toStoryBuild(row, repos, { repoNames: names, sessionBudgetUsd: storyBuildLimits().sessionBudgetUsd });
}

/** One action's answer: 202 `{ buildId }`, or the refusal it maps to. */
export function sendStoryBuildAction(reply: FastifyReply, res: StoryBuildActionResult): { buildId: number } | ErrorBody {
  switch (res.status) {
    case 'queued':
      reply.status(202);
      return { buildId: res.id };
    case 'not_found':
      return notFound(reply);
    case 'not_ready':
      return fail(reply, 409, 'NotReady', 'This build is not waiting for that any more.');
    case 'busy':
      return fail(reply, 409, 'Busy', 'Too many builds are waiting. Try again once some finish.');
    case 'no_auth':
      return fail(reply, 400, 'NoClaudeAuth', res.message ?? 'Sign in to an AI provider first.');
    case 'revision_cap':
      return fail(reply, 409, 'PlanRevisionCap', `This plan has been revised ${STORY_BUILD_PLAN_MAX_REVISIONS} times. Accept it or start again.`);
    case 'plan_budget_spent':
      return fail(reply, 409, 'PlanBudgetSpent', "This plan's budget is spent. Accept it or start again.");
    case 'session_budget_spent':
      return fail(reply, 409, 'SessionBudgetSpent', "This build's budget is spent.");
    case 'plan_moved':
      return fail(reply, 409, 'PlanMoved', 'The plan changed since you looked. Read the new one, then accept it.');
    case 'bad_request':
      return fail(reply, 400, 'BadRequest', res.message);
  }
}

export function registerStoryBuildRoutes(app: FastifyInstance, ctx: AgentContext): void {
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
      const rows = await listStoryBuildRowsFor(ctx, accountId, workspaceId, ident, 20);
      const [latest, ...earlier] = rows;
      return {
        workspaceId,
        build: latest != null ? await storyBuildWire(ctx, accountId, latest) : null,
        earlier: earlier.map(toStoryBuildSummary),
      };
    },
  );

  // ---- GET one session ----
  app.get(STORY_BUILD_API.one, { schema: idParams }, async (req, reply): Promise<StoryBuild | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = parseId((req.params as { id: string }).id);
    const accountId = ctx.accountIdOf(req);
    const row = id == null ? null : await getStoryBuildRow(ctx, accountId, id);
    if (row == null) return notFound(reply);
    return storyBuildWire(ctx, accountId, row);
  });

  // ---- SSE: StoryBuildProgress frames while a pass runs; the stream ENDS when it does ----
  app.get(STORY_BUILD_API.stream, { schema: idParams }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = parseId((req.params as { id: string }).id);
    const accountId = ctx.accountIdOf(req);
    // Ownership BEFORE hijack (a 404 cannot be sent after).
    const row = id == null ? null : await getStoryBuildRow(ctx, accountId, id);
    if (row == null || id == null) return notFound(reply);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const hb = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15_000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      unsub();
      if (!raw.writableEnded) raw.end();
    };
    // Subscribe BEFORE the snapshot so an ending pass cannot slip through the gap.
    const unsub = subscribeStoryBuild(id, (e) => {
      if (e.type === 'progress') {
        if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(e.progress)}\n\n`);
      } else cleanup();
    });
    // A GET: the request's close is the client going away (CLAUDE.md: only a POST's fires early).
    req.raw.on('close', cleanup);
    if (!isStoryBuildLive(id)) {
      cleanup();
      return;
    }
    const now = storyBuildLiveProgress(id);
    if (now != null && !raw.writableEnded) raw.write(`data: ${JSON.stringify(now)}\n\n`);
  });

  // ---- POST start ----
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
            provider: { type: 'string', maxLength: 20 },
            model: { type: 'string', maxLength: 80 },
            diagram: { type: 'boolean' },
            docs: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply): Promise<StoryBuildStartResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const body = req.body as StoryBuildStartBody;
      if (!isTrackerIdent(body.ident)) return fail(reply, 400, 'BadRequest', 'Not a tracker ticket.');
      const accountId = ctx.accountIdOf(req);
      const rawWs: unknown = body.workspaceId;
      const scope = await resolveWorkspaceScope(accountId, typeof rawWs === 'number' || typeof rawWs === 'string' ? rawWs : null);
      // A MANUAL run with a model menu: the reader's pick, validated; the default depth is deep (owner decision 7).
      const choice = resolveManualRunChoice({ provider: body.provider, model: body.model }, 'story_plan', {
        defaultModel: DEFAULT_CLAUDE_REVIEW_MODEL,
        detect: preflightFor(ctx),
      });
      if (!choice.ok) {
        const code: StoryBuildErrorCode = choice.error === 'ModelNotOnProvider' || choice.error === 'NoClaudeAuth' ? choice.error : 'BadRequest';
        return fail(reply, 400, code, choice.message);
      }
      const inputs = await storyBuildInputsFor(ctx, accountId, scope.workspaceId, body.ident);
      if (inputs == null || inputs.empty) return fail(reply, 400, 'NoStory', 'This ticket has no story or criteria to build from.');
      const r = await startStoryBuild(ctx, {
        accountId,
        workspaceId: scope.workspaceId,
        memberRepoIds: scope.repoIds,
        ident: body.ident,
        ticketKey: inputs.ticketKey,
        ticketTitle: inputs.title,
        provider: choice.provider,
        model: choice.model,
        wantDiagram: body.diagram === true,
        wantDocs: body.docs === true,
      });
      if (r.outcome === 'disabled') return featureOff(reply);
      if (r.outcome === 'busy') return fail(reply, 409, 'Busy', 'Too many builds are waiting. Try again once some finish.');
      reply.status(r.outcome === 'started' ? 202 : 200);
      return { outcome: r.outcome, buildId: r.id };
    },
  );

  // ---- POST a steering message: a fresh plan pass ----
  app.post(
    STORY_BUILD_API.planMessage,
    {
      schema: {
        ...idParams,
        body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = parseId((req.params as { id: string }).id);
      if (id == null) return notFound(reply);
      const text = (req.body as StoryBuildPlanMessageBody).text.trim();
      if (text === '') return fail(reply, 400, 'BadRequest', 'Say what to change.');
      if (text.length > STORY_BUILD_MESSAGE_MAX) {
        return fail(reply, 400, 'BadRequest', `Keep the message under ${STORY_BUILD_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
      }
      return sendStoryBuildAction(reply, await sendStoryPlanMessage(ctx, { accountId: ctx.accountIdOf(req), buildId: id, text }));
    },
  );

  // ---- POST accept: freeze the plan + docs decisions, build in plan order ----
  app.post(
    STORY_BUILD_API.accept,
    {
      schema: {
        ...idParams,
        body: {
          type: 'object',
          required: ['planRevision', 'repos'],
          additionalProperties: false,
          properties: {
            planRevision: { type: 'integer', minimum: 0 },
            repos: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['repoId', 'include', 'branch', 'checks'],
                additionalProperties: false,
                properties: {
                  repoId: { type: 'integer', minimum: 1 },
                  include: { type: 'boolean' },
                  branch: { type: 'string', maxLength: 200 },
                  checks: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 200 } },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const id = parseId((req.params as { id: string }).id);
      if (id == null) return notFound(reply);
      const body = req.body as StoryBuildAcceptBody;
      return sendStoryBuildAction(
        reply,
        await acceptStoryPlan(ctx, { accountId: ctx.accountIdOf(req), buildId: id, planRevision: body.planRevision, repos: body.repos }),
      );
    },
  );

  // ---- POST cancel / discard (DB + abort) ----
  app.post(STORY_BUILD_API.cancel, { schema: idParams }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = parseId((req.params as { id: string }).id);
    if (id == null) return notFound(reply);
    const res = await cancelStoryBuild(ctx, ctx.accountIdOf(req), id);
    if (res.status === 'not_found') return notFound(reply);
    return { status: res.status };
  });

  app.post(STORY_BUILD_API.discard, { schema: idParams }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const id = parseId((req.params as { id: string }).id);
    if (id == null) return notFound(reply);
    const res = await discardStoryBuild(ctx, ctx.accountIdOf(req), id);
    if (res.status === 'not_found') return notFound(reply);
    if (res.status === 'not_ready') return fail(reply, 409, 'NotReady', 'Cancel the build before discarding it.');
    return { status: res.status };
  });

  registerStoryBuildBuildRoutes(app, ctx);
  registerStoryBuildDocsRoutes(app, ctx);
  // WP2's retry route builds through the manager's ONE build lane.
  registerStoryBuildManagerLane();
}
