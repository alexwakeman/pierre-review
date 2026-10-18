import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  STORY_DOCS_IDENT_MAX,
  parseTicketIdent,
  type StartStoryDocsAlignmentBody,
  type StartStoryDocsAlignmentResponse,
  type StoryDocsAlignmentResponse,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import type { AgentContext } from '../agent-context.js';
import { AGENTIC_AI_ENABLED } from '../claude-review/manager.js';
import { utcDayStartMs } from '../diagrams/trigger.js';
import { liveStoryDocs, startStoryDocs, storyDocsClaim } from './manager.js';
import { countStoryDocsRunsSince, latestStoryDocsRun, latestSucceededStoryDocsRun, toStoryDocsRun } from './persist.js';

// CHECK A STORY AGAINST THE DOCS (CORE, free, LOCAL ONLY) — docs/API.md § Check a story against the
// docs. Registered by `registerAgenticRoutes` (review/agentic.ts), so absent in cloud and under
// LIMN_AI_DISABLED; the AGENTIC_AI_ENABLED checks are the second guard.
//
//   GET  /api/docs/story-alignment?workspace=&ident=   the story's runs (DB + disk; no model)  → read
//   POST /api/docs/story-alignment { workspaceId?, ident }  queue ONE check                → ai + ai_hourly
//
// TENANCY: the workspace resolves through `resolveWorkspaceScope` (absent / unknown / another
// account's ⇒ this account's Default, echoed); every read carries the account AND the workspace; the
// row's composite FK refuses a cross-account workspace in the database. A ticket ident has no row to
// own — another account's ident simply has no runs (and no stored story) here.

type ErrorBody = { error: string; message: string };

const getQuery = {
  querystring: {
    type: 'object',
    required: ['ident'],
    properties: {
      ident: { type: 'string', minLength: 1, maxLength: STORY_DOCS_IDENT_MAX },
      workspace: { type: 'string' },
    },
  },
};
const postBody = {
  body: {
    type: 'object',
    required: ['ident'],
    additionalProperties: false,
    properties: {
      ident: { type: 'string', minLength: 1, maxLength: STORY_DOCS_IDENT_MAX },
      // Any value: a non-integer falls back to Default through resolveWorkspaceScope, never a 400.
      workspaceId: {},
    },
  },
};

function featureOff(reply: FastifyReply): ErrorBody {
  reply.status(404);
  return { error: 'NotFound', message: 'Checking a story against the docs runs on your machine: npx limn-review' };
}

const fail = (reply: FastifyReply, status: number, error: string, message: string): ErrorBody => {
  reply.status(status);
  return { error, message };
};

const isTrackerIdent = (ident: string): boolean => {
  const p = parseTicketIdent(ident);
  return p != null && p.kind !== 'manual';
};

export function registerStoryDocsRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.get(
    '/api/docs/story-alignment',
    { schema: getQuery },
    async (req, reply): Promise<StoryDocsAlignmentResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const { ident, workspace } = req.query as { ident: string; workspace?: string };
      if (!isTrackerIdent(ident)) return fail(reply, 400, 'BadIdent', 'Not a tracker ticket.');
      const accountId = ctx.accountIdOf(req);
      const { workspaceId } = await resolveWorkspaceScope(accountId, workspace ?? null);
      const latest = await latestStoryDocsRun(ctx, accountId, workspaceId, ident);
      const good = latest == null || latest.status === 'succeeded' ? null : await latestSucceededStoryDocsRun(ctx, accountId, workspaceId, ident);
      const live = await liveStoryDocs(ctx, accountId, workspaceId, ident);
      const hashes = live.inputs != null ? { storyHash: live.inputs.storyHash, criteriaHash: live.inputs.criteriaHash, libraryHash: live.libraryHash } : null;
      return {
        workspaceId,
        ident,
        available: live.docCount > 0,
        docCount: live.docCount,
        run: latest != null ? toStoryDocsRun(latest, hashes) : null,
        lastSucceeded: good != null ? toStoryDocsRun(good, hashes) : null,
      };
    },
  );

  app.post(
    '/api/docs/story-alignment',
    { schema: postBody },
    async (req, reply): Promise<StartStoryDocsAlignmentResponse | ErrorBody> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const body = req.body as StartStoryDocsAlignmentBody;
      if (!isTrackerIdent(body.ident)) return fail(reply, 400, 'BadIdent', 'Not a tracker ticket.');
      const accountId = ctx.accountIdOf(req);
      const rawWs: unknown = body.workspaceId;
      const { workspaceId } = await resolveWorkspaceScope(accountId, typeof rawWs === 'number' || typeof rawWs === 'string' ? rawWs : null);
      // Already queued or running: say so (with its id) before any refusal — a second click must
      // never read as a cap refusal under a check that is still going.
      const held = storyDocsClaim(accountId, workspaceId, body.ident);
      if (held !== undefined) return { outcome: 'already_running', runId: held };
      const live = await liveStoryDocs(ctx, accountId, workspaceId, body.ident);
      if (live.docCount === 0) return { outcome: 'refused', runId: null, refusal: 'no_docs' };
      if (live.inputs == null || live.inputs.empty) return { outcome: 'refused', runId: null, refusal: 'no_story' };
      const auth = ctx.llm.detectAuth();
      if (auth.status === 'none') return fail(reply, 400, 'NoClaudeAuth', auth.message ?? 'No Claude credential found.');
      if ((await ctx.aiCredits.check(accountId)).agentBlocked) {
        return fail(reply, 402, 'CreditsExhausted', 'Out of monthly agentic AI credits — resets on the 1st.');
      }
      if ((await countStoryDocsRunsSince(ctx, accountId, utcDayStartMs(Date.now()))) >= config.storyDocsDailyCap) {
        return { outcome: 'refused', runId: null, refusal: 'daily_cap' };
      }
      const r = await startStoryDocs(ctx, { accountId, workspaceId, inputs: live.inputs, libraryHash: live.libraryHash });
      if (r.outcome === 'disabled') return featureOff(reply);
      if (r.outcome === 'busy') return fail(reply, 409, 'Busy', 'Too many docs checks are waiting. Try again once some finish.');
      reply.status(r.outcome === 'queued' ? 202 : 200);
      return { outcome: r.outcome, runId: r.runId };
    },
  );
}
