import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  CI_REVIEW_STATES_MAX,
  type CiReviewState,
  type CiReviewStatesBody,
  type CiReviewStatesResponse,
  type PrCiReviewResponse,
  type StartCiReviewBody,
  type StartCiReviewResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { AGENTIC_AI_ENABLED } from '../claude-review/manager.js';
import { deriveCiReviewState } from './currency.js';
import {
  getCiPrContext,
  getCiReviewById,
  getCiReviewRow,
  getCiStateInputs,
  getLatestCiReviewForPr,
  readSyncedCi,
} from './persist.js';
import { getCiRunStatus, startCiReview, subscribeCiReviewStream } from './manager.js';

// THE CI REVIEW API (CORE, free, LOCAL ONLY) — docs/API.md § CI review. Registered by
// `registerAgenticRoutes` (review/agentic.ts), so absent in cloud and under LIMN_AI_DISABLED; the
// AGENTIC_AI_ENABLED checks are the second guard. Every id-addressed route answers 404 for another
// account's id. Rate-limit tiers: the start route is `ai` + `ai_hourly`; everything else `read`
// (api/plugins/rate-limit.ts) — the states read is DB-only (the SYNCED head and failing names), and
// no route here returns a log or a log URL.

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const startSchema = {
  body: {
    type: 'object',
    required: ['prId'],
    additionalProperties: false,
    properties: { prId: { type: 'integer' } },
  },
};
const idParam = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};
const statesSchema = {
  body: {
    type: 'object',
    required: ['prIds'],
    additionalProperties: false,
    // No maxItems: the count answers with our own message.
    properties: { prIds: { type: 'array', items: { type: 'integer' } } },
  },
};

function featureOff(reply: FastifyReply): { error: string; message: string } {
  reply.status(404);
  return { error: 'NotFound', message: 'CI review is off here. It runs on your machine: npx limn-review' };
}

async function defaultWorkspaceId(ctx: AgentContext, accountId: number): Promise<number | null> {
  const w = s(ctx).workspaces;
  const rows = (await ctx.db
    .select({ id: w.id })
    .from(w)
    .where(and(eq(w.accountId, accountId), eq(w.isDefault, true)))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

/** Server-computed currency per PR (currency.ts), from the SYNCED head and failing names. */
export async function ciStatesFor(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, CiReviewState>> {
  const [inputs, synced] = await Promise.all([
    getCiStateInputs(ctx, accountId, prIds),
    readSyncedCi(ctx, accountId, prIds),
  ]);
  const out = new Map<number, CiReviewState>();
  for (const prId of new Set(prIds)) out.set(prId, deriveCiReviewState(prId, inputs.get(prId), synced.get(prId)));
  return out;
}

export function registerCiReviewRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // ---- start (or re-check) ----
  app.post('/api/ci-reviews', { schema: startSchema }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { prId } = req.body as StartCiReviewBody;
    const accountId = ctx.accountIdOf(req);
    const pr = await getCiPrContext(ctx, accountId, prId);
    if (!pr) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${prId} not found` };
    }
    if (!pr.headSha) {
      reply.status(409);
      return { error: 'NoHead', message: 'This PR has not been synced yet.' };
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
    const r = await startCiReview(ctx, {
      accountId,
      workspaceId: pr.workspaceId ?? (await defaultWorkspaceId(ctx, accountId)) ?? 0,
      prId,
      repoId: pr.repoId,
      headSha: pr.headSha,
      triggerKey: null,
      trigger: 'manual',
    });
    if (r.outcome === 'disabled') return featureOff(reply);
    if (r.outcome === 'busy') {
      reply.status(409);
      return { error: 'Busy', message: 'Too many CI checks are waiting. Try again once some finish.' };
    }
    reply.status(202);
    const res: StartCiReviewResponse = { outcome: r.outcome, ciReviewId: r.runId };
    return res;
  });

  // ---- the PR pane: the latest run and whether it is current ----
  app.get(
    '/api/prs/:id/ci-review',
    { schema: idParam },
    async (req, reply): Promise<PrCiReviewResponse | { error: string; message: string }> => {
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const { id } = req.params as { id: number };
      const accountId = ctx.accountIdOf(req);
      if (!(await getCiPrContext(ctx, accountId, id))) {
        reply.status(404);
        return { error: 'NotFound', message: `PR ${id} not found` };
      }
      const [review, states] = await Promise.all([
        getLatestCiReviewForPr(ctx, accountId, id),
        ciStatesFor(ctx, accountId, [id]),
      ]);
      return { prId: id, review, state: states.get(id)! };
    },
  );

  // ---- one run ----
  app.get('/api/ci-reviews/:id', { schema: idParam }, async (req, reply) => {
    if (!AGENTIC_AI_ENABLED) return featureOff(reply);
    const { id } = req.params as { id: number };
    const run = await getCiReviewById(ctx, ctx.accountIdOf(req), id);
    if (!run) {
      reply.status(404);
      return { error: 'NotFound', message: `CI review ${id} not found` };
    }
    return run;
  });

  // ---- live progress (SSE, a GET: `req.raw.on('close')` is the right signal here) ----
  app.get('/api/ci-reviews/:id/stream', { schema: idParam }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const accountId = ctx.accountIdOf(req);
    // OWNERSHIP BEFORE hijack: the subscription keys on the run id alone.
    if (!AGENTIC_AI_ENABLED || !(await getCiReviewRow(ctx, accountId, id))) {
      return reply.code(404).send({ error: 'NotFound', message: `CI review ${id} not found` });
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data: unknown): void => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(': hb\n\n');
    }, 15000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!raw.writableEnded) raw.end();
    };
    // Subscribe BEFORE the snapshot so a terminal `done` during setup is not missed.
    unsubscribe = subscribeCiReviewStream(id, (e) => {
      send(e);
      if (e.type === 'done') cleanup();
    });
    req.raw.on('close', cleanup);
    const snap = await getCiRunStatus(ctx, accountId, id);
    const status = snap?.status ?? 'failed';
    send({ type: 'snapshot', status, ciReviewId: id, progress: snap?.progress ?? null });
    if (status !== 'running' && status !== 'queued') {
      send({ type: 'done', status, ciReviewId: id, prId: snap?.prId ?? 0 });
      cleanup();
    }
  });

  // ---- batched currency for Open PRs and the Pending cards (DB only) ----
  app.post(
    '/api/ci-reviews/states',
    { schema: statesSchema },
    async (req, reply): Promise<CiReviewStatesResponse | { error: string; message: string }> => {
      const { prIds } = req.body as CiReviewStatesBody;
      const unique = [...new Set(prIds)];
      if (unique.length > CI_REVIEW_STATES_MAX) {
        reply.status(400);
        return { error: 'TooManyPrs', message: `At most ${CI_REVIEW_STATES_MAX} PRs per request; got ${unique.length}.` };
      }
      if (!AGENTIC_AI_ENABLED) return featureOff(reply);
      const states = await ciStatesFor(ctx, ctx.accountIdOf(req), unique);
      return { states: prIds.map((id) => states.get(id)!) };
    },
  );
}
