import {
  DO_NEXT_RULES,
  PENDING_DO_NEXT_SIZE,
  PENDING_SEVERITY,
  type DoNextAdjustment,
  type DoNextProximityBase,
  type InsightCard,
  type InsightSeverity,
  type MyTurnRelevance,
  type PendingCardScore,
  type WorkPlanFacts,
} from '@pierre-review/shared';
import { KIND_LABEL } from './pendingLabels.js';

// WHY IS THIS CARD HERE, AND WHY HERE — the Pending board's info popovers, as plain sentences.
//
// ⚠ EVERY NUMBER IS READ FROM `@pierre-review/shared`'s pending-rules, the table the server folds
// with. None is typed here. An explanation that quoted a threshold the ranker had since moved away
// from would be a confident false statement on the one screen whose job is to be believed.
//
// ⚠ EXPLANATION ONLY. Nothing here sorts, filters or counts; the board's order comes from the
// server (each tab's `cardIds`, score order) and this module only describes it. It never
// re-derives a card's colour either — it reads `card.severity` and names the rule behind it.
//
// Pure, JSX-free, so `test/pendingExplain.test.ts` can pin it.

export const SEVERITY_WORD: Record<InsightSeverity, string> = {
  high: 'Red',
  warn: 'Amber',
  info: 'Blue',
};

// ── small formatters ──────────────────────────────────────────────────────────────────────

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** A threshold in hours, as a reader says it: 24 → "1 day", 72 → "3 days", 4 → "4 hours". */
export function hoursPhrase(hours: number): string {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** An elapsed age, rounded the way the cards round it (hours to 48h, then days). */
export function agePhrase(hours: number): string {
  if (hours < 1) return 'under an hour';
  const h = Math.round(hours);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

/** 0..1 → a figure out of 100, to one decimal only when it has one. Every rule value is a
 *  multiple of 0.05 and every weight a multiple of 0.1, so one decimal is always exact. */
export function outOf100(n: number): number {
  return Math.round(n * 1000) / 10;
}

const signed = (n: number): string => (n >= 0 ? `+${outOf100(n)}` : `−${outOf100(-n)}`);

// ── the Do next score, in words ───────────────────────────────────────────────────────────

/** Proximity bases, as the next step a reader recognises. */
export const BASE_LABEL: Record<DoNextProximityBase, string> = {
  merge_approved: 'approved and ready to merge',
  merge_unapproved: 'ready to merge, not yet approved',
  update_branch: 'needs a branch update',
  red_trunk: 'failing trunk',
  unblock_ci: 'failing build on your PR',
  review: 'needs your review or action',
  reply: 'needs your reply',
  thread: 'unanswered review thread',
  nudge: 'waiting on a reviewer',
  conflicts: 'has merge conflicts',
};

export function adjustmentLabel(a: DoNextAdjustment): string {
  const v = signed(DO_NEXT_RULES.adjustments[a]);
  switch (a) {
    case 'conflicts':
      return `has conflicts ${v}`;
    case 'many_untouched_threads':
      return `${DO_NEXT_RULES.manyUntouchedThreadsMin}+ untouched threads ${v}`;
    case 'small_change':
      return `${DO_NEXT_RULES.smallChangeMaxFiles} files or fewer ${v}`;
  }
}

const CLOCK_PHRASE: Record<NonNullable<WorkPlanFacts['clock']>, string> = {
  opened: 'since it was opened',
  requested: 'since you were asked',
  last_commit: 'since the last commit',
  thread_created: 'since the thread started',
  observed: 'since this came up',
};

export const RELEVANCE_PHRASE: Record<MyTurnRelevance, string> = {
  direct: 'names you',
  maintained: 'a repo you maintain',
  none: 'shared work',
};

export interface ScoreRow {
  key: 'proximity' | 'stall' | 'relevance';
  label: string;
  /** 0..100 */
  value: number;
  /** Percentage weight, e.g. 50. */
  weight: number;
  /** value × weight, out of 100. */
  points: number;
  note: string;
}

export interface ScoreBreakdown {
  /** 0..100 */
  total: number;
  rows: ScoreRow[];
}

export function scoreBreakdown(p: PendingCardScore): ScoreBreakdown {
  const w = DO_NEXT_RULES.weights;
  const baseValue = DO_NEXT_RULES.proximity[p.proximityBase];
  const proximityNote = [
    `${BASE_LABEL[p.proximityBase]} ${outOf100(baseValue)}`,
    ...p.adjustments.map(adjustmentLabel),
  ].join(', ');
  // A red trunk's clock is OUR last look at the branch, not when it went red — say so.
  const clockPhrase =
    p.clock == null
      ? ''
      : p.proximityBase === 'red_trunk' && p.clock === 'observed'
        ? 'since we last checked the branch'
        : CLOCK_PHRASE[p.clock];
  const stallNote =
    p.ageHours == null
      ? 'no start time to measure from'
      : `${agePhrase(p.ageHours)} ${clockPhrase}`.trim();
  const rel = DO_NEXT_RULES.relevanceWeight[p.relevance];
  const row = (
    key: ScoreRow['key'],
    label: string,
    v: number,
    weight: number,
    note: string,
  ): ScoreRow => ({
    key,
    label,
    value: outOf100(v),
    weight: Math.round(weight * 100),
    points: outOf100(v * weight),
    note,
  });
  return {
    total: outOf100(p.score),
    rows: [
      row('proximity', 'Close to merged', p.proximity, w.proximity, proximityNote),
      row('stall', 'Time waiting', p.stallRisk, w.stall, stallNote),
      row('relevance', 'Yours', rel, w.relevance, RELEVANCE_PHRASE[p.relevance]),
    ],
  };
}

// ── what the card means, and why it is this colour ────────────────────────────────────────

/** What this card is telling the reader, and what makes it go away. One or two sentences. */
export function whyHere(card: InsightCard): string {
  switch (card.kind) {
    case 'my_turn':
      switch (card.reason) {
        case 'review_request':
          return 'Someone asked you to review this PR. It goes away when you submit a review.';
        case 'thread':
          return 'Someone replied in a review thread you started, or the code under it changed. Replying usually clears it; resolving the thread always does.';
        case 'pr_approved':
          return 'Your PR is approved. It goes away when it is merged or closed.';
        case 'your_pr':
          return 'Your PR has new commits, comments or reviews since you last opened it here. Opening it clears this.';
        case 'watched_repo_pr':
          return card.ball?.kind === 'commits_after'
            ? 'Someone pushed new commits after your last review or comment. It goes away when you review, comment or push.'
            : 'A new PR you have not reviewed, commented on or pushed to. It goes away when you do one of those.';
        case 'claude_review':
          return 'A Claude review finished with findings you have not posted. It goes away when you post them.';
      }
      return 'This is on your plate.';
    case 'ci_failing':
      return card.arm === 'your_pr'
        ? 'The latest build on your open PR failed.'
        : 'The default branch is failing CI in a repo you maintain. Every open PR there builds on it.';
    case 'conflicts':
      return 'This PR conflicts with its base branch, and you can push to the repo.';
    case 'stalled_review':
      return `The PR has been open ${agePhrase(card.ageHours)} and a requested review has not arrived.`;
    case 'untouched_thread':
      return `A review comment has had no reply and no follow-up commit for ${agePhrase(card.ageHours)}.`;
    case 'reviewer_load':
      return `This reviewer has ${card.pendingCount} requested review${
        card.pendingCount === 1 ? '' : 's'
      } they have not done yet.`;
    case 'reviewer_routing':
      return 'Nobody has been asked to review this PR, and nobody has reviewed it.';
    case 'merge':
      return 'GitHub will merge this PR now.';
    case 'update_branch':
      return 'GitHub will not merge this PR until its branch is updated.';
    default:
      return KIND_LABEL[card.kind];
  }
}

/** Whose this card is, when `whyHere` has not already said. Null when it has. */
export function whoseItIs(card: InsightCard): string | null {
  if (card.kind === 'my_turn') {
    if (card.muted === true) {
      return 'Its repo is muted for Pending, so it does not claim your turn or notify you.';
    }
    if (card.relevance === 'direct') {
      return card.reason === 'watched_repo_pr' ? 'It counts as yours: someone @-mentioned you on it.' : null;
    }
    if (card.relevance === 'maintained') {
      return 'It counts as “In your repos”: you can push to this repo, or have merged a PR into it.';
    }
    return 'Nobody has named you on it, and you do not maintain the repo.';
  }
  if (card.kind === 'merge' || card.kind === 'update_branch') {
    if (card.relevance === 'direct') return 'It is your PR.';
    if (card.relevance === 'maintained') return 'It is in a repo you maintain.';
    return 'It is not your PR, and you do not maintain the repo.';
  }
  if (card.kind === 'conflicts') {
    return card.relevance === 'direct' ? 'It is your PR.' : 'It is someone else’s PR.';
  }
  return null;
}

/** The rule that gave this card its colour, without the colour word. */
export function colourReason(card: InsightCard): string {
  const days = hoursPhrase;
  switch (card.kind) {
    case 'my_turn':
      switch (card.reason) {
        case 'review_request':
          return 'someone is waiting on your review';
        case 'thread':
          return 'someone is waiting on your reply';
        case 'pr_approved':
        case 'your_pr':
          return 'it is your own PR';
        case 'claude_review':
          return 'findings are waiting to be posted';
        case 'watched_repo_pr':
          return 'nobody asked you directly';
      }
      return 'on your plate';
    case 'ci_failing':
      if (card.arm === 'your_pr') return 'your build is failing';
      return card.viewerMerged
        ? 'you merged the PR that landed this commit'
        : 'trunk is failing in a repo you maintain';
    case 'conflicts':
      return card.relevance === 'direct' ? 'it is your PR' : 'it is someone else’s PR';
    case 'stalled_review': {
      const t = PENDING_SEVERITY.stalledReviewHours;
      if (card.severity === 'high') return `open ${days(t.high)} or more`;
      if (card.severity === 'warn') return `open ${days(t.warn)} to ${days(t.high)}`;
      return `open under ${days(t.warn)}`;
    }
    case 'untouched_thread': {
      const t = PENDING_SEVERITY.untouchedThreadHours;
      if (card.severity === 'high') return `unanswered ${days(t.high)} or more`;
      if (card.severity === 'warn') return `unanswered ${days(t.warn)} to ${days(t.high)}`;
      return `unanswered under ${days(t.warn)}`;
    }
    case 'reviewer_load': {
      const t = PENDING_SEVERITY.reviewerLoadPending;
      if (card.severity === 'high') return `${t.high} or more reviews waiting`;
      if (card.severity === 'warn') return `${t.warn} to ${t.high - 1} reviews waiting`;
      return `fewer than ${t.warn} reviews waiting`;
    }
    case 'reviewer_routing':
      return 'a suggestion, never urgent';
    case 'merge':
    case 'update_branch':
      return card.relevance === 'direct' ? 'it is your PR' : 'it is not your PR';
    default:
      return '';
  }
}

// ── where it sits ─────────────────────────────────────────────────────────────────────────

export interface PendingBoardState {
  /** Card id → 0-based position in the list on screen; -1 for a card in the people strip. */
  indexById: ReadonlyMap<string, number>;
  /** How many leading cards are Do next. */
  doNextCount: number;
  /** The uncapped population of the view on screen — so position i of the list is rank i of it. */
  total: number;
  /** What the view is called: "Waiting on review", or "Stalled review in Waiting on review". */
  viewName: string;
  /** Absent on a response from a server that predates it. */
  scores: Record<string, PendingCardScore> | undefined;
}

export interface CardExplanation {
  why: string;
  whose: string | null;
  colour: { severity: InsightSeverity; word: string; reason: string };
  /** "4th of 176 in Waiting on review · Do next". */
  place: string;
  /** How the list is ordered, in one sentence. */
  order: string;
  score: ScoreBreakdown | null;
}

export function explainCard(card: InsightCard, board: PendingBoardState): CardExplanation {
  const index = board.indexById.get(card.id) ?? 0;
  const common = {
    why: whyHere(card),
    whose: whoseItIs(card),
    colour: { severity: card.severity, word: SEVERITY_WORD[card.severity], reason: colourReason(card) },
  };
  if (index < 0) {
    return {
      ...common,
      place: 'In “Reviews waiting on people”, above the ranked list',
      order: 'People are listed by how many reviews they owe, most first. They are not scored.',
      score: null,
    };
  }
  const p = board.scores?.[card.id];
  return {
    ...common,
    place:
      `${ordinal(index + 1)} of ${board.total} in ${board.viewName}` +
      (index < board.doNextCount ? ' · Do next' : ''),
    order:
      p != null
        ? `Listed by Do next score, highest first. The top ${PENDING_DO_NEXT_SIZE} are Do next.`
        : 'Listed in the order the server sent.',
    score: p != null ? scoreBreakdown(p) : null,
  };
}
