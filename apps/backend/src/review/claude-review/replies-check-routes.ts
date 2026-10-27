import type { FastifyInstance, FastifyReply } from 'fastify';
import type { StartRepliesCheckResponse } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getCiPrContext } from '../ci-review/persist.js';
import { AGENTIC_AI_ENABLED } from './manager.js';
import { requestRepliesCheckCancel, startRepliesCheck } from './replies-check.js';

// THE REPLIES PASS API (CORE, LOCAL ONLY) — docs/API.md § The replies pass. Registered by
// `registerAgenticRoutes` (review/agentic.ts), so absent under LIMN_AI_DISABLED; the
// AGENTIC_AI_ENABLED checks are the second guard. 404 for another account's PR. The state is read on
// `GET /api/prs/:id/claude-review` (`repliesCheck`). Rate tiers (api/plugins/rate-limit.ts, the
// `/claude-review` family): the start is `ai` + `ai_hourly`; the cancel is `read`.
// ⚠ A pass a reader starts NEVER writes to GitHub: its judgements are drafts ("Post reply").

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};

function featureOff(reply: FastifyReply): { error: string; message: string } {
  reply.status(404);
  return { error: 'NotFound', message: 'Check replies is off here. It runs on your machine: npx limn-review' };
}

function notFound(reply: FastifyReply, id: number): { error: string; message: string } {
  reply.status(404);
  return { error: 'NotFound', message: `PR ${id} not found` };
}

export function registerRepliesCheckRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.post('/api/prs/:id/claude-review/replies', { schema: idParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    if (!(await getCiPrContext(ctx, accountId, id))) return notFound(reply, id);
    const auth = ctx.llm.detectAuth('thread_check');
    if (auth.status === 'none') {
      reply.status(400);
      return { error: 'NoClaudeAuth', message: auth.message };
    }
    const r = await startRepliesCheck(ctx, { accountId, prId: id, trigger: 'manual' });
    switch (r.outcome) {
      case 'disabled':
        return featureOff(reply);
      case 'not_found':
        return notFound(reply, id);
      case 'not_open':
        reply.status(409);
        return { error: 'NotOpen', message: 'This pull request is closed.' };
      case 'busy':
        reply.status(409);
        return { error: 'Busy', message: 'Too many checks are waiting. Try again once some finish.' };
      case 'not_ready':
      case 'over_budget':
        // Automatic-only outcomes; a click never reaches them.
        reply.status(409);
        return { error: 'Busy', message: 'Try again in a moment.' };
      case 'queued': {
        reply.status(202);
        const res: StartRepliesCheckResponse = { outcome: 'queued', reviewId: r.reviewId, threads: r.threads };
        return res;
      }
      case 'already_running': {
        const res: StartRepliesCheckResponse = { outcome: 'already_running', reviewId: r.reviewId };
        return res;
      }
      case 'refused': {
        const res: StartRepliesCheckResponse = { outcome: 'refused', reason: r.reason };
        return res;
      }
    }
  });

  app.post('/api/prs/:id/claude-review/replies/cancel', { schema: idParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    if (!(await getCiPrContext(ctx, accountId, id))) return notFound(reply, id);
    return { cancelled: requestRepliesCheckCancel(accountId, id) };
  });
}
