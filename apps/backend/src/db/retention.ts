import { and, inArray, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db, runTransaction, schema } from './client.js';
import { config } from '../config.js';

// Time-based retention sweep. Per-account server data (events, PRs + their whole subtree)
// accumulates forever otherwise; this prunes anything past the retention window so the DB
// stays bounded (the pre-launch, tight-budget scalability lever). Runs periodically from
// the scheduler in BOTH deployment modes.
//
// THE ONE SAFE TTL KEY is `pullRequests.updatedAt < cutoff`, and we delete the WHOLE PR
// subtree anchored to that. Two load-bearing reasons:
//  1. Idempotency: the incremental sync re-walks a window ending at `lastIncremental −
//     overlap` (~20 min) and a forced full sync re-walks `now − backfillDays`. A PR whose
//     updatedAt is beyond the (clamped ≥ backfillDays) cutoff is outside BOTH windows, so
//     it is never re-fetched → stays deleted. Keying on a CHILD's own timestamp instead
//     (an old commit/event on a still-recent PR) would let the next sync re-create it →
//     churn. So we anchor everything to the parent PR's recency.
//  2. FK integrity: there is NO `ON DELETE CASCADE` anywhere (FKs ARE enforced), so the
//     subtree is deleted manually, parent-last, in a transaction — mirroring deleteRepo.

const {
  events,
  ciStatusEvents,
  reviewComments,
  reviewThreads,
  prComments,
  reviews,
  commits,
  reviewRequests,
  prViews,
  myTurnDismissals,
  claudeReviews,
  claudeReviewFindings,
  pullRequests,
} = schema;

// A plugin-owned retention hook: @pierre/pro registers one (via ctx.registerRetention →
// bind.ts) to prune ITS OWN tables (ai_fixes etc.) for the PR ids the core sweep deletes —
// core can't name plugin tables (open-core boundary). Empty in OSS.
export type RetentionHandler = (args: { prIds: number[] }) => Promise<void> | void;
const retentionHandlers: RetentionHandler[] = [];
export function registerRetentionHandler(h: RetentionHandler): void {
  retentionHandlers.push(h);
}

// Batch size for the delete — bounds each transaction + the IN-clause size on both dialects.
const BATCH = 500;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Delete a batch of PRs and everything hanging off them, FK-safe order (children before
// parents — the exact order deleteRepo uses). `tx` is the dialect-aware transaction executor.
async function deletePrSubtree(
  tx: Parameters<Parameters<typeof runTransaction>[0]>[0],
  prIds: number[],
): Promise<void> {
  await tx.delete(events).where(inArray(events.prId, prIds)).execute();
  // CI status history FKs pull_requests with ON DELETE no action (migrations 0022 / pg
  // 0011) — it MUST go before the pullRequests delete below or the sweep FK-fails.
  await tx.delete(ciStatusEvents).where(inArray(ciStatusEvents.prId, prIds)).execute();
  await tx.delete(reviewComments).where(inArray(reviewComments.prId, prIds)).execute();
  await tx.delete(reviewThreads).where(inArray(reviewThreads.prId, prIds)).execute();
  await tx.delete(prComments).where(inArray(prComments.prId, prIds)).execute();
  await tx.delete(reviews).where(inArray(reviews.prId, prIds)).execute();
  await tx.delete(commits).where(inArray(commits.prId, prIds)).execute();
  await tx.delete(reviewRequests).where(inArray(reviewRequests.prId, prIds)).execute();
  await tx.delete(prViews).where(inArray(prViews.prId, prIds)).execute();
  // PR-keyed my-turn dismissals (review_request / watched_repo_pr) would be left as inert
  // orphans. refId is a GLOBAL id (no accountId needed here — a maintenance sweep across
  // all accounts), so scope by kind + refId only.
  await tx
    .delete(myTurnDismissals)
    .where(
      and(
        inArray(myTurnDismissals.kind, ['review_request', 'watched_repo_pr']),
        inArray(myTurnDismissals.refId, prIds),
      ),
    )
    .execute();
  // Claude review runs + findings FK these PRs — clear findings (via reviewId) then runs.
  const reviewIdRows = await tx
    .select({ id: claudeReviews.id })
    .from(claudeReviews)
    .where(inArray(claudeReviews.prId, prIds))
    .execute();
  const reviewIds = reviewIdRows.map((r) => r.id);
  if (reviewIds.length > 0) {
    await tx
      .delete(claudeReviewFindings)
      .where(inArray(claudeReviewFindings.reviewId, reviewIds))
      .execute();
  }
  await tx.delete(claudeReviews).where(inArray(claudeReviews.prId, prIds)).execute();
  await tx.delete(pullRequests).where(inArray(pullRequests.id, prIds)).execute();
  // NB: commitFiles is GLOBAL (sha-keyed, shared across PRs/tenants) — deliberately NOT
  // pruned here. users + syncState are likewise out of scope.
}

// Prune every PR (and subtree) older than the retention window. `retentionDays` defaults
// to config; a test can pass a value. Returns the number of PRs pruned. No-op when
// retention is disabled (days <= 0).
export async function pruneOldData(
  log: FastifyBaseLogger,
  retentionDays: number = config.retentionDays,
): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0;
  // Clamp to the backfill window so a forced full sync can't resurrect a deleted PR.
  const effDays = Math.max(retentionDays, config.backfillDays);
  const cutoff = new Date(Date.now() - effDays * 24 * 60 * 60 * 1000);

  const oldRows = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(lt(pullRequests.updatedAt, cutoff))
    .execute();
  const prIds = oldRows.map((r) => r.id);
  if (prIds.length === 0) return 0;

  let pruned = 0;
  for (const batch of chunk(prIds, BATCH)) {
    await runTransaction(async (tx) => {
      await deletePrSubtree(tx, batch);
    });
    // Prune plugin-owned tables for these PRs (outside the core tx — the plugin owns its
    // own transactions; a plugin failure must not roll back the core delete). Best-effort.
    for (const h of retentionHandlers) {
      try {
        await h({ prIds: batch });
      } catch (err) {
        log.warn({ err }, 'retention: pro handler failed for a batch');
      }
    }
    pruned += batch.length;
  }
  log.info(`retention: pruned ${pruned} PR(s) older than ${effDays}d`);
  return pruned;
}
