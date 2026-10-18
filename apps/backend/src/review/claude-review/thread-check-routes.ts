import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { StartThreadCheckResponse, ThreadCheckStatusResponse } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getCiPrContext } from '../ci-review/persist.js';
import { AGENTIC_AI_ENABLED } from './manager.js';
import { liveThreadCheck, requestThreadCheckCancel, startThreadCheck } from './thread-check.js';
import { getLatestThreadCheck, threadCheckWire } from './thread-check-persist.js';

// CHECK THREADS API (CORE, free, LOCAL ONLY) — docs/API.md § Check threads. Registered by
// `registerAgenticRoutes` (review/agentic.ts), so absent in cloud and under LIMN_AI_DISABLED; the
// AGENTIC_AI_ENABLED checks are the second guard. Every route answers 404 for another account's PR.
// Rate tiers (api/plugins/rate-limit.ts, the `/claude-review` family): the start is `ai` +
// `ai_hourly`; the status poll and the cancel are `read`.

const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};

function featureOff(reply: FastifyReply): { error: string; message: string } {
  reply.status(404);
  return { error: 'NotFound', message: 'Check threads is off here. It runs on your machine: npx limn-review' };
}

function notFound(reply: FastifyReply, id: number): { error: string; message: string } {
  reply.status(404);
  return { error: 'NotFound', message: `PR ${id} not found` };
}

async function defaultWorkspaceId(ctx: AgentContext, accountId: number): Promise<number | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = (ctx.schema as any).workspaces;
  const rows = (await ctx.db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.accountId, accountId), eq(w.isDefault, true)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

/** The status read, shared by the GET route and the Claude Review tab's response. */
export async function threadCheckStatusFor(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<ThreadCheckStatusResponse> {
  const [row, live] = [await getLatestThreadCheck(ctx, accountId, prId), liveThreadCheck(accountId, prId)];
  const check = row ? threadCheckWire(row) : null;
  // The in-memory state is fresher than the row (a queued row whose run has started).
  if (check && live && live.checkId === check.id) check.status = live.status;
  return { prId, check, progress: live?.progress ?? null };
}

export function registerThreadCheckRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // ---- start ----
  app.post('/api/prs/:id/claude-review/thread-check', { schema: idParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    const pr = await getCiPrContext(ctx, accountId, id);
    if (!pr) return notFound(reply, id);
    if (!pr.headSha) {
      reply.status(409);
      return { error: 'NoHead', message: 'This pull request has not been synced yet.' };
    }
    const auth = ctx.llm.detectAuth();
    if (auth.status === 'none') {
      reply.status(400);
      return { error: 'NoClaudeAuth', message: auth.message };
    }
    if ((await ctx.aiCredits.check(accountId)).agentBlocked) {
      reply.status(402);
      return { error: 'CreditsExhausted', message: 'Out of monthly agentic AI credits — resets on the 1st.' };
    }
    const r = await startThreadCheck(ctx, {
      accountId,
      workspaceId: pr.workspaceId ?? (await defaultWorkspaceId(ctx, accountId)) ?? 0,
      prId: id,
      repoId: pr.repoId,
      headSha: pr.headSha,
      trigger: 'manual',
    });
    if (r.outcome === 'disabled') return featureOff(reply);
    if (r.outcome === 'busy') {
      reply.status(409);
      return { error: 'Busy', message: 'Too many checks are waiting. Try again once some finish.' };
    }
    if (r.outcome === 'queued') reply.status(202);
    const res: StartThreadCheckResponse = r;
    return res;
  });

  // ---- status (poll while queued / running) ----
  app.get('/api/prs/:id/claude-review/thread-check', { schema: idParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    if (!(await getCiPrContext(ctx, accountId, id))) return notFound(reply, id);
    return threadCheckStatusFor(ctx, accountId, id);
  });

  // ---- cancel ----
  app.post('/api/prs/:id/claude-review/thread-check/cancel', { schema: idParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    if (!(await getCiPrContext(ctx, accountId, id))) return notFound(reply, id);
    return { cancelled: requestThreadCheckCancel(accountId, id) };
  });
}
