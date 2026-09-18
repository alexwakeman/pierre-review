import type {
  InsightKind,
  InsightSeverity,
  MyTurnCardReason,
  MyTurnRelevance,
} from './types.js';

// THE PENDING BOARD'S RULES, AS NUMBERS — the ONE spelling the server folds with and the SPA
// explains with.
//
// ⚠ THIS FILE EXISTS SO THE EXPLANATION CANNOT DRIFT FROM THE BEHAVIOUR. The board's "how is this
// ordered" copy (the header info popover, the "How Pending works" modal, every card's own info
// popover) prints these thresholds and weights. Were the copy to re-type them, the first retune of
// the ranker would leave the app confidently describing an order it no longer produces — a false
// statement on the one screen whose job is to be believed. So `db/queries.ts` (admission, colour,
// board order) and `db/work-plan.ts` (the "Do next" score) read their constants FROM HERE, and the
// SPA renders from here. Change a number here and both move together.
//
// ⚠ VALUES ONLY — nothing here decides anything. The folds that apply these numbers stay in the
// backend; this module is the table they share.

/**
 * WHO GETS ON THE BOARD, and how many of each kind — the admission floors and caps
 * `getWorkspaceInsights` applies.
 */
export const PENDING_LIMITS = {
  /** A requested review must have been open longer than this before it counts as stalled. */
  stalledReviewMinHours: 24,
  /** An untouched review thread must be older than this before it gets a card. */
  untouchedThreadMinHours: 24,
  /** A PR with nobody asked and nobody reviewing must be older than this ("ignore brand-new PRs"). */
  routingMinAgeHours: 4,
  /** A PR with no activity event in this many days is treated as abandoned and gets no survey card. */
  maxQuietDays: 90,
  /** Per-kind cap for every kind except `my_turn`, in the DEFAULT fold every other consumer reads
   *  (the daily brief, the Pro insights pane, chat, the sprint report, Slack). The Pending board
   *  asks for the uncapped fold instead and applies `boardListCap` AFTER ranking by score. */
  cardCap: 15,
  /** `my_turn`'s own, larger cap in the default fold. */
  myTurnCardCap: 50,
  /** How many reviewers the review-load cards name. */
  reviewerLoadCap: 8,
  /** The Pending board lists at most this many cards of each kind — the highest-scoring ones — and
   *  every tab says when it holds more. */
  boardListCap: 50,
  /** Suggested reviewers are looked up (CODEOWNERS + history, network-backed) for this many
   *  "Needs a reviewer" cards on the board — the highest-scoring ones. The rest show none. */
  routingSuggestCap: 15,
} as const;

/**
 * THE COLOUR RULES — where a kind's severity comes from a threshold rather than a fixed value.
 * `high` renders red, `warn` amber, anything below `warn` blue.
 */
export const PENDING_SEVERITY = {
  /** Hours the PR has been OPEN (not since the request) with a review still outstanding. */
  stalledReviewHours: { high: 72, warn: 48 },
  /** Hours since the untouched thread was started. */
  untouchedThreadHours: { high: 96, warn: 48 },
  /** Requested reviews a person has not yet done. */
  reviewerLoadPending: { high: 4, warn: 2 },
} as const;

/**
 * THE COLOUR OF EACH MY TURN SECTION. Somebody waiting on you is red; your own PR, or findings you
 * have not posted, is amber; a PR nobody asked you about directly is blue.
 */
export const MY_TURN_SEVERITY: Record<MyTurnCardReason, InsightSeverity> = {
  review_request: 'high',
  thread: 'high',
  pr_approved: 'warn',
  your_pr: 'warn',
  claude_review: 'warn',
  watched_repo_pr: 'info',
};

/**
 * THE "EVERYTHING ELSE" ORDER WITHIN ONE COLOUR. The board sorts by severity first (red, amber,
 * blue) and by this rank second; within one kind, each builder's own order stands (the sort is
 * stable). The two bot kinds keep their slots because the fold still emits them — the Pending
 * route filters them out, the Pro Insights pane does not.
 *
 * ⚠ The two FORWARD kinds (`merge`, `update_branch`) rank last on purpose: they are opportunities,
 * and every kind above them is a problem. The "Do next" head is where they get to lead.
 */
export const PENDING_KIND_RANK: Record<InsightKind, number> = {
  my_turn: 0,
  ci_failing: 1,
  conflicts: 2,
  bot_signal: 3,
  bot_only_review: 4,
  stalled_review: 5,
  untouched_thread: 6,
  reviewer_load: 7,
  reviewer_routing: 8,
  merge: 9,
  update_branch: 10,
};

/**
 * THE "DO NEXT" SCORE — `db/work-plan.ts`'s deterministic rank.
 *
 *   score = weights.proximity × proximity + weights.stall × stallRisk + weights.relevance × relevanceWeight
 *
 * Every value is 0..1. `proximity` is "how few steps from a merged PR", `stallRisk` is "how long it
 * has been waiting, bucketed", `relevanceWeight` is "how much it is the viewer's".
 */
export const DO_NEXT_RULES = {
  /** How many rows the head seats. */
  cap: 12,
  weights: { proximity: 0.5, stall: 0.3, relevance: 0.2 },
  /**
   * Proximity by the row's next step. `merge` splits on approval: a clean PR nobody has approved is
   * ready for GitHub, not for a human, so it scores BELOW a review or a reply. A red trunk sits
   * above a red PR because it breaks every open PR in the repo at once.
   */
  proximity: {
    merge_approved: 0.95,
    merge_unapproved: 0.45,
    update_branch: 0.7,
    red_trunk: 0.65,
    unblock_ci: 0.6,
    review: 0.55,
    reply: 0.5,
    thread: 0.4,
    nudge: 0.25,
    /** A merge conflict — board-only. Conflicts cards compete inside the "Needs fixing" tab and
     *  are NOT part of the Pro work plan's evidence (its kind vocabulary has no conflicts member).
     *  The `conflicts` adjustment below is NOT applied on top of this base: it IS the conflict. */
    conflicts: 0.5,
  },
  /** Applied once each, then the sum is clamped to 0..1. */
  adjustments: {
    /** GitHub reports the PR as conflicting (`mergeStateStatus === 'dirty'`). */
    conflicts: -0.15,
    /** At least `manyUntouchedThreadsMin` review threads with no reply and no follow-up commit. */
    many_untouched_threads: -0.1,
    /** The PR touches at most `smallChangeMaxFiles` files. */
    small_change: 0.05,
  },
  manyUntouchedThreadsMin: 3,
  smallChangeMaxFiles: 3,
  /** Hours on the row's OWN clock → stall risk. First match wins, checked top down. */
  stallBuckets: [
    { minHours: 96, risk: 1.0 },
    { minHours: 48, risk: 0.7 },
    { minHours: 24, risk: 0.4 },
  ],
  /** Under the lowest bucket, or no clock at all. An unknown age is never treated as urgent. */
  stallBase: 0.15,
  relevanceWeight: { direct: 1.0, maintained: 0.6, none: 0.25 } satisfies Record<
    MyTurnRelevance,
    number
  >,
} as const;

/** Which proximity row a scored card started from — one key of `DO_NEXT_RULES.proximity`. */
export type DoNextProximityBase = keyof typeof DO_NEXT_RULES.proximity;
/** Which adjustments applied — keys of `DO_NEXT_RULES.adjustments`. */
export type DoNextAdjustment = keyof typeof DO_NEXT_RULES.adjustments;

/** The card kinds that get no score. Review load is about PEOPLE, not pull requests, so it is
 *  listed beside the ranking rather than in it; the two bot cards never reach the Pending board. */
export const DO_NEXT_UNSCORED_KINDS: ReadonlySet<InsightKind> = new Set<InsightKind>([
  'reviewer_load',
  'bot_signal',
  'bot_only_review',
]);

// ── THE PENDING TABS ──────────────────────────────────────────────────────────────────────────

/** How many of a tab's highest-scoring cards sit under "Do next". The rest are "Everything else". */
export const PENDING_DO_NEXT_SIZE = 5;

export type PendingTabKey = 'my_turn' | 'fixing' | 'review' | 'threads' | 'land';

/**
 * The five tabs, in display order, and the card kinds each holds. Every PR card kind on the board
 * belongs to exactly ONE tab, so a card is listed once; a PR with two jobs (your approved PR is both
 * "Approved" in My turn and "Ready to merge") appears once per job, in each job's tab.
 *
 * `reviewer_load` sits in 'review' but is not ranked with the PR cards — it is the "who has reviews
 * waiting" strip at the top of that tab, and it is not in the tab's count.
 */
export const PENDING_TABS: readonly { key: PendingTabKey; kinds: readonly InsightKind[] }[] = [
  { key: 'my_turn', kinds: ['my_turn'] },
  { key: 'fixing', kinds: ['ci_failing', 'conflicts'] },
  { key: 'review', kinds: ['stalled_review', 'reviewer_routing', 'reviewer_load'] },
  { key: 'threads', kinds: ['untouched_thread'] },
  { key: 'land', kinds: ['merge', 'update_branch'] },
];

/** The tab a card kind lives in, or null for the two bot kinds (they never reach the board). */
export function pendingTabOf(kind: InsightKind): PendingTabKey | null {
  for (const t of PENDING_TABS) if (t.kinds.includes(kind)) return t.key;
  return null;
}
