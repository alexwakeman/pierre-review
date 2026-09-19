import type {
  DependencyBumpCard,
  DependencyPrState,
  InsightCard,
  MyTurnCard,
  MyTurnCardReason,
  MyTurnTrunkCard,
  ReviewerRole,
  SecurityAlertSource,
  SecurityCard,
} from '@pierre-review/shared';

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
  // The Dependencies tab's two kinds, named as its chips name them. The CARD says which security
  // item it is (`cardKindLabel`: a fix, or an alert), because the chip counts both.
  security: 'Security',
  dependency_bump: 'Bumps',
};

/**
 * What THIS card is called, as opposed to what its kind is called. THREE labels for `my_turn`,
 * off `MyTurnCard.relevance`, because the boolean it replaced conflated two different
 * relationships:
 *
 *   'direct'     → "Your turn"      — you authored it, you were asked for the review, your
 *                                     thread or comment got a reply, your Claude run finished, you
 *                                     were @-mentioned (even in a repo you only read), or you
 *                                     added its type in Settings → My Turn.
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
    // A type the reader ADDED to My Turn (Settings → Add to My Turn), in a muted repo: the neutral
    // KIND label says "Review or reply", which is never true of a branch, a failing build, a
    // conflict or a PR that is ready. Name what it is instead — as its home tab names it.
    switch (card.reason) {
      case 'trunk_red':
        return 'Trunk CI failing';
      case 'own_ci_red':
        return 'CI failing on your PR';
      case 'own_conflicts':
        return KIND_LABEL.conflicts;
      case 'own_ready':
        return card.own?.kind === 'ready' ? KIND_LABEL[card.own.forward] : KIND_LABEL.merge;
      case 'own_thread':
        return KIND_LABEL.untouched_thread;
      default:
        return KIND_LABEL.my_turn;
    }
  }
  // The ci_failing arms are the same distinction one layer over: 'your_pr' is a claim of
  // AUTHORSHIP, 'trunk' a claim about your patch of ground. The server only ever emits a card the
  // viewer is on the hook for, so both labels are true — they just are not the same summons.
  if (card.kind === 'ci_failing') {
    return card.arm === 'your_pr' ? 'CI failing on your PR' : 'Trunk CI failing';
  }
  // Not an ownership claim either — what the card IS. A fix PR carries the tool's own security
  // marker; an alert is a security tool flagging a PR that may be anybody's. ⚠ An INFERRED fix
  // (Dependabot's grouping, the confirming line cut off) is headed as what is known — never
  // "Security fix" above a card that cannot back it. Why it is only likely lives in the popover.
  if (card.kind === 'security') {
    return card.fix === 'proven'
      ? 'Security fix'
      : card.fix === 'inferred'
        ? 'Likely security fix'
        : 'Security alert';
  }
  if (card.kind === 'dependency_bump') return 'Dependency update';
  return KIND_LABEL[card.kind];
}

/**
 * THE BYLINE CHIP FOR AUTOMATION WITH NO BRAND — what it does, when we cannot say who it is. ONE
 * spelling, read by the card byline and the guide. A branded tool is named by its vendor label
 * instead (`automatedReviewerMeta`), never by this.
 */
export const AUTHOR_ROLE_CHIP: Record<ReviewerRole, string> = {
  dependency: 'Dependency bot',
  code_agent: 'Coding agent',
  release: 'Release bot',
  housekeeping: 'Housekeeping bot',
  quality_check: 'CI bot',
  review: 'Review bot',
};

/**
 * A Dependencies card's state chip. `null` says nothing, on purpose: `conflicts` and `needs_review`
 * because the card's sentence already says it ("Conflicts with main", "Needs an approving review" —
 * and the review row above says "GitHub: review required"), `ci_red` because the meta row's CI dot
 * says "CI failing" a line above (the card prints no state line for it at all), and `unknown`
 * because GitHub has not worked the merge state out, and a state nobody observed is not a fact to
 * print. Total, so a new state forces a decision here.
 */
export const DEP_STATE_LABEL: Record<DependencyPrState, string | null> = {
  ready: 'Ready to merge',
  behind: 'Behind trunk',
  conflicts: null,
  ci_red: null,
  needs_review: null,
  blocked: 'Blocked',
  unknown: null,
};

/**
 * A Dependencies card's state SENTENCE, or null to print none. `ci_red` prints none: the meta row's
 * CI dot already says "CI failing", and a chip-less "CI is failing" under it said it twice. (The
 * server keeps the sentence — the ranker's reason reads it.)
 */
export function depStateSentence(card: SecurityCard | DependencyBumpCard): string | null {
  if (card.depState === 'ci_red') return null;
  const s = card.kind === 'security' ? card.stateDetail : card.detail;
  return s != null && s !== '' ? s : null;
}

/** Which tool raised a live security alert, by name. `reviewer` is absent: that alert is named by
 *  its author's vendor (or login), because "a reviewer flagged…" names nobody. */
export const SECURITY_ALERT_SOURCE_LABEL: Record<Exclude<SecurityAlertSource, 'reviewer'>, string> = {
  socket: 'Socket',
  dependency_review: 'Dependency Review',
  endor: 'Endor Labs',
  semgrep: 'Semgrep',
  code_scanning: 'Code scanning',
  snyk: 'Snyk',
  frogbot: 'Frogbot',
  checkmarx: 'Checkmarx',
};

// WHICH My Turn type put this card on your plate — the card's chip. ⚠ Keyed on
// `MyTurnCardReason` (the fifteen types of GET /api/my-turn and Settings → My Turn), NOT the older
// `MyTurnReason` participation union that lib/ui.ts's MY_TURN_REASON_META covers — they are one
// `sed` apart and mean opposite things. Settings names the same types in longer words
// (`MY_TURN_SETTING_LABEL`); this is the short form a chip can carry.
export const MY_TURN_REASON_LABEL: Record<MyTurnCardReason, string> = {
  review_request: 'Review requested',
  mention: 'Mentioned',
  thread: 'Reply needed',
  thread_reply: 'Reply to you',
  comment_reply: 'Comment after yours',
  pushed_since: 'Pushed since',
  own_ci_red: 'Build failed',
  own_conflicts: 'Merge conflicts',
  trunk_red: 'Trunk red',
  pr_approved: 'Approved',
  own_ready: 'Ready to land',
  your_pr: 'Your PR',
  own_thread: 'Unanswered thread',
  claude_review: 'Claude review',
  watched_repo_pr: 'New PR',
};

/**
 * THE TYPE CHIP. `reason` names the type that emitted the row; the chip says it, with one
 * refinement: a promoted "ready to land" card says WHICH kind of ready — "Ready to merge" or
 * "Behind trunk", the words its home tab uses — because the two ask for different clicks.
 *
 * "Pushed since" used to be a second reading of `watched_repo_pr` (off `ball.kind`). It is its own
 * type now (`pushed_since`, with its own switch in Settings), so the chip is the map and nothing
 * here has to guess.
 */
export function myTurnReasonLabel(card: MyTurnCard | MyTurnTrunkCard): string {
  if (card.reason === 'own_ready' && card.own?.kind === 'ready') return KIND_LABEL[card.own.forward];
  return MY_TURN_REASON_LABEL[card.reason];
}
