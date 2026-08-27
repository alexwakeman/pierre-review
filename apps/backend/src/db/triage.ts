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
  // Standing review state (≥1 approving reviewer & none blocking → isApproved; any
  // blocking changes_requested → isChangesRequested), independent of CI/mergeability —
  // distinct from the `approved_ready` reason tag, which also requires the PR to be
  // mergeable. Drive the green / red review-status outline on open timeline bars.
  isApproved: boolean;
  isChangesRequested: boolean;
  newSinceLastViewed: NewSinceLastViewed | null;
}

// The merge-state values that mean "GitHub would let this land right now". Mirrors the
// `canMerge` half of the frontend's `mergeVerdict()` resolver (lib/ui.ts) — the two must
// agree, or a PR reads "approved & ready" in the triage queue and "blocked" on the PR itself.
export const READY_MERGE_STATES: ReadonlySet<MergeStateStatus> = new Set<MergeStateStatus>([
  'clean',
  'has_hooks',
  'unstable',
]);

function emptyNew(): NewSinceLastViewed {
  return { commits: 0, comments: 0, reviews: 0 };
}

// Per-PR approval standing, derived from each reviewer's LATEST decisive review.
export interface ApprovalInfo {
  // approvals > 0 AND no outstanding changes-requested (the "approved" condition).
  approved: boolean;
  // At least one reviewer's standing decision is "changes_requested" (blocking).
  // Mutually exclusive with `approved` (a single block flips approved → false).
  changesRequested: boolean;
  // How many distinct reviewers' standing decision is "approved".
  approvals: number;
  // Timestamp of the most recent standing approval (for "new since dismissed"
  // comparisons); null when there are no approving reviews.
  latestApprovalAt: Date | null;
}

/**
 * Per-author latest review state → per-PR approval standing. A reviewer's standing
 * decision is their latest non-"commented" review (approved / changes_requested);
 * a PR is "approved" when at least one reviewer's standing decision is approved and
 * none is changes_requested. Used both for the `approved_ready` reason tag and the
 * "your PR was approved" My Turn section.
 */
export async function computeApprovalInfoByPr(
  prIds: number[],
): Promise<Map<number, ApprovalInfo>> {
  const out = new Map<number, ApprovalInfo>();
  if (prIds.length === 0) return out;
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
  const latest = new Map<string, { prId: number; state: string; at: Date }>();
  for (const r of rows) {
    if (r.state !== 'approved' && r.state !== 'changes_requested') continue;
    const key = `${r.prId}:${r.authorId}`;
    const prev = latest.get(key);
    if (!prev || r.submittedAt.getTime() > prev.at.getTime()) {
      latest.set(key, { prId: r.prId, state: r.state, at: r.submittedAt });
    }
  }

  const byPr = new Map<
    number,
    { approvals: number; blocks: number; latestApprovalAt: Date | null }
  >();
  for (const v of latest.values()) {
    const entry =
      byPr.get(v.prId) ?? { approvals: 0, blocks: 0, latestApprovalAt: null };
    if (v.state === 'approved') {
      entry.approvals += 1;
      if (!entry.latestApprovalAt || v.at.getTime() > entry.latestApprovalAt.getTime()) {
        entry.latestApprovalAt = v.at;
      }
    } else {
      entry.blocks += 1;
    }
    byPr.set(v.prId, entry);
  }
  for (const [prId, e] of byPr) {
    out.set(prId, {
      approved: e.approvals > 0 && e.blocks === 0,
      changesRequested: e.blocks > 0,
      approvals: e.approvals,
      latestApprovalAt: e.latestApprovalAt,
    });
  }
  return out;
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
      // A null userId means the request went to a GITHUB team — a group of people on GitHub,
      // NOT one of this app's workspaces — so it names no single person and can't be "me".
      if (r.userId == null) continue;
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

  const approvalByPr = await computeApprovalInfoByPr(prIds);

  for (const pr of prs) {
    const req = reqByPr.get(pr.id);
    const reviewRequestedFromMe = req?.mine ?? false;
    const otherReviewersRequested = req?.others ?? 0;
    const approval = approvalByPr.get(pr.id);

    // No "new" badges on closed/merged PRs — done is done.
    const newSinceLastViewed =
      pr.state === 'open' && viewedAtByPr.has(pr.id)
        ? (newByPr.get(pr.id) ?? emptyNew())
        : null;

    out.set(pr.id, {
      reviewRequestedFromMe,
      otherReviewersRequested,
      isApproved: approval?.approved ?? false,
      isChangesRequested: approval?.changesRequested ?? false,
      newSinceLastViewed,
      reasonTag: deriveReasonTag(pr, {
        reviewRequestedFromMe,
        localUserId,
        newComments: newSinceLastViewed?.comments ?? 0,
        approvedReady: approval?.approved ?? false,
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
    //
    // `mergeable` ONLY reports merge-CONFLICT state (MERGEABLE / CONFLICTING / UNKNOWN) — it
    // says nothing about branch protection. Testing it alone tagged PRs "approved & ready"
    // while their REQUIRED checks were red or a second required review was outstanding, which
    // is the same blindness the merge surfaces had. `mergeStateStatus` is the protection-aware
    // field, so gate on it too:
    //   clean      — mergeable and passing
    //   has_hooks  — mergeable, just has a pre-receive hook to run
    //   unstable   — NON-required checks are red; GitHub will still merge it, so it IS ready
    // Everything else (blocked / behind / dirty / unknown) is not ready by definition.
    if (
      ctx.approvedReady &&
      pr.mergeable === 'mergeable' &&
      READY_MERGE_STATES.has(pr.mergeStateStatus)
    )
      return 'approved_ready';
    if (pr.isStalled) return 'stalled';
    if (pr.threadCounts.untouched > 0) return 'untouched_threads';
  }
  return 'in_progress';
}
