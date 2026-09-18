import type { InsightCard, MyTurnCard, MyTurnCardReason } from '@pierre-review/shared';

// WHAT THE PENDING BOARD CALLS THINGS — the kind labels and the per-card ownership label, moved
// out of AttentionCards.tsx so the board's info popovers (pendingExplain.ts) can name a card
// exactly as the card names itself, without an import cycle. AttentionCards re-exports both.

// Exported because the isolation banner names the isolated kind with it — one spelling of "what
// this kind is called", so the banner and the card header can never disagree.
//
// ⚠ `my_turn` IS NOT LABELLED "Your turn" HERE, and that is the whole semantic split. The KIND
// means "this needs a review or reply" — of the 149 such cards on the reporting account, 5 were
// actually theirs. Naming the kind after the narrow case made the board claim ownership of work
// belonging to people who had never touched the repo ("50+ items awaiting YOUR review" in a
// project they are not a contributor to). The kind stays neutral; the OWNERSHIP claim is made
// per card, off `relevance`, by `cardKindLabel` below. See docs/FRONTEND.md § "Per-workspace
// 'My Turn'".
export const KIND_LABEL: Record<InsightCard['kind'], string> = {
  my_turn: 'Review or reply',
  // Neutral at the KIND level, like my_turn: the ownership claim ("your PR" vs "trunk in a repo
  // you maintain") is made per card by `cardKindLabel`, off the card's own `arm`.
  ci_failing: 'CI failing',
  bot_signal: 'Review-bot signal',
  bot_only_review: 'Only a bot reviewed',
  stalled_review: 'Stalled review',
  untouched_thread: 'Untouched thread',
  reviewer_load: 'Review load',
  reviewer_routing: 'Needs a reviewer',
  // The two FORWARD kinds — something that is READY rather than something that is wrong. Neutral
  // at the kind level like the rest; `cardKindLabel` is deliberately NOT extended for them,
  // because neither makes an ownership claim to soften.
  merge: 'Ready to merge',
  update_branch: 'Behind trunk',
  // ⚠ ONE SPELLING. `REASON_META.merge_conflicts.label` in lib/ui.ts is already 'Merge conflicts';
  // do not mint a third ('Conflicting', 'Needs a rebase'). And `cardKindLabel` is deliberately NOT
  // extended for this kind — that function softens OWNERSHIP claims, and this one claims nothing
  // about the reader.
  conflicts: 'Merge conflicts',
};

/**
 * What THIS card is called, as opposed to what its kind is called. THREE labels for `my_turn`,
 * off `MyTurnCard.relevance`, because the boolean it replaced conflated two different
 * relationships:
 *
 *   'direct'     → "Your turn"      — you authored it, you were asked for the review, your
 *                                     thread got a reply, your Claude run finished, or you were
 *                                     @-mentioned (even in a repo you only read).
 *   'maintained' → "In your repos"  — somebody else opened a PR in a repo you maintain. That is
 *                                     ORBIT, not ownership: nobody named you, and calling it
 *                                     "Your turn" is precisely the over-claim the reporter
 *                                     objected to ("work on repos" vs "work tied to me directly
 *                                     through authorship, reply or merge").
 *   'none'       → the neutral KIND label ("Review or reply") — work that needs *someone*.
 *
 * ⚠ AN ABSENT `relevance` RENDERS THE NEUTRAL LABEL, and so does an absent-but-`personal: true`
 * card. That is the opposite of the wire's tolerance rule (absent ⇒ personal, because
 * over-notifying is the safe direction) and it is deliberate: a missing field may never invent an
 * ownership claim ON SCREEN. The only way to see it is a server too old to send the field — where
 * the neutral label is still true, and the notification surfaces (which read `personal`) keep
 * their safe direction independently.
 */
export function cardKindLabel(card: InsightCard): string {
  if (card.kind === 'my_turn') {
    if (card.relevance === 'direct') return 'Your turn';
    if (card.relevance === 'maintained') return 'In your repos';
    return KIND_LABEL.my_turn;
  }
  // The ci_failing arms are the same distinction one layer over: 'your_pr' is a claim of
  // AUTHORSHIP, 'trunk' a claim about your patch of ground. The server only ever emits a card the
  // viewer is on the hook for, so both labels are true — they just are not the same summons.
  if (card.kind === 'ci_failing') {
    return card.arm === 'your_pr' ? 'CI failing on your PR' : 'Trunk CI failing';
  }
  return KIND_LABEL[card.kind];
}

// WHICH My Turn section put this card on your plate. ⚠ Keyed on `MyTurnCardReason` (the six
// sections of GET /api/my-turn), NOT the older `MyTurnReason` participation union that
// lib/ui.ts's MY_TURN_REASON_META covers — they are one `sed` apart and mean opposite things.
export const MY_TURN_REASON_LABEL: Record<MyTurnCardReason, string> = {
  review_request: 'Review requested',
  thread: 'Reply needed',
  pr_approved: 'Approved',
  your_pr: 'Your PR',
  watched_repo_pr: 'New PR',
  claude_review: 'Claude review',
};

/**
 * THE SECTION CHIP. `reason` names the SECTION that emitted the row, which is not always what the
 * reader is being asked to do about it — and on one section those two came apart on screen.
 *
 * ⚠ `watched_repo_pr` NOW HOLDS TWO DIFFERENT FACTS. Since the ball rule, a row survives that
 * section either because you have never touched the PR (`ball.kind === 'untouched'`) or because a
 * person pushed after you last acted (`'commits_after'`). The static map calls both "New PR", so a
 * PR you approved three days ago wore the chip "New PR" immediately beside the detail "You
 * approved · @robin-dunn pushed 2 commits since" — the card contradicting itself in two adjacent
 * elements, which is the same class of defect as the card that could not explain why it was there
 * at all.
 *
 * ⚠ AN ABSENT `ball` FALLS BACK TO THE SECTION LABEL, never to a guess. The field is
 * trailing-optional for wire tolerance, and a response predating it must not have "Pushed since"
 * invented over a PR nobody has touched — the safe direction is the older, vaguer word.
 */
export function myTurnReasonLabel(card: MyTurnCard): string {
  if (card.reason === 'watched_repo_pr' && card.ball?.kind === 'commits_after') {
    return 'Pushed since';
  }
  return MY_TURN_REASON_LABEL[card.reason];
}
