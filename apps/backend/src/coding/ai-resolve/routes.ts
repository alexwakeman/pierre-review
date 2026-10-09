import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CLAUDE_REVIEW_MODELS,
  DEFAULT_AI_FIX_MODEL,
  type ConflictAiStatusResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { getPrWriteContext, WRITE_PERMISSIONS } from '../../db/queries.js';
import { gitSupportsMergeTree } from '../../conflict/git.js';
import { cancelAiResolve, getAiResolution, startAiResolve } from './run.js';

/**
 * "RESOLVE WITH CLAUDE" — three routes (CORE, free, LOCAL ONLY).
 *
 *   POST   /api/prs/:id/conflicts/ai-resolve   start (or re-attach to) a run → 202 + its view
 *   GET    /api/prs/:id/conflicts/ai-resolve   this account's latest answer for the PR, polled
 *   DELETE /api/prs/:id/conflicts/ai-resolve   cancel the run
 *
 * ⚠ REGISTERED ONLY BY `registerAgenticRoutes` (review/agentic.ts), whose explicit `isCloud` check
 * keeps every agentic route out of the cloud process: there they 404. The resolver's own seven
 * routes stay in both modes; this one is the agentic half and follows the agentic rule.
 *
 * ⚠ OWNERSHIP AND WRITE PERMISSION ON ALL THREE, the resolver's own rule (→ 404 / 403): a run
 * builds a conflict session the reader will commit from, so a reader who cannot push has nothing
 * to start. The POST is on the `ai` rate-limit tier (api/plugins/rate-limit.ts) — it spends model
 * money and may also build a clone.
 */

type Params = { id: string };

function refuse(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

function resolveModel(raw: unknown): string | null {
  if (raw == null) return DEFAULT_AI_FIX_MODEL;
  if (typeof raw !== 'string') return null;
  return (CLAUDE_REVIEW_MODELS as readonly string[]).includes(raw) ? raw : null;
}

export function registerAiResolveRoutes(
  app: FastifyInstance,
  ctx: AgentContext,
  deps: { runOpen: Parameters<typeof startAiResolve>[1]['runOpen'] },
): void {
  const parseId = (raw: string): number | null => {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  /** Not this account's PR → 404 (no existence oracle); no push rights → 403. */
  async function requireWritable(
    reply: FastifyReply,
    accountId: number,
    id: number,
  ): Promise<{ ok: true; state: string; headSha: string | null } | { ok: false }> {
    const pr = await getPrWriteContext(id, accountId);
    if (!pr) {
      await refuse(reply, 404, 'NotFound', `PR ${id} not found`);
      return { ok: false };
    }
    if (!WRITE_PERMISSIONS.has(pr.viewerPermission ?? '')) {
      await refuse(
        reply,
        403,
        'NotPermitted',
        'You need write access to resolve conflicts on this pull request.',
      );
      return { ok: false };
    }
    return { ok: true, state: pr.state, headSha: pr.headSha ?? null };
  }

  app.post<{ Params: Params; Body: { model?: unknown } | null }>(
    '/api/prs/:id/conflicts/ai-resolve',
    async (req, reply) => {
      const id = parseId(req.params.id);
      if (id == null) return refuse(reply, 404, 'NotFound', 'PR not found');
      const accountId = ctx.accountIdOf(req);
      const allowed = await requireWritable(reply, accountId, id);
      if (!allowed.ok) return reply;
      if (allowed.state !== 'open') {
        return refuse(reply, 409, 'NotOpen', 'This pull request is no longer open.');
      }
      const model = resolveModel(req.body?.model);
      if (model == null) return refuse(reply, 400, 'BadModel', 'That model isn’t offered.');
      if (!(await gitSupportsMergeTree())) {
        return refuse(reply, 501, 'GitUnavailable', 'git isn’t available here. Resolve conflicts on GitHub.');
      }

      const res = await startAiResolve(ctx, {
        accountId,
        prId: id,
        model,
        headSha: allowed.headSha,
        log: req.log,
        runOpen: deps.runOpen,
      });
      switch (res.status) {
        case 'started':
        case 'running':
          return reply.code(202).send({ resolution: res.resolution } satisfies ConflictAiStatusResponse);
        case 'no_conflicts':
          return refuse(reply, 409, 'NoConflicts', `This pull request no longer conflicts with ${res.baseRef}.`);
        case 'busy_account':
          return refuse(reply, 409, 'Busy', 'Claude is already resolving another pull request for you. Wait for it to finish.');
        case 'busy_pr':
          return refuse(reply, 409, 'Busy', 'This pull request is already being worked on. Give it a moment.');
        case 'busy_service':
          return refuse(reply, 503, 'Busy', 'The service is busy. Try again in a moment.');
        case 'no_auth':
          return refuse(reply, 400, 'NoClaudeAuth', res.message ?? 'No Claude credential was found.');
        case 'credits_exhausted':
          return refuse(reply, 402, 'CreditsExhausted', 'Out of monthly agentic AI credits — resets on the 1st.');
      }
    },
  );

  app.get<{ Params: Params }>('/api/prs/:id/conflicts/ai-resolve', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id == null) return refuse(reply, 404, 'NotFound', 'PR not found');
    const accountId = ctx.accountIdOf(req);
    const allowed = await requireWritable(reply, accountId, id);
    if (!allowed.ok) return reply;
    return { resolution: getAiResolution(accountId, id) } satisfies ConflictAiStatusResponse;
  });

  app.delete<{ Params: Params }>('/api/prs/:id/conflicts/ai-resolve', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id == null) return refuse(reply, 404, 'NotFound', 'PR not found');
    const accountId = ctx.accountIdOf(req);
    const allowed = await requireWritable(reply, accountId, id);
    if (!allowed.ok) return reply;
    cancelAiResolve(accountId, id);
    return reply.code(204).send();
  });
}
