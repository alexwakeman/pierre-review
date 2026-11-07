import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { PrPushSummary } from '@pierre-review/shared';
import { db } from './client.js';
import { claudeReviews, pullRequests } from './schema.sqlite.js';

// THE ONE READER of the stored push summaries (docs/CLAUDE-REVIEW.md § Push summaries): the PR
// Activity tab's route (api/routes/push-summaries.ts) and the Feed's commit runs (db/queries.ts).
// Only SUCCEEDED FULL reviews (`kind IS NULL`) carry one. Every row is returned, oldest first; the
// shared `newestPushSummaryPerHead` keeps one per head (a pair writes two).

/** Every stored push summary on these PRs, by PR, oldest first. */
export async function getPushSummariesForPrs(
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, PrPushSummary[]>> {
  const out = new Map<number, PrPushSummary[]>();
  if (prIds.length === 0) return out;
  const rows = await db
    .select({
      id: claudeReviews.id,
      prId: claudeReviews.prId,
      headSha: claudeReviews.headSha,
      fromSha: claudeReviews.pushSummaryFromSha,
      text: claudeReviews.pushSummary,
      finishedAt: claudeReviews.finishedAt,
      createdAt: claudeReviews.createdAt,
    })
    .from(claudeReviews)
    .where(
      and(
        eq(claudeReviews.accountId, accountId),
        inArray(claudeReviews.prId, [...new Set(prIds)]),
        eq(claudeReviews.status, 'succeeded'),
        isNull(claudeReviews.kind),
        isNotNull(claudeReviews.pushSummary),
      ),
    )
    .orderBy(asc(claudeReviews.id))
    .execute();
  for (const r of rows) {
    if (!r.text) continue;
    const at = (r.finishedAt ?? r.createdAt) as Date;
    const arr = out.get(r.prId) ?? [];
    arr.push({ reviewId: r.id, fromSha: r.fromSha ?? null, toSha: r.headSha, text: r.text, at: at.toISOString() });
    out.set(r.prId, arr);
  }
  return out;
}

/** One PR's push summaries, oldest first; null when the PR is not this account's (→ 404). */
export async function getPrPushSummaries(prId: number, accountId: number): Promise<PrPushSummary[] | null> {
  const owned = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
    .limit(1)
    .execute();
  if (owned.length === 0) return null;
  return (await getPushSummariesForPrs(accountId, [prId])).get(prId) ?? [];
}
