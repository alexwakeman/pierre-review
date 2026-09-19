import {
  DO_NEXT_RULES,
  MY_TURN_OWN_WORK_REASONS,
  PENDING_DO_NEXT_SIZE,
  PENDING_SEVERITY,
  PENDING_TABS,
  type DoNextAdjustment,
  type DoNextPreset,
  type DoNextProximityBase,
  type DoNextWeights,
  type InsightCard,
  type InsightKind,
  type InsightSeverity,
  type MyTurnRelevance,
  type PendingCardScore,
  type PendingRankRules,
  type PendingTabKey,
  type WorkPlanFacts,
} from '@pierre-review/shared';
import { KIND_LABEL } from './pendingLabels.js';
import { PRESET_LABEL, WEIGHT_LABEL } from '../settings/myTurnSettingsForm.js';

// WHY IS THIS CARD HERE, AND WHY HERE — the Pending board's info popovers, as plain sentences.
//
// ⚠ EVERY NUMBER IS READ FROM `@pierre-review/shared`'s pending-rules, the table the server folds
// with. None is typed here. An explanation that quoted a threshold the ranker had since moved away
// from would be a confident false statement on the one screen whose job is to be believed.
//
// ⚠ AND THE WEIGHTS AND THE MY TURN ORDER ARE THE READER'S, READ OFF THE RESPONSE. Settings → My
// Turn lets each reader re-weight the score and re-order My turn's types, so the only true account
// of a list's order is the `rules` the server sent WITH that list (`AttentionCardsResponse.rules`).
// `DO_NEXT_RULES.weights` is the product default, and is read here only for a response that
// predates `rules`.
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
  // Not "on your PR": a red Dependabot bump starts here too, and it is nobody's PR.
  unblock_ci: 'failing build',
  review: 'needs your review or action',
  reply: 'needs your reply',
  thread: 'unanswered review thread',
  nudge: 'waiting on a reviewer',
  conflicts: 'has merge conflicts',
  waiting: 'blocked, or still being checked',
  security_alert: 'flagged by a security tool',
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

/** The weights' name, for a sentence: "Mine first", or "your own" when they match no preset. */
export function weightsName(preset: DoNextPreset | 'custom'): string {
  return preset === 'custom' ? 'your own' : PRESET_LABEL[preset];
}

/** Hours since an ISO instant — for a sentence, so an unreadable one reads as no time at all. */
function hoursSince(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) / 3_600_000 : 0;
}

/**
 * A card's Do next score as three weighted parts. `w` is the weights the SERVER scored with (the
 * response's `rules.weights`), so the parts always add up to the score it printed.
 */
export function scoreBreakdown(p: PendingCardScore, w: DoNextWeights): ScoreBreakdown {
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
      // Named as the Settings sliders name them (WEIGHT_LABEL), so the row a reader sees here is
      // the slider they move there.
      row('proximity', WEIGHT_LABEL.proximity, p.proximity, w.proximity, proximityNote),
      row('stall', WEIGHT_LABEL.stall, p.stallRisk, w.stall, stallNote),
      row('relevance', WEIGHT_LABEL.relevance, rel, w.relevance, RELEVANCE_PHRASE[p.relevance]),
    ],
  };
}

// ── what the card means, and why it is this colour ────────────────────────────────────────

/** What this card is telling the reader, and what makes it go away. One or two sentences. */
export function whyHere(card: InsightCard): string {
  switch (card.kind) {
    case 'my_turn':
      // ⚠ EXHAUSTIVE, and the compiler holds it so: a new type with no sentence here fails to
      // build rather than falling through to a vague one.
      switch (card.reason) {
        case 'review_request':
          return 'Someone asked you to review this PR. It goes away when you submit a review.';
        case 'mention':
          return 'Someone @-mentioned you on this PR. Any review, comment or push from you clears it.';
        case 'thread':
          return 'Someone replied in a review thread you started, or the code under it changed. Replying usually clears it; resolving the thread always does.';
        case 'thread_reply':
          return 'Someone replied after your comment in a review thread. Replying there clears it; resolving the thread always does.';
        case 'comment_reply':
          return 'Someone commented on this PR after your last comment. Any review, comment or push from you clears it.';
        case 'pushed_since':
          return 'Someone pushed new commits after your last review or comment. It goes away when you review, comment or push.';
        case 'own_ci_red':
          return 'The latest build on your open PR failed. It goes away when the build passes.';
        case 'own_conflicts':
          return 'Your PR conflicts with its base branch. It goes away when the conflict is resolved.';
        case 'trunk_red':
          return card.maintained
            ? 'The default branch is failing CI in a repo you maintain. Every open PR there builds on it.'
            : 'The default branch is failing CI. Every open PR there builds on it.';
        case 'pr_approved':
          return 'Your PR is approved. It goes away when it is merged or closed.';
        case 'own_ready':
          return card.own?.kind === 'ready' && card.own.forward === 'update_branch'
            ? 'GitHub will not merge your PR until its branch is updated.'
            : 'GitHub will merge your PR now.';
        case 'your_pr':
          return 'Your PR has new commits, comments or reviews since you last opened it here. Opening it clears this.';
        case 'own_thread':
          return `A review comment on your PR has had no reply and no later commit for ${agePhrase(hoursSince(card.since))}.`;
        case 'claude_review':
          return 'A Claude review finished with findings you have not posted. It goes away when you post them.';
        case 'watched_repo_pr':
          return 'A new PR you have not reviewed, commented on or pushed to. It goes away when you do one of those.';
        default: {
          const _x: never = card;
          return _x;
        }
      }
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
    case 'security':
      if (!card.dependencyUpdate) {
        return 'A security tool flagged a known advisory on this PR. It goes away when the tool clears it or the review thread is resolved.';
      }
      if (card.fix === 'proven') {
        return 'A dependency bot opened this PR to fix a known security advisory. It goes away when the PR is merged or closed.';
      }
      if (card.fix === 'inferred') {
        return 'Dependabot grouped this update the way it groups security updates, and GitHub cut off the line that would confirm it. It goes away when the PR is merged or closed.';
      }
      return 'A security tool flagged a known advisory on this dependency update. It goes away when the PR is merged or closed, or the tool clears it.';
    case 'dependency_bump':
      return 'A dependency bot opened this PR. It goes away when the PR is merged or closed.';
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
    // Your own work, or a red default branch, that you moved into My turn — not a summons, so say
    // how it got here.
    if (MY_TURN_OWN_WORK_REASONS.has(card.reason)) return 'You added this type to My Turn in Settings.';
    if (card.relevance === 'direct') return null;
    if (card.relevance === 'maintained') {
      return 'It counts as “In your repos”: you can push to this repo, or have merged a PR into it.';
    }
    return 'Nobody has named you on it, and you do not maintain the repo.';
  }
  // A dependency update carries its merge actions, so it is described like a forward card. A
  // person's PR a security tool flagged is not: the alert is about the code, not about whose it is.
  if (card.kind === 'security' && !card.dependencyUpdate) return null;
  if (
    card.kind === 'merge' ||
    card.kind === 'update_branch' ||
    card.kind === 'security' ||
    card.kind === 'dependency_bump'
  ) {
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
        case 'mention':
        case 'thread_reply':
        case 'comment_reply':
          return 'someone is waiting on your reply';
        case 'pushed_since':
          return 'new code since your review';
        case 'own_ci_red':
          return 'your build is failing';
        case 'own_conflicts':
          return 'your PR cannot merge';
        case 'trunk_red':
          return card.viewerMerged
            ? 'you merged the PR that landed this commit'
            : 'the default branch is failing';
        case 'pr_approved':
        case 'your_pr':
        case 'own_ready':
        case 'own_thread':
          return 'it is your own PR';
        case 'claude_review':
          return 'findings are waiting to be posted';
        case 'watched_repo_pr':
          return 'nobody asked you directly';
        default: {
          const _x: never = card;
          return _x;
        }
      }
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
    case 'security':
      return card.severity === 'high'
        ? 'it names a known security advisory'
        : 'it is probably a security update';
    case 'dependency_bump':
      return 'an ordinary update, never urgent';
    default:
      return '';
  }
}

// ── where it sits ─────────────────────────────────────────────────────────────────────────

export interface PendingBoardState {
  /** The tab on screen — it decides how the list is ordered (`orderSentence`). */
  tab: PendingTabKey;
  /** The weights and My Turn order the server ranked THIS response with. Absent on a response
   *  that predates them — then the product default is what it used. */
  rules?: PendingRankRules;
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

/**
 * HOW THE LIST ON SCREEN IS ORDERED, in one sentence. A strict-group tab says its groups first,
 * because "listed by score" alone would be false there: a low-scoring security item still sits
 * above every bump, and on My turn a low-scoring review request above every approved PR.
 *
 * My turn is grouped in the READER's type order, which only a response carrying `rules` ranked by;
 * without them the tab is one scored list, and the last sentence is the true one.
 */
export function orderSentence(
  tab: PendingTabKey,
  scored: boolean,
  rules?: PendingRankRules,
): string {
  if (tab === 'my_turn' && scored && rules != null) {
    return `Grouped by type in your order, then by Do next score. The top ${PENDING_DO_NEXT_SIZE} are Do next.`;
  }
  if (!scored) return 'Listed in the order the server sent.';
  if (PENDING_TABS.find((t) => t.key === tab)?.groupByKind === true) {
    return `Security first, then bumps. Each is listed by Do next score, highest first. The top ${PENDING_DO_NEXT_SIZE} are Do next.`;
  }
  return `Listed by Do next score, highest first. The top ${PENDING_DO_NEXT_SIZE} are Do next.`;
}

/**
 * THE LINE UNDER A LIST THE CAP CUT. "The rest score lower" is true only of a purely scored list. On
 * a strict-group tab (My turn in the reader's type order, Dependencies security-first) the list is
 * cut in GROUP order, so what is cut is the last groups — which can outscore what is shown. Same
 * test as `orderSentence`: a kind chip on Dependencies makes the list purely scored again.
 */
export function capSentence(
  tab: PendingTabKey,
  kind: InsightKind | null,
  shown: number,
  total: number,
  rules?: PendingRankRules,
): string {
  const def = PENDING_TABS.find((t) => t.key === tab);
  const grouped =
    kind == null && (def?.groupByKind === true || (def?.groupByReason === true && rules != null));
  return grouped
    ? `Showing the first ${shown} of ${total}.`
    : `Showing the top ${shown} of ${total}. The rest score lower.`;
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
    order: orderSentence(board.tab, p != null, board.rules),
    score: p != null ? scoreBreakdown(p, board.rules?.weights ?? DO_NEXT_RULES.weights) : null,
  };
}
