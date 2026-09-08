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

/** Where a reviewer currently stands on a PR. One value per reviewer, never a per-review log. */
export type ReviewerStanding = 'approved' | 'changes_requested' | 'dismissed' | 'commented';

export interface PrReviewerStanding {
  /** The reviewer's `users.id`, or null when GitHub gave us no author (a deleted account).
   *
   *  ⚠ NOTHING HERE RESOLVES BOT-NESS, ON PURPOSE. There is exactly ONE resolution in this app —
   *  a manual workspace judgement wins both directions, then `users.isBot`, then the login seeds a
   *  vendor — and the Pending board's payload builder already reuses it (the same union the
   *  Timeline's "hide bots" lens hides by). A second classifier here would type-check, pass a
   *  naive fixture, and put a vendor chip on someone the Timeline beside it calls a person. Ids
   *  out; identity is the caller's job.
   *
   *  ⚠ A null id is UNNAMEABLE but still COUNTED — see `computeReviewStandingsByPr`. */
  userId: number | null;
  standing: ReviewerStanding;
  /** When the review that SET this standing was filed — not the reviewer's latest activity.
   *  Pairing "approved" with the clock of a later drive-by comment prints "approved · 1h ago"
   *  over a five-day-old approval, which is a false claim about a person. A separate
   *  last-activity clock would be a separate field; there is no caller for one yet. */
  standingAt: Date;
}

export interface PrReviewStandings {
  /** EVERY reviewer who has submitted a non-pending review, newest standing first. Uncapped and
   *  un-collapsed: capping, bot-collapsing and ranking belong to the caller, because this fold is
   *  the single source of truth two surfaces (the card's chips and its approval count) both read.
   *  A cap applied here would silently move the count. */
  reviewers: PrReviewerStanding[];
  /** `reviewers.length`, carried so a caller that caps can still print "3 of 7" without having to
   *  remember it held the full list a moment ago. */
  total: number;
}

/** Tier of a review state for the standing pick — LOWER WINS, regardless of timestamp.
 *
 *  Tier 0 is the VERDICT tier and is the ONLY tier the approval count reads, which is what makes
 *  this rule a strict superset of its predecessor (below). Tiers 1 and 2 exist so a reviewer who
 *  never filed a verdict still appears on the card with an honest label instead of vanishing.
 *  A dismissal outranks a bare comment: it is a verdict-shaped fact about the review, and a
 *  reviewer who was dismissed and then commented has not gone back to saying nothing. */
function standingTier(state: string): 0 | 1 | 2 | null {
  if (state === 'approved' || state === 'changes_requested') return 0;
  if (state === 'dismissed') return 1;
  if (state === 'commented') return 2;
  // 'pending' — a review draft that was never submitted. Not a review; it says nothing about
  // where the reviewer stands, and showing it as one would name someone who has not spoken.
  return null;
}

/**
 * Per-PR reviewer standings: ONE indexed read of `reviews` over the given PR ids, grouped per
 * (pr, author) in memory.
 *
 * THE RULE — a reviewer's standing is their latest VERDICT (approved / changes_requested) if they
 * ever filed one; failing that their latest dismissal; failing that their latest comment.
 *
 * ⚠ THIS IS A STRICT SUPERSET OF THE OLD APPROVAL FOLD, BY CONSTRUCTION, AND HAS TO STAY ONE.
 * `approvals` is hashed into stored Pro work plans (`db/work-plan.ts` → `payloadHashFor`), so a
 * count that moves flips every stored plan on an affected workspace permanently `stale` and
 * re-bills it. The predecessor picked the latest row whose state was `approved` or
 * `changes_requested` and ignored every other row; tier 0 is that pick, unchanged, and tiers 1-2
 * can only add reviewers the old rule dropped entirely — reviewers who count for nothing. Pinned
 * in `triage-reviewers.test.ts`.
 *
 * ⚠ KNOWN DIVERGENCE FROM THE STANDING A HUMAN WOULD READ, KEPT DELIBERATELY: a reviewer who
 * approved and was LATER DISMISSED (a fresh review node whose state is DISMISSED, which is how
 * GitHub records a revoked approval) still reads `approved`, because tier 0 outranks tier 1
 * whatever the clock says. Demoting them would be the honest label — and would also drop the
 * approval, moving the hashed count. MEASURED on this repo's real data: 2 reviewer-PR pairs
 * account-wide, 1 of them on an open PR (sourcery-ai). So it is a decision to take with the hash
 * consequence in hand, not a patch: change the tier of `dismissed` to 0 and every stored plan on
 * an affected workspace re-bills.
 *
 * ⚠ A NULL `authorId` IS ONE PSEUDO-REVIEWER PER PR, AND IT COUNTS. `reviews.authorId` is
 * nullable (a deleted GitHub account), the old key was the string `${prId}:${authorId}`, so every
 * ghost review on a PR collapsed into one slot and its verdict counted toward `approvals`. Both
 * are preserved exactly. Zero such rows exist today, which is precisely why dropping them here
 * would look safe and would silently move a count the day one appears.
 *
 * COST: one indexed scan (`rv_pr_idx` on `pr_id`), the same query the predecessor ran with `id`
 * added to the select list — no second query, no per-PR fetch. Measured on real data: the 50
 * most-recently-updated open PRs carry 147 review rows and 45 reviewers (max 4 on one PR); the 50
 * BUSIEST open PRs carry 1,362 rows and 233 reviewers (max 10). The rows were always read; what
 * changed is that they are no longer thrown away.
 */
export async function computeReviewStandingsByPr(
  prIds: number[],
): Promise<Map<number, PrReviewStandings>> {
  const out = new Map<number, PrReviewStandings>();
  if (prIds.length === 0) return out;
  const rows = await db
    .select({
      id: reviews.id,
      prId: reviews.prId,
      authorId: reviews.authorId,
      state: reviews.state,
      submittedAt: reviews.submittedAt,
    })
    .from(reviews)
    .where(inArray(reviews.prId, prIds))
    .execute();

  // One winner per (pr, author). ⚠ The tiebreak is EXPLICIT — a later `submittedAt`, then the
  // higher `id` — because rows arrive in heap order, which on Postgres flips after any UPDATE to
  // the table. The predecessor's bare `>` handed a same-second tie to whichever row the heap
  // offered first, so the same PR could resolve two ways between two identical reads. Measured:
  // 35 (pr, author, submitted_at) ties exist in real data and NOT ONE disagrees on state, so
  // making this deterministic moves no count today — it just stops the day one would.
  const best = new Map<
    string,
    { prId: number; userId: number | null; tier: 0 | 1 | 2; state: string; at: Date; id: number }
  >();
  for (const r of rows) {
    const tier = standingTier(r.state);
    if (tier == null) continue;
    const key = `${r.prId}:${r.authorId}`;
    const prev = best.get(key);
    if (prev != null) {
      if (tier > prev.tier) continue;
      if (tier === prev.tier) {
        const dt = r.submittedAt.getTime() - prev.at.getTime();
        if (dt < 0 || (dt === 0 && r.id <= prev.id)) continue;
      }
    }
    best.set(key, {
      prId: r.prId,
      userId: r.authorId,
      tier,
      state: r.state,
      at: r.submittedAt,
      id: r.id,
    });
  }

  const byPr = new Map<number, PrReviewerStanding[]>();
  for (const v of best.values()) {
    const list = byPr.get(v.prId) ?? [];
    list.push({
      userId: v.userId,
      standing: v.state as ReviewerStanding,
      standingAt: v.at,
    });
    byPr.set(v.prId, list);
  }
  for (const [prId, list] of byPr) {
    // Deterministic for the same reason the tiebreak is: a card's chips must not reshuffle
    // because Postgres handed back the same rows in a different order. Newest standing first is
    // also the order a caller capping to three wants.
    list.sort(
      (a, b) => b.standingAt.getTime() - a.standingAt.getTime() || (a.userId ?? 0) - (b.userId ?? 0),
    );
    out.set(prId, { reviewers: list, total: list.length });
  }
  return out;
}

/**
 * The approval standing of a PR, folded from its reviewer list — the ONE place the counts come
 * from, so the chips on a card and the "approved by N" beside them cannot disagree. `dismissed`
 * and `commented` count as nothing, exactly as the predecessor's skipped rows did.
 */
export function approvalInfoFromStandings(standings: PrReviewStandings): ApprovalInfo {
  let approvals = 0;
  let blocks = 0;
  let latestApprovalAt: Date | null = null;
  for (const r of standings.reviewers) {
    if (r.standing === 'approved') {
      approvals += 1;
      if (!latestApprovalAt || r.standingAt.getTime() > latestApprovalAt.getTime()) {
        latestApprovalAt = r.standingAt;
      }
    } else if (r.standing === 'changes_requested') {
      blocks += 1;
    }
  }
  return {
    approved: approvals > 0 && blocks === 0,
    changesRequested: blocks > 0,
    approvals,
    latestApprovalAt,
  };
}

/**
 * Per-PR approval standing: at least one reviewer's standing decision is approved and none is
 * changes_requested. Drives the `approved_ready` reason tag, the green/red review outline on
 * timeline bars, the "your PR was approved" My Turn section and the Pro work plan's `approvals`.
 *
 * Now a projection of `computeReviewStandingsByPr` rather than a second fold over the same rows —
 * a caller wanting the reviewers as well should call that once and pass the result through
 * `approvalInfoFromStandings`, not run both.
 */
export async function computeApprovalInfoByPr(
  prIds: number[],
): Promise<Map<number, ApprovalInfo>> {
  const out = new Map<number, ApprovalInfo>();
  for (const [prId, standings] of await computeReviewStandingsByPr(prIds)) {
    const info = approvalInfoFromStandings(standings);
    // ⚠ THE EMISSION SET IS PRESERVED, not just the values. The predecessor built its map from
    // the decisive picks alone, so a PR whose only reviews are comments had NO ENTRY — not a
    // zeroed one. Every caller today reads `.get(id)?.field ?? default` and cannot tell, but a
    // future `.has()` could, and this fold is the one whose output is hashed.
    if (info.approvals === 0 && !info.changesRequested) continue;
    out.set(prId, info);
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
