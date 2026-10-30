import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  STORY_BUILD_API,
  storyBuildDocsDefaultDecision,
  storyBuildDocsEffectiveDecisions,
  type StoryBuildDocsBody,
  type StoryBuildDocsDecision,
  type StoryBuildDocsDecisions,
  type StoryBuildDocsDecisionsBody,
  type StoryBuildDocsResponse,
  type StoryBuildErrorCode,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { AGENTIC_AI_ENABLED } from '../../review/claude-review/manager.js';
import { BUILD_DOCS_TEXT } from './docs.js';
import { reconcileStoryBuildDocsOnStartup, requestStoryBuildDocs, storyBuildDocsHeld } from './docs-runner.js';
import { getStoryBuildRow, updateStoryBuild } from './persist.js';

// "IMPLEMENT STORY" — the docs routes, WORK PACKAGE 3 (docs/STORY-BUILD.md § Docs consideration; contracts
// in docs/API.md). Registered from routes.ts → review/agentic.ts only, so AI off ⇒ 404.
//
//   POST /api/story-builds/:id/docs { force? }          weigh the plan against the docs    → ai + ai_hourly
//        202 started · 200 already_running | current (weighed against this plan revision; send force)
//        | refused (no built docs: the session reads docsStatus 'refused')
//        404 NotFound (not this account's) · 409 NotReady (no plan, or not `plan_ready`) · 409 Busy
//        · 409 SessionBudgetSpent · 400 NoClaudeAuth
//   PUT  /api/story-builds/:id/docs/decisions { decisions }   DB only                         → read
//        Ids not in the current docs (and grounded items: no decision) are dropped; the rest MERGE over
//        the stored ones. Answers the decisions in force. 409 NotReady once the plan is accepted (frozen).
//
// TENANCY: every read is `getStoryBuildRow(ctx, accountId, id)` — another account's id is 404.

type ErrorBody = { error: StoryBuildErrorCode | 'BadRequest'; message: string };

const fail = (reply: FastifyReply, status: number, error: ErrorBody['error'], message: string): ErrorBody => {
  reply.status(status);
  return { error, message };
};

const notFound = (reply: FastifyReply): ErrorBody => fail(reply, 404, 'NotFound', 'No such build.');

const idParams = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: '^[0-9]{1,12}$' } },
  },
};

const docsBody = {
  ...idParams,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { force: { type: 'boolean' } },
  },
};

const decisionsBody = {
  ...idParams,
  body: {
    type: 'object',
    required: ['decisions'],
    additionalProperties: false,
    properties: {
      decisions: {
        type: 'object',
        maxProperties: 100,
        additionalProperties: { type: 'string', enum: ['include', 'ignore'] },
      },
    },
  },
};

export function registerStoryBuildDocsRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // A restart cut off any docs run that was going: fail it (never stuck on "running").
  void reconcileStoryBuildDocsOnStartup(ctx).catch((err) => ctx.log.warn({ err }, 'story build docs: startup reconcile failed'));

  app.post(STORY_BUILD_API.docs, { schema: docsBody }, async (req, reply): Promise<StoryBuildDocsResponse | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return notFound(reply);
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as StoryBuildDocsBody;
    const accountId = ctx.accountIdOf(req);
    const row = await getStoryBuildRow(ctx, accountId, id);
    if (row == null) return notFound(reply);
    // Already queued or running: say so before any refusal.
    if (storyBuildDocsHeld(id)) return { outcome: 'already_running', buildId: id, message: null };
    if (row.status !== 'plan_ready' || row.planJson == null) {
      return fail(reply, 409, 'NotReady', row.acceptedRevision != null ? 'The plan is accepted: the docs points are frozen.' : 'The plan has to be ready first.');
    }
    const r = await requestStoryBuildDocs(ctx, row, body.force === true);
    if (r.outcome === 'current') return { outcome: 'current', buildId: id, message: null };
    if (r.outcome === 'refused') return { outcome: 'refused', buildId: id, message: r.message };
    if (r.outcome === 'no_auth') return fail(reply, 400, 'NoClaudeAuth', r.message);
    if (r.outcome === 'budget') return fail(reply, 409, 'SessionBudgetSpent', BUILD_DOCS_TEXT.budget);
    if (r.outcome === 'busy') return fail(reply, 409, 'Busy', 'Too many docs checks are waiting. Try again once some finish.');
    if (r.outcome === 'already_running') return { outcome: 'already_running', buildId: id, message: null };
    reply.status(202);
    return { outcome: 'started', buildId: id, message: null };
  });

  app.put(STORY_BUILD_API.docsDecisions, { schema: decisionsBody }, async (req, reply): Promise<StoryBuildDocsDecisionsBody | ErrorBody> => {
    if (!AGENTIC_AI_ENABLED) return notFound(reply);
    const id = Number((req.params as { id: string }).id);
    const accountId = ctx.accountIdOf(req);
    const row = await getStoryBuildRow(ctx, accountId, id);
    if (row == null) return notFound(reply);
    if (row.docsJson == null) return fail(reply, 409, 'NotReady', 'There are no docs points to decide.');
    if (row.status !== 'plan_ready') return fail(reply, 409, 'NotReady', 'The plan is accepted: the docs points are frozen.');
    // A run in flight replaces these points (and starts its decisions afresh): a choice now would be lost.
    if (row.docsStatus === 'running' || storyBuildDocsHeld(id)) return fail(reply, 409, 'NotReady', 'The docs are being weighed again.');
    const asked = (req.body as StoryBuildDocsDecisionsBody).decisions;
    const merged: StoryBuildDocsDecisions = {};
    for (const it of row.docsJson.items) {
      // Grounded items carry no decision.
      if (storyBuildDocsDefaultDecision(it.kind) == null) continue;
      const d: StoryBuildDocsDecision | undefined = Object.prototype.hasOwnProperty.call(asked, it.id) ? asked[it.id] : row.docsDecisionsJson?.[it.id];
      if (d != null) merged[it.id] = d;
    }
    await updateStoryBuild(ctx, accountId, id, { docsDecisionsJson: merged });
    return { decisions: storyBuildDocsEffectiveDecisions(row.docsJson, merged) };
  });
}
