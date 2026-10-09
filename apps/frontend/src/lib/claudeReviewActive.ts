import type { ActiveReview } from '@pierre-review/shared';

// ── "A REVIEW STARTED OR FINISHED SOMEWHERE": TRANSITIONS OF THE ACTIVE LIST ─────────────────
//
// `['claude-review', prId]` is DB-only and had no refetch path when a run started or ended away
// from its own tab (an auto review, a run started from the Open PRs table or another PR tab): the
// SSE `done` lives inside ClaudeReviewTab, and the tab label's pill only polled when its CACHED
// copy already showed a run. So a pill read "Approve" over a re-review that had been running for
// minutes, and caught up only when the tab was opened.
//
// The fix reads the ONE list the app already polls (`GET /api/claude-reviews/active`, which holds
// manual AND auto runs, queued and running) and, in ONE place (`useClaudeReviewActiveSync`, mounted
// once in App), invalidates each PR whose entry appeared, changed or disappeared. One request per
// poll whatever the number of PRs; nothing is fetched per card.

/** One PR's entry in the active list, reduced to what marks a transition. A queued auto item has
 *  no `reviewId` until it starts, so null → id is a change too. */
export function activeReviewSignatures(reviews: readonly ActiveReview[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of reviews) {
    const sig = `${r.reviewId ?? '-'}:${r.status}`;
    // Two entries for one PR (a waiting auto item beside a running manual one): keep both halves.
    const prev = out.get(r.prId);
    out.set(r.prId, prev == null ? sig : [prev, sig].sort().join('|'));
  }
  return out;
}

/** The PRs whose active-list entry appeared, changed or disappeared between two polls. `prev`
 *  null is the first poll: nothing is known to have moved, so nothing is reported. */
export function changedActivePrIds(
  prev: ReadonlyMap<number, string> | null,
  next: ReadonlyMap<number, string>,
): number[] {
  if (prev == null) return [];
  const out: number[] = [];
  for (const [prId, sig] of next) if (prev.get(prId) !== sig) out.push(prId);
  for (const prId of prev.keys()) if (!next.has(prId)) out.push(prId);
  return out.sort((a, b) => a - b);
}

/** Is this PR in the active list (queued or running, manual or auto)? */
export function prHasActiveReview(reviews: readonly ActiveReview[] | undefined, prId: number): boolean {
  return reviews?.some((r) => r.prId === prId) ?? false;
}
