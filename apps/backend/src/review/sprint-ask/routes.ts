import type { FastifyInstance } from 'fastify';
import {
  SPRINT_ASK_QUESTION_MAX,
  SPRINT_BRIEF_MODEL,
  type SprintAskResponse,
  type SprintAskTurn,
} from '@pierre-review/shared';
import { config } from '../../config.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import type { AgentContext } from '../agent-context.js';
import { AiRuntimeMissingError } from '../../ai/runtime.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import { cheapUsage } from '../cheap-usage.js';
import { labelCostUsd, type CompleteFn } from '../story-labels/manager.js';
import { capAskHistory, SPRINT_ASK_SYSTEM, sprintAskPrompt, sprintAskUntrusted, sprintMapText } from './prompt.js';

// POST /api/sprint-graph/ask {workspaceId, question, history?} — "Ask Claude about this sprint"
// (docs/API.md § This sprint; docs/CLAUDE-REVIEW.md § Ask about this sprint). Registered ONLY through
// `registerAgenticRoutes` (local; it 404s in cloud). Free like the rest of This Sprint — agentic, so
// gated on `config.aiEnabled`, never on a Pro capability. ONE Haiku completion per turn through the core cheap seam (`cheapComplete`: tool-less,
// connectors isolated) over the STORED graph (`getSprintGraph`, DB only) — never a tracker call. The
// workspace resolves the `?workspace=` way. Cost recorded (`recordAiUsage`, feature 'sprint_ask').
// Rate tier: ai + ai_hourly (`tierFor`).

const ANSWER_TOKENS = 900;

let completeOverride: CompleteFn | null = null;
/** Tests inject a fake completion (never a real model call); null restores `cheapComplete`. */
export function setSprintAskCompleteForTests(fn: CompleteFn | null): void {
  completeOverride = fn;
}

export function registerSprintAskRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.post('/api/sprint-graph/ask', async (req, reply): Promise<SprintAskResponse | { error: string; message?: string }> => {
    const body = (req.body ?? {}) as { workspaceId?: unknown; question?: unknown; history?: unknown };
    const question = typeof body.question === 'string' ? body.question.replace(/\u0000/g, '').trim() : '';
    if (
      typeof body.workspaceId !== 'number' ||
      !Number.isSafeInteger(body.workspaceId) ||
      question === '' ||
      question.length > SPRINT_ASK_QUESTION_MAX ||
      (body.history != null && !Array.isArray(body.history))
    ) {
      reply.status(400);
      return { error: 'bad_request', message: `Send a workspaceId and a question of at most ${SPRINT_ASK_QUESTION_MAX} characters.` };
    }
    if (!config.aiEnabled) {
      reply.status(404);
      return { error: 'not_found' };
    }
    if (ctx.llm.detectAuth().status !== 'ok') {
      reply.status(503);
      return { error: 'no_credential', message: 'No Claude login or API key found.' };
    }
    const accountId = ctx.accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, body.workspaceId);
    const { getSprintGraph } = await import('../../db/sprint-graph.js');
    const graph = await getSprintGraph(accountId, scope.workspaceId, { aiEnabled: true, now: Date.now() });
    if (!graph.trackerOn || graph.nodes.length === 0) {
      return {
        workspaceId: scope.workspaceId,
        answer: graph.trackerOn ? 'The sprint has not been read yet, so there is nothing to answer from.' : 'This workspace has no issue tracker.',
        trimmedTurns: 0,
        model: SPRINT_BRIEF_MODEL,
        costUsd: null,
      };
    }
    const { turns, trimmed } = capAskHistory(body.history as SprintAskTurn[] | undefined);
    const map = sprintMapText(graph);
    const nonce = pickReviewNonce(sprintAskUntrusted(map, turns, question));
    try {
      const complete = completeOverride ?? (await import('../llm.js')).cheapComplete;
      const out = await complete({
        model: SPRINT_BRIEF_MODEL,
        system: SPRINT_ASK_SYSTEM,
        prompt: sprintAskPrompt(map, turns, question, nonce),
        maxTokens: ANSWER_TOKENS,
      });
      const u = cheapUsage(out, SPRINT_BRIEF_MODEL, labelCostUsd);
      const inputTokens = u.inputTokens ?? 0;
      const outputTokens = u.outputTokens ?? 0;
      const costUsd = u.costUsd;
      await ctx
        .recordAiUsage({ accountId, seam: 'summary', feature: 'sprint_ask', ...u })
        .catch((err) => ctx.log.warn({ err }, 'sprint ask: usage record failed'));
      const answer = out.text.trim();
      return {
        workspaceId: scope.workspaceId,
        answer: answer === '' ? 'Claude gave no answer. Try asking again.' : answer,
        trimmedTurns: trimmed,
        model: SPRINT_BRIEF_MODEL,
        costUsd,
      };
    } catch (err) {
      if (err instanceof AiRuntimeMissingError) {
        reply.status(503);
        // Its own sentence names the remedy (Claude's "Set up AI", or `limn ai install codex`).
        return { error: 'runtime', message: err.message };
      }
      ctx.log.warn({ accountId, err: String(err).slice(0, 200) }, 'sprint ask: completion failed');
      reply.status(502);
      return { error: 'failed', message: 'Claude could not answer. Try again.' };
    }
  });
}
