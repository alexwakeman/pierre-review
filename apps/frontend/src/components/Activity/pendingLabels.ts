import type {
  DependencyBumpCard,
  DependencyPrState,
  InsightCard,
  InsightPrRef,
  MergeQueueEntryState,
  MyTurnCard,
  MyTurnCardReason,
  MyTurnTrunkCard,
  PrMergeQueueInfo,
  ReviewerRole,
  SecurityAlertSource,
  SecurityCard,
} from '@pierre-review/shared';
import { MERGE_QUEUE_CARD_DETAIL } from '@pierre-review/shared';

// WHAT THE PENDING BOARD CALLS THINGS — the kind labels and the per-card ownership label, moved
// out of AttentionCards.tsx so the board's info popovers (pendingExplain.ts) can name a card
// exactly as the card names itself, without an import cycle. AttentionCards re-exports both.
//
// …and GitHub's MERGE QUEUE, for the same reason: `MergeControl` (which AttentionCards mounts)
// now names the queue too, and importing the words from AttentionCards would be a cycle.

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
 * CI dot already says "CI failing" and, where the sync stored them, names the failing checks
 * (`CiStatusWithChecks`), so a chip-less "CI is failing" under it said it twice. (The server keeps
 * the sentence — the ranker's reason reads it.)
 */
export function depStateSentence(card: SecurityCard | DependencyBumpCard): string | null {
  if (card.depState === 'ci_red') return null;
  const s = card.kind === 'security' ? card.stateDetail : card.detail;
  if (s == null || s === '') return null;
  // The queue sentence, on a card the queue chip or merge row already marks queued — see
  // `pendingCardDetail`.
  return pendingCardDetail({ detail: s, inMergeQueue: card.inMergeQueue });
}

/**
 * A Dependencies card's state CHIP, or null. ⚠ NOTHING WHILE GITHUB'S QUEUE HOLDS THE PR: the
 * queue chip (or the merge row) says what is happening, and "Ready to merge" beside it is the
 * contradiction the reader reported. (The two states the
 * queue does not settle, `conflicts` and `ci_red`, carry no chip anyway.)
 */
export function depStateChip(
  card: Pick<SecurityCard | DependencyBumpCard, 'depState' | 'inMergeQueue'>,
): string | null {
  if (card.depState == null || card.inMergeQueue === true) return null;
  return DEP_STATE_LABEL[card.depState];
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
/** The label for a Claude review run the workspace's auto review started (`trigger: 'auto'`) —
 *  the Pending chip and the Claude Review tab both print it. */
export const AUTO_REVIEW_LABEL = 'Auto review';

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
  // A run the workspace's auto review started says so; a clicked one keeps "Claude review".
  if (card.reason === 'claude_review' && card.trigger === 'auto') return AUTO_REVIEW_LABEL;
  return MY_TURN_REASON_LABEL[card.reason];
}

/**
 * The type chip a My Turn PR card actually PRINTS, or null for none.
 *
 * ⚠ NOTHING ON YOUR OWN READY PR WHILE GITHUB'S QUEUE HOLDS IT (a POSITIVE `inMergeQueue`). The
 * chip would read "Ready to merge" right beside "In the merge queue" (the queue chip, or the merge
 * row where it prints the queue) — the contradiction `forwardStateChip` and
 * `depStateChip` already drop on the Ready to land and Dependencies cards. My turn is the default
 * tab, so this is where the reader's own queued PR shows up first.
 */
export function myTurnTypeChip(card: MyTurnCard): string | null {
  if (card.reason === 'own_ready' && card.inMergeQueue === true) return null;
  return myTurnReasonLabel(card);
}

// ── GitHub's merge queue ─────────────────────────────────────────────────────────────────────

/** The header chip for GitHub's own merge queue (the board hides it where the card's merge row
 *  prints the same line — `PendingQueueChip`, AttentionCards.tsx). */
export interface PendingQueueBadge {
  label: string;
  title: string;
  /** 'ok' — the queue holds it and is working through it. 'bad' — GitHub is taking it back out. */
  tone: 'ok' | 'bad';
}

/**
 * THE QUEUE'S WORDS — ONE per entry state, read by the card's queue chip AND the merge row's status
 * line, so the two never describe one entry in two vocabularies. (They did: the chip said "Merge
 * queue · running checks" over a row saying "In the merge queue · awaiting checks".) Each says what
 * the QUEUE is doing, because that is the part the reader cannot see from anything else on the
 * card. `null` = the lead says it all ("In the merge queue · queued" said it twice). A total map, so
 * a new GitHub member forces a decision here rather than rendering a raw enum.
 */
const QUEUE_STATE_WORDS: Record<MergeQueueEntryState, string | null> = {
  queued: null,
  awaiting_checks: 'running checks',
  mergeable: 'lands next',
  locked: 'held',
  unmergeable: null,
};

/** How a queue line opens. ⚠ AN EJECTION DOES NOT LEAD WITH "In": GitHub keeps an `unmergeable`
 *  entry only on its way out. */
function queueLead(state: MergeQueueEntryState | null): string {
  return state === 'unmergeable' ? 'Leaving the merge queue' : 'In the merge queue';
}

/** The lead and the state's words, e.g. "In the merge queue · running checks". */
function queueStateText(state: MergeQueueEntryState | null): string {
  const words = state != null ? QUEUE_STATE_WORDS[state] : null;
  return words != null ? `${queueLead(state)} · ${words}` : queueLead(state);
}

/** The chip's label per entry state — the merge row's line without position or time. */
export const QUEUE_STATE_LABEL: Record<MergeQueueEntryState, string> = {
  queued: queueStateText('queued'),
  awaiting_checks: queueStateText('awaiting_checks'),
  mergeable: queueStateText('mergeable'),
  locked: queueStateText('locked'),
  // ⚠ THE ONE THAT EARNS THE FIELD. GitHub ejects an entry whose checks failed against the merged
  // result, and this is the only warning a reader gets before the PR silently reappears un-queued.
  unmergeable: queueStateText('unmergeable'),
};

export const QUEUE_STATE_TITLE: Record<MergeQueueEntryState, string> = {
  queued: 'This pull request is waiting its turn in GitHub’s merge queue.',
  awaiting_checks:
    'It is at the front of GitHub’s merge queue, running the queue’s checks against the merged result.',
  mergeable: 'The queue’s checks passed. GitHub lands this pull request next.',
  locked: 'GitHub is holding this entry while an earlier one in the same batch settles.',
  unmergeable:
    'GitHub is taking this pull request out of the merge queue — the queued merge failed its checks, or it no longer applies. Fix it and queue it again.',
};

const QUEUE_GENERIC_TITLE = 'This pull request is in GitHub’s merge queue.';

/**
 * THE QUEUE CHIP, decided from the card's OWN synced fields — pure, and never a fetch.
 *
 * ⚠ `inMergeQueue: null` IS "NOT OBSERVED" AND RENDERS NOTHING. A card that said "not queued" on
 * no evidence would be a false claim, and `false` — a positive statement from GitHub — has nothing
 * to say either: "this PR is not in a queue" is true of nearly every PR in the world. So the chip
 * is POSITIVE-CLAIM-ONLY, exactly like `authorSourceLabel`.
 *
 * ⚠ AND IT IS NOT PART OF THE MERGE-ACTIONS BLOCK. That block returns null for a reader without
 * push access, and "GitHub is already landing this" is arguably the MORE useful fact for someone
 * who has no button either way. It belongs to the card's identity, in the header row.
 *
 * The entry state is read only for the WORDING; membership is `inMergeQueue`, per the wire's own
 * rule that the state is never the thing to test for "is it queued?".
 */
export function pendingQueueBadge(
  pr: Partial<Pick<InsightPrRef, 'inMergeQueue' | 'mergeQueueEntryState'>>,
): PendingQueueBadge | null {
  if (pr.inMergeQueue !== true) return null;
  const state = pr.mergeQueueEntryState ?? null;
  if (state == null) {
    return { label: queueStateText(null), title: QUEUE_GENERIC_TITLE, tone: 'ok' };
  }
  return {
    label: QUEUE_STATE_LABEL[state],
    title: QUEUE_STATE_TITLE[state],
    tone: state === 'unmergeable' ? 'bad' : 'ok',
  };
}

/** The SYNCED half: the PR row's (or card's) own columns, and WHEN that row was read — the owning
 *  query's `dataUpdatedAt` (epoch ms; 0 when unknown). */
export interface MergeQueueSynced {
  inMergeQueue: boolean | null | undefined;
  mergeQueueEntryState: MergeQueueEntryState | null | undefined;
  observedAt: number;
}

/** The LIVE half: `PrMergeOptions.mergeQueue` from the merge control's click-gated fetch, and when
 *  it answered. `info` null/undefined makes no claim — no answer, no queue on the base branch, or a
 *  probe that failed all read the same, and none of them is "not queued". */
export interface MergeQueueLive {
  info: PrMergeQueueInfo | null | undefined;
  observedAt: number;
}

/** What the merge row says while GitHub's merge queue holds the PR. */
export interface MergeQueueStatus {
  /** THE status line — "In the merge queue · position 2 · running checks · ~12 min" ("Leaving the
   *  merge queue" while GitHub ejects it), in the chip's words (`QUEUE_STATE_LABEL`). Position and
   *  ETA only from a live answer that agrees, and only where the caller asks for them; without
   *  them the line IS the chip's label. */
  line: string;
  /** The longer sentence for the line's `title`. */
  title: string;
  /** 'bad' only while GitHub is ejecting the entry. */
  tone: 'ok' | 'bad';
  entryState: MergeQueueEntryState | null;
  position: number | null;
  /** Which observation decided membership. */
  source: 'synced' | 'live';
}

/**
 * IS GITHUB'S MERGE QUEUE HOLDING THIS PR, AND WHAT DOES THE MERGE ROW SAY ABOUT IT? Pure.
 *
 * ⚠ MEMBERSHIP COMES FROM THE NEWER OBSERVATION, NEVER FROM "LIVE ALWAYS WINS". The merge-options
 * answer is not persisted, but a DISABLED observer keeps it in cache, and on the Pending board it is
 * never refetched (nothing there may fetch on mount). So a live `inQueue:false` read minutes ago,
 * before the PR was queued, would outvote a card the sync has since stamped `true` — which is the
 * reported "I came back and it offered Merge again". The two are compared by when they were read.
 *
 * ⚠ THREE-STATE. A synced `null` is NOT OBSERVED and makes no claim either way; neither does a
 * missing live answer. Only when both are silent is the answer "not queued" (null).
 *
 * ⚠ POSITION AND ETA ONLY FROM A LIVE ANSWER THAT AGREES. A stale live `position 2` beside a
 * newer synced "queued" is still the queue's own position for this PR (the live answer said
 * queued too); a live answer that says NOT queued has no position to lend.
 *
 * ⚠ AND ONLY WHERE THE ANSWER IS KEPT LIVE (`withPosition`, default true). The PR pane keeps the
 * merge-options query live, so its position moves with the queue. The Pending board never
 * refetches it (nothing there may fetch), so a position it holds is whatever an earlier click read,
 * minutes ago, printed as if it were now; and whether one is held at all depends on the cache, so
 * the same card read "position 2 · ~12 min" right after an enqueue and plain "In the merge queue"
 * after a reload. The board passes `withPosition: false` and says the same words every time.
 */
export function mergeQueueStatus(
  synced: MergeQueueSynced,
  live: MergeQueueLive,
  opts: { withPosition?: boolean } = {},
): MergeQueueStatus | null {
  const withPosition = opts.withPosition ?? true;
  const syncedClaim = synced.inMergeQueue ?? null;
  const liveClaim = live.info != null ? live.info.inQueue : null;
  let source: 'synced' | 'live';
  if (liveClaim != null && syncedClaim != null) {
    source = live.observedAt >= synced.observedAt ? 'live' : 'synced';
  } else if (liveClaim != null) {
    source = 'live';
  } else if (syncedClaim != null) {
    source = 'synced';
  } else {
    return null;
  }
  const member = source === 'live' ? liveClaim : syncedClaim;
  if (member !== true) return null;

  const liveAgrees = liveClaim === true && live.info != null;
  const syncedState = syncedClaim === true ? (synced.mergeQueueEntryState ?? null) : null;
  const liveState = liveAgrees ? (live.info?.entryState ?? null) : null;
  // The state words from whichever observation decided; the other fills a gap only when it too
  // says "queued".
  const entryState = source === 'live' ? (liveState ?? syncedState) : (syncedState ?? liveState);
  const position = liveAgrees && withPosition ? (live.info?.position ?? null) : null;
  const etaMs = liveAgrees && withPosition ? (live.info?.estimatedTimeToMergeMs ?? null) : null;

  // The chip's own words, with the position after the lead and the time at the end. An ejection
  // leads "Leaving the merge queue" (`queueLead`), never "In".
  const words = entryState != null ? QUEUE_STATE_WORDS[entryState] : null;
  let line = queueLead(entryState);
  if (position != null) line += ` · position ${position}`;
  if (words != null) line += ` · ${words}`;
  if (etaMs != null) line += ` · ~${Math.max(1, Math.round(etaMs / 60_000))} min`;
  return {
    line,
    title: entryState != null ? QUEUE_STATE_TITLE[entryState] : QUEUE_GENERIC_TITLE,
    tone: entryState === 'unmergeable' ? 'bad' : 'ok',
    entryState,
    position,
    source,
  };
}

/**
 * A card's detail sentence as the card PRINTS it, or null for none. Pure.
 *
 * ⚠ THE QUEUE SENTENCE IS LEFT OFF A QUEUED CARD. While GitHub's queue holds the PR the server
 * writes `MERGE_QUEUE_CARD_DETAIL` ("In the merge queue. GitHub merges it from here.") so the card
 * never says "it can land now", and the Do next row's `reason` reads it. On the card it is the
 * third statement of one fact: the queue chip says it in the header, and for a reader who can push
 * the merge row says it where the Merge button was. Printed, it was three sentences in two
 * vocabularies. The server keeps the sentence; the card drops it, like the `ci_red` sentence in
 * `depStateSentence`.
 *
 * Only on a POSITIVE `inMergeQueue` — the same field that draws the chip, and the one the server
 * wrote the sentence from — so the sentence can never be dropped from a card that says nothing
 * else about the queue.
 */
export function pendingCardDetail(card: {
  detail: string;
  inMergeQueue?: boolean | null;
}): string | null {
  if (card.detail === '') return null;
  if (card.inMergeQueue === true && card.detail === MERGE_QUEUE_CARD_DETAIL) return null;
  return card.detail;
}
