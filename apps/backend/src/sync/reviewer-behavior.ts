// WS1d — behavioral signals for the reviewer classifier (CORE, deterministic, NO AI).
//
// Computes per-(account, user) distributions from EXISTING synced data —
// `reviews.submittedAt`, `commits.committedAt`, review threads + comments — that
// characterise an automated reviewer: it reviews within seconds of a push, once per PR,
// posts many inline comments, and almost never engages in a threaded back-and-forth.
// These NEVER solo-trigger a badge; they feed the MEDIUM band in reviewer-classify.ts.
//
// All queries are account-scoped (reviews/comments/threads reach the account
// transitively via prId → pull_requests.accountId). Portable async terminals only.
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

const { reviews, commits, reviewThreads, reviewComments, pullRequests } = schema;

export interface BehavioralSignals {
  // How many reviews this user has authored in the account (the sample size — the
  // classifier ignores the behavioral band below 3).
  reviews: number;
  // Median minutes from the most-recent preceding commit to a review (null if no
  // review had a prior commit to measure against). Sub-2-min is a strong bot tell.
  medianPushToReviewMins: number | null;
  // Reviews per distinct PR reviewed (~1 for a bot that reviews each PR once).
  reviewsPerPr: number | null;
  // Of threads this user ORIGINATED, the share where they posted a follow-up comment
  // (≥2 of their own) — bots rarely reply. null when they originated no threads.
  replyRate: number | null;
  // Inline review comments authored per review (high for a bot that annotates every
  // finding). null when they authored no reviews.
  commentsPerReview: number | null;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export async function computeBehavioralSignals(
  accountId: number,
  userId: number,
): Promise<BehavioralSignals> {
  const revRows = await db
    .select({ prId: reviews.prId, submittedAt: reviews.submittedAt })
    .from(reviews)
    .innerJoin(pullRequests, eq(reviews.prId, pullRequests.id))
    .where(and(eq(pullRequests.accountId, accountId), eq(reviews.authorId, userId)))
    .execute();

  const reviewCount = revRows.length;
  const signals: BehavioralSignals = {
    reviews: reviewCount,
    medianPushToReviewMins: null,
    reviewsPerPr: null,
    replyRate: null,
    commentsPerReview: null,
  };
  if (reviewCount === 0) return signals;

  const prIds = [...new Set(revRows.map((r) => r.prId))];
  signals.reviewsPerPr = reviewCount / prIds.length;

  // Median push→review latency: per review, the gap to the latest commit on that PR
  // committed at/before the review.
  const commitRows = await db
    .select({ prId: commits.prId, committedAt: commits.committedAt })
    .from(commits)
    .where(inArray(commits.prId, prIds))
    .execute();
  const commitsByPr = new Map<number, number[]>();
  for (const c of commitRows) {
    const arr = commitsByPr.get(c.prId) ?? [];
    arr.push(c.committedAt.getTime());
    commitsByPr.set(c.prId, arr);
  }
  const gaps: number[] = [];
  for (const r of revRows) {
    const arr = commitsByPr.get(r.prId);
    if (!arr) continue;
    const rt = r.submittedAt.getTime();
    let prev: number | null = null;
    for (const ct of arr) {
      if (ct <= rt && (prev === null || ct > prev)) prev = ct;
    }
    if (prev !== null) gaps.push((rt - prev) / 60000);
  }
  if (gaps.length > 0) signals.medianPushToReviewMins = median(gaps);

  // Reply engagement over threads this user originated.
  const threadRows = await db
    .select({ id: reviewThreads.id })
    .from(reviewThreads)
    .innerJoin(pullRequests, eq(reviewThreads.prId, pullRequests.id))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(reviewThreads.originalCommenterId, userId),
      ),
    )
    .execute();
  const originatedThreadIds = threadRows.map((t) => t.id);
  if (originatedThreadIds.length > 0) {
    // threadIds are already account-scoped, so no join needed here.
    const ownComments = await db
      .select({ threadId: reviewComments.threadId })
      .from(reviewComments)
      .where(
        and(
          eq(reviewComments.authorId, userId),
          inArray(reviewComments.threadId, originatedThreadIds),
        ),
      )
      .execute();
    const perThread = new Map<number, number>();
    for (const c of ownComments) {
      perThread.set(c.threadId, (perThread.get(c.threadId) ?? 0) + 1);
    }
    let replied = 0;
    for (const id of originatedThreadIds) {
      if ((perThread.get(id) ?? 0) >= 2) replied++;
    }
    signals.replyRate = replied / originatedThreadIds.length;
  }

  // Comments per review.
  const commentRows = await db
    .select({ id: reviewComments.id })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(reviewComments.prId, pullRequests.id))
    .where(
      and(eq(pullRequests.accountId, accountId), eq(reviewComments.authorId, userId)),
    )
    .execute();
  signals.commentsPerReview = commentRows.length / reviewCount;

  return signals;
}
