import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type {
  ReviewAction,
  ReviewActionsResponse,
  ReviewLearningKind,
  ReviewLearningsResponse,
  ClaudeReviewVerdict,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getPrLearningMatches } from './retrieval.js';

// WS3 UI-data endpoints. Both are accountId-scoped; the id-addressed one verifies
// ownership (→ 404 cross-account), mirroring the core query-layer IDOR guarantee.

function globOf(row: {
  dirPath: string | null;
  ext: string | null;
  path: string | null;
}): string | null {
  if (row.dirPath && row.dirPath !== '.') return `${row.dirPath}/*`;
  if (row.dirPath === '.') return '*';
  if (row.ext) return `*${row.ext}`;
  return row.path;
}

function tsToIso(v: Date | number | null | undefined): string {
  if (v == null) return new Date(0).toISOString();
  const d = v instanceof Date ? v : new Date(Number(v));
  return d.toISOString();
}

export function registerLearningRoutes(app: FastifyInstance, ctx: AgentContext): void {
  // Matches from past reviews for this PR's repo + touched paths (Surface 1).
  app.get<{ Params: { id: string } }>(
    '/api/pro/prs/:id/review-learnings',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const prId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(prId)) return reply.code(404).send({ error: 'not found' });
      const result = await getPrLearningMatches(ctx, accountId, prId);
      if (!result) return reply.code(404).send({ error: 'not found' });
      const resp: ReviewLearningsResponse = {
        enabled: true,
        matches: result.matches,
        contextBlock: result.contextBlock,
      };
      return reply.send(resp);
    },
  );

  // Per-review action log (Surface 2) — projection of review_learnings for one
  // source review. 404 if that review isn't the caller's.
  app.get<{ Params: { reviewId: string } }>(
    '/api/pro/claude-reviews/:reviewId/actions',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const reviewId = Number.parseInt(req.params.reviewId, 10);
      if (!Number.isInteger(reviewId))
        return reply.code(404).send({ error: 'not found' });

      // Ownership: the source review must belong to the caller.
      const crT = ctx.schema.claudeReviews;
      const owned = (await ctx.db
        .select()
        .from(crT)
        .where(and(eq(crT.id, reviewId), eq(crT.accountId, accountId)))
        .limit(1)
        .execute()) as Array<{ id: number }>;
      if (owned.length === 0) return reply.code(404).send({ error: 'not found' });

      const t = ctx.schema.reviewLearnings;
      const rows = (await ctx.db
        .select()
        .from(t)
        .where(and(eq(t.accountId, accountId), eq(t.sourceReviewId, reviewId)))
        .orderBy(desc(t.createdAt))
        .execute()) as Array<{
        id: number;
        kind: string;
        category: string | null;
        path: string | null;
        dirPath: string | null;
        ext: string | null;
        claudeText: string | null;
        userText: string | null;
        claudeVerdict: string | null;
        userVerdict: string | null;
        postedCommentKind: string | null;
        createdAt: Date | number | null;
      }>;

      const actions: ReviewAction[] = rows.map((r) => ({
        id: r.id,
        kind: r.kind as ReviewLearningKind,
        category: r.category,
        path: r.path,
        glob: globOf(r),
        claudeText: r.claudeText,
        userText: r.userText,
        claudeVerdict: (r.claudeVerdict as ClaudeReviewVerdict | null) ?? null,
        userVerdict: (r.userVerdict as ClaudeReviewVerdict | null) ?? null,
        postedCommentKind: r.postedCommentKind,
        createdAt: tsToIso(r.createdAt),
      }));

      const resp: ReviewActionsResponse = { actions };
      return reply.send(resp);
    },
  );
}
