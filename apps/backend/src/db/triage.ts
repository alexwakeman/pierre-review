import { inArray } from 'drizzle-orm';
import type {
  CiStatus,
  Mergeable,
  MergeStateStatus,
  NewSinceLastViewed,
  PrState,
  ReasonTag,
  ThreadStateCounts,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { getAccountUserId } from '../auth/account.js';

const { reviewRequests, prViews, events, reviews } = schema;

export interface TriagePrInput {
  id: number;
  state: PrState;
  authorId: number | null;
  ciStatus: CiStatus;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  isStalled: boolean;
  threadCounts: ThreadStateCounts;
}

export interface TriageResult {
  reasonTag: ReasonTag;
  reviewRequestedFromMe: boolean;
  // Count of other (user) reviewers also requested — for "also requested N".
  otherReviewersRequested: number;
  newSinceLastViewed: NewSinceLastViewed | null;
}

function emptyNew(): NewSinceLastViewed {
  return { commits: 0, comments: 0, reviews: 0 };
}

/** Per-author latest review state → is the PR approved with no blocking review? */
async function computeApprovedByPr(prIds: number[]): Promise<Set<number>> {
  const approved = new Set<number>();
  if (prIds.length === 0) return approved;
  const rows = await db
    .select({
      prId: reviews.prId,
      authorId: reviews.authorId,
      state: reviews.state,
      submittedAt: reviews.submittedAt,
    })
    .from(reviews)
    .where(inArray(reviews.prId, prIds))
    .execute();

  // latest review state per (pr, author), ignoring pure "commented" reviews.
  const latest = new Map<string, { state: string; at: number }>();
  for (const r of rows) {
    if (r.state !== 'approved' && r.state !== 'changes_requested') continue;
    const key = `${r.prId}:${r.authorId}`;
    const at = r.submittedAt.getTime();
    const prev = latest.get(key);
    if (!prev || at > prev.at) latest.set(key, { state: r.state, at });
  }

  const byPr = new Map<number, { approvals: number; blocks: number }>();
  for (const [key, v] of latest) {
    const prId = Number.parseInt(key.split(':')[0]!, 10);
    const entry = byPr.get(prId) ?? { approvals: 0, blocks: 0 };
    if (v.state === 'approved') entry.approvals += 1;
    else entry.blocks += 1;
    byPr.set(prId, entry);
  }
  for (const [prId, e] of byPr) {
    if (e.approvals > 0 && e.blocks === 0) approved.add(prId);
  }
  return approved;
}

/**
 * Compute triage fields (reason tag, review-requested-from-me, new-since
 * counts) for a batch of PRs. All supporting data is loaded in a handful of
 * batched queries — safe to call on the hot timeline path.
 */
export async function computeTriage(
  prs: TriagePrInput[],
  accountId: number,
): Promise<Map<number, TriageResult>> {
  const out = new Map<number, TriageResult>();
  const prIds = prs.map((p) => p.id);
  const localUserId = await getAccountUserId(accountId);

  // ---- review requests (user-type) by PR ----
  const reqByPr = new Map<number, { mine: boolean; others: number }>();
  if (prIds.length > 0) {
    const rows = await db
      .select({ prId: reviewRequests.prId, userId: reviewRequests.userId })
      .from(reviewRequests)
      .where(inArray(reviewRequests.prId, prIds))
      .execute();
    for (const r of rows) {
      if (r.userId == null) continue; // team requests don't map to "me"
      const entry = reqByPr.get(r.prId) ?? { mine: false, others: 0 };
      if (localUserId != null && r.userId === localUserId) entry.mine = true;
      else entry.others += 1;
      reqByPr.set(r.prId, entry);
    }
  }

  // ---- last-viewed per PR ----
  const viewedAtByPr = new Map<number, number>();
  if (prIds.length > 0) {
    const rows = await db
      .select({ prId: prViews.prId, lastViewedAt: prViews.lastViewedAt })
      .from(prViews)
      .where(inArray(prViews.prId, prIds))
      .execute();
    for (const r of rows) viewedAtByPr.set(r.prId, r.lastViewedAt.getTime());
  }

  // ---- events per PR (for new-since counts) ----
  const newByPr = new Map<number, NewSinceLastViewed>();
  if (prIds.length > 0 && viewedAtByPr.size > 0) {
    const rows = await db
      .select({
        prId: events.prId,
        type: events.type,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(inArray(events.prId, prIds))
      .execute();
    for (const r of rows) {
      if (r.prId == null) continue;
      const threshold = viewedAtByPr.get(r.prId);
      if (threshold == null) continue;
      if (r.occurredAt.getTime() <= threshold) continue;
      const n = newByPr.get(r.prId) ?? emptyNew();
      if (r.type === 'commit_pushed') n.commits += 1;
      else if (r.type === 'pr_comment' || r.type === 'review_comment')
        n.comments += 1;
      else if (r.type === 'review_submitted') n.reviews += 1;
      newByPr.set(r.prId, n);
    }
  }

  const approvedByPr = await computeApprovedByPr(prIds);

  for (const pr of prs) {
    const req = reqByPr.get(pr.id);
    const reviewRequestedFromMe = req?.mine ?? false;
    const otherReviewersRequested = req?.others ?? 0;

    // No "new" badges on closed/merged PRs — done is done.
    const newSinceLastViewed =
      pr.state === 'open' && viewedAtByPr.has(pr.id)
        ? (newByPr.get(pr.id) ?? emptyNew())
        : null;

    out.set(pr.id, {
      reviewRequestedFromMe,
      otherReviewersRequested,
      newSinceLastViewed,
      reasonTag: deriveReasonTag(pr, {
        reviewRequestedFromMe,
        localUserId,
        newComments: newSinceLastViewed?.comments ?? 0,
        approvedReady: approvedByPr.has(pr.id),
      }),
    });
  }
  return out;
}

function deriveReasonTag(
  pr: TriagePrInput,
  ctx: {
    reviewRequestedFromMe: boolean;
    localUserId: number | null;
    newComments: number;
    approvedReady: boolean;
  },
): ReasonTag {
  // The cascade only really applies to open PRs; closed/merged fall through to
  // the default.
  if (pr.state === 'open') {
    // Actionable-by-you reasons win — "awaiting your review" beats CI failing
    // because only you can clear it.
    if (ctx.reviewRequestedFromMe) return 'awaiting_your_review';
    if (
      ctx.localUserId != null &&
      pr.authorId === ctx.localUserId &&
      ctx.newComments > 0
    )
      return 'your_pr_new_comments';
    if (pr.ciStatus === 'failure' || pr.ciStatus === 'error')
      return 'ci_failing';
    if (pr.mergeable === 'conflicting' || pr.mergeStateStatus === 'dirty')
      return 'merge_conflicts';
    // CI is known-not-failing here (failing CI returned above).
    if (ctx.approvedReady && pr.mergeable === 'mergeable')
      return 'approved_ready';
    if (pr.isStalled) return 'stalled';
    if (pr.threadCounts.untouched > 0) return 'untouched_threads';
  }
  return 'in_progress';
}
