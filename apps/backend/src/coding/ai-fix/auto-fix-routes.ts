// THE AUTO FIX QUEUE's two reads (docs/CLAUDE-REVIEW.md § AI Fix → The auto fix queue; contracts in
// docs/API.md). DB only (plus the queue's in-memory line); rate tier `read` (the `/api/pro/` GET rule).
//
//   GET /api/pro/prs/:id/ai-fix/auto               the AI Review tab: the queue's line + the PR's auto fixes
//   GET /api/pro/ai-fixes/auto-active?workspace=   the auto fixes toast: running now, and ended recently
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import {
  AUTO_FIX_TOAST_RECENT_MS,
  type AiFixStatus,
  type AutoFixActiveResponse,
  type AutoFixActiveRow,
  type AutoFixHistoryRow,
  type AutoFixPanelResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { resolveWorkspaceScope } from '../../db/queries.js';
import { autoFixQueueFor } from './auto-fix-queue.js';
import { parseChangeReport, parseReviewItems } from './persist.js';

const HISTORY_MAX = 30;
const ACTIVE_MAX = 25;

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(Number(v) * (Number(v) < 1e12 ? 1000 : 1));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The automatic push failed, or the run failed: the row's `error` (shown as it is stored). */
const failedOf = (status: string, error: string | null): boolean => status === 'failed' || (error != null && error.trim() !== '');

export function registerAutoFixRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.get<{ Params: { id: string } }>('/api/pro/prs/:id/ai-fix/auto', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const prId = /^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null;
    if (prId == null) return reply.code(404).send({ error: 'not found' });
    const { pullRequests: prs, aiFixes: af } = ctx.schema;
    const owned = (await ctx.db
      .select({ id: prs.id })
      .from(prs)
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ id: number }>;
    if (owned.length === 0) return reply.code(404).send({ error: 'not found' });
    const rows = (await ctx.db
      .select({
        id: af.id,
        status: af.status,
        sourceReviewId: af.sourceReviewId,
        reviewItems: af.reviewItems,
        changeReport: af.changeReport,
        commitMessage: af.commitMessage,
        pushedAt: af.pushedAt,
        pushedBranch: af.pushedBranch,
        error: af.error,
        createdAt: af.createdAt,
        finishedAt: af.finishedAt,
      })
      .from(af)
      .where(and(eq(af.accountId, accountId), eq(af.prId, prId), eq(af.trigger, 'auto')))
      .orderBy(desc(af.id))
      .limit(HISTORY_MAX)
      .execute()) as Array<{
      id: number;
      status: string;
      sourceReviewId: number | null;
      reviewItems: string | null;
      changeReport: string | null;
      commitMessage: string | null;
      pushedAt: unknown;
      pushedBranch: string | null;
      error: string | null;
      createdAt: unknown;
      finishedAt: unknown;
    }>;
    const history: AutoFixHistoryRow[] = rows.map((r) => {
      const items = (parseReviewItems(r.reviewItems) ?? []).filter((i) => i.included !== false).length;
      const report = parseChangeReport(r.changeReport);
      const unaddressed = report != null ? report.unaddressed.length + report.notReported.length : null;
      return {
        id: r.id,
        status: r.status as AiFixStatus,
        sourceReviewId: r.sourceReviewId,
        items,
        addressed: report != null ? Math.max(0, items - (unaddressed ?? 0)) : null,
        unaddressed,
        commitMessage: r.commitMessage,
        pushedAt: iso(r.pushedAt),
        pushedBranch: r.pushedBranch,
        error: r.error,
        createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
        finishedAt: iso(r.finishedAt),
      };
    });
    const { readWorkspaceAutoFixSettingsForPr } = await import('../../review/claude-review/auto-settings.js');
    const { prAuthorIsAccount } = await import('./auto-fix.js');
    const on = ((await readWorkspaceAutoFixSettingsForPr(ctx, accountId, prId))?.enabled ?? false) && (await prAuthorIsAccount(ctx, accountId, prId));
    const resp: AutoFixPanelResponse = { prId, on, queue: on ? autoFixQueueFor(accountId, prId) : null, history };
    return reply.send(resp);
  });

  app.get<{ Querystring: { workspace?: string } }>('/api/pro/ai-fixes/auto-active', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, req.query.workspace ?? null);
    const resp: AutoFixActiveResponse = { workspaceId: scope.workspaceId, fixes: [] };
    if (scope.repoIds.length === 0) return reply.send(resp);
    const { aiFixes: af, pullRequests: prs, repos } = ctx.schema;
    const since = new Date(Date.now() - AUTO_FIX_TOAST_RECENT_MS);
    const rows = (await ctx.db
      .select({
        fixId: af.id,
        prId: af.prId,
        status: af.status,
        error: af.error,
        pushedAt: af.pushedAt,
        createdAt: af.createdAt,
        prNumber: prs.number,
        prTitle: prs.title,
        owner: repos.owner,
        name: repos.name,
      })
      .from(af)
      .innerJoin(prs, and(eq(prs.id, af.prId), eq(prs.accountId, af.accountId)))
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(
        and(
          eq(af.accountId, accountId),
          eq(af.trigger, 'auto'),
          inArray(af.repoId, [...scope.repoIds]),
          or(inArray(af.status, ['queued', 'running']), gte(af.finishedAt, since), gte(af.createdAt, since)),
        ),
      )
      .orderBy(desc(af.id))
      .limit(ACTIVE_MAX)
      .execute()) as Array<{
      fixId: number;
      prId: number;
      status: string;
      error: string | null;
      pushedAt: unknown;
      createdAt: unknown;
      prNumber: number;
      prTitle: string;
      owner: string;
      name: string;
    }>;
    resp.fixes = rows.map(
      (r): AutoFixActiveRow => ({
        fixId: r.fixId,
        prId: r.prId,
        prNumber: r.prNumber,
        prTitle: r.prTitle,
        repoFullName: `${r.owner}/${r.name}`,
        status: r.status as AiFixStatus,
        failed: failedOf(r.status, r.error),
        pushedAt: iso(r.pushedAt),
        createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
      }),
    );
    return reply.send(resp);
  });
}
