import type {
  DependencyPrState,
  InsightCard,
  InsightKind,
  InsightSeverity,
  MyTurnCardReason,
  MyTurnRelevance,
  PendingAuthorLens,
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
// ⚠ VALUES ONLY — nothing here decides anything, beyond two one-line lookups the server and the SPA
// must answer identically (`pendingTabOf`, `pendingAuthorSideOf`). The folds that apply these
// numbers stay in the backend; this module is the table they share.

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
 * THE COLOUR OF EACH MY TURN TYPE. Somebody waiting on you, or a failing build or a conflict on
 * your own PR, is red; new code to re-read, a red default branch, your own PR's good news or
 * unanswered threads, or findings you have not posted, is amber; a PR nobody asked you about is
 * blue. A red default branch turns red when you merged the PR that landed its head (the card
 * builder's rule, as on the ci_failing trunk card).
 */
export const MY_TURN_SEVERITY: Record<MyTurnCardReason, InsightSeverity> = {
  review_request: 'high',
  mention: 'high',
  thread: 'high',
  thread_reply: 'high',
  comment_reply: 'high',
  pushed_since: 'warn',
  own_ci_red: 'high',
  own_conflicts: 'high',
  trunk_red: 'warn',
  pr_approved: 'warn',
  own_ready: 'warn',
  your_pr: 'warn',
  own_thread: 'warn',
  claude_review: 'warn',
  watched_repo_pr: 'info',
};

/**
 * THE "EVERYTHING ELSE" ORDER WITHIN ONE COLOUR. The board sorts by severity first (red, amber,
 * blue) and by this rank second; within one kind, each builder's own order stands (the sort is
 * stable). The two bot kinds keep their slots because the fold still emits them — the Pending
 * route filters them out, the Pro Insights pane does not.
 *
 * ⚠ The two FORWARD kinds (`merge`, `update_branch`) rank after the problems on purpose: they are
 * opportunities, and every kind above them is a problem. The "Do next" head is where they get to
 * lead. `security` is a problem, so it sits with the problems; a `dependency_bump` is housekeeping,
 * so it sits after the forward kinds.
 */
export const PENDING_KIND_RANK: Record<InsightKind, number> = {
  my_turn: 0,
  ci_failing: 1,
  conflicts: 2,
  security: 3,
  bot_signal: 4,
  bot_only_review: 5,
  stalled_review: 6,
  untouched_thread: 7,
  reviewer_load: 8,
  reviewer_routing: 9,
  merge: 10,
  update_branch: 11,
  dependency_bump: 12,
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
  /** The product default (= `DO_NEXT_PRESETS.balanced`). The ranker reads the ACCOUNT's resolved
   *  weights (`resolveMyTurnSettings`); nothing may read this field except the resolver and its
   *  test. */
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
    /** A person's PR a security tool flagged for a known advisory — board-only (the Dependencies
     *  tab). There is no security bonus: the tab's strict group already lists every security card
     *  above every bump, so a bonus would change no order and be one more number to explain. */
    security_alert: 0.55,
    /** A dependency PR GitHub is holding for something other than review or red CI (checks still
     *  running, other protection), or whose merge state it has not worked out — board-only. */
    waiting: 0.3,
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

/** Integer percentages, multiples of 10, summing to exactly 100 — what Settings → My Turn stores.
 *  Every proximity / stall / relevance value is a multiple of 0.05, so value × weight is exact at
 *  one decimal only when the weight is a multiple of 0.1; that keeps every printed working exact. */
export interface DoNextWeightsPct {
  proximity: number;
  stall: number;
  relevance: number;
}
/** The same three weights as fractions (0..1, summing to 1) — what the ranker multiplies by. */
export interface DoNextWeights {
  proximity: number;
  stall: number;
  relevance: number;
}
export type DoNextPreset = 'balanced' | 'mine_first' | 'oldest_first' | 'quick_wins';

/** The four named weightings Settings offers. A preset is DERIVED from the stored weights (an
 *  exact match on all three), never stored — Balanced stores nothing at all. */
export const DO_NEXT_PRESETS: Record<DoNextPreset, DoNextWeightsPct> = {
  balanced: { proximity: 50, stall: 30, relevance: 20 },
  mine_first: { proximity: 30, stall: 10, relevance: 60 },
  oldest_first: { proximity: 20, stall: 70, relevance: 10 },
  quick_wins: { proximity: 80, stall: 10, relevance: 10 },
};
export const DO_NEXT_PRESET_ORDER: readonly DoNextPreset[] = [
  'balanced',
  'mine_first',
  'oldest_first',
  'quick_wins',
];

/** Which proximity row a scored card started from — one key of `DO_NEXT_RULES.proximity`. */
export type DoNextProximityBase = keyof typeof DO_NEXT_RULES.proximity;
/** Which adjustments applied — keys of `DO_NEXT_RULES.adjustments`. */
export type DoNextAdjustment = keyof typeof DO_NEXT_RULES.adjustments;

/** Where a Dependencies-tab card starts on the Do next scale, by `DependencyPrState`. 'ready'
 *  splits on approval like a `merge` card (merge_approved / merge_unapproved); a flagged person's
 *  PR has no state and starts at `security_alert`. Read by db/work-plan.ts, printed by the guide. */
export const DEPENDENCY_STATE_BASE: Record<
  Exclude<DependencyPrState, 'ready'>,
  DoNextProximityBase
> = {
  behind: 'update_branch',
  conflicts: 'conflicts',
  ci_red: 'unblock_ci',
  needs_review: 'nudge',
  blocked: 'waiting',
  unknown: 'waiting',
};

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

export type PendingTabKey = 'my_turn' | 'fixing' | 'review' | 'threads' | 'land' | 'deps';

/**
 * The six tabs, in display order, and the card kinds each holds. Every PR card kind on the board
 * belongs to exactly ONE tab, so a card is listed once; a PR with two jobs (your approved PR is both
 * "Approved" in My turn and "Ready to merge") appears once per job, in each job's tab.
 *
 * `reviewer_load` sits in 'review' but is not ranked with the PR cards — it is the "who has reviews
 * waiting" strip at the top of that tab, and it is not in the tab's count.
 *
 * Every tab is one scored list, except the two STRICT-GROUP tabs, whose groups come first and are
 * each scored within, whatever the scores:
 *   • `groupByReason` — My turn, grouped by card type (`MyTurnCard.reason`) in the READER'S order
 *     (Settings → My Turn; `PendingRankRules.myTurnOrder` on the response).
 *   • `groupByKind` — Dependencies, grouped by kind in the order listed: every security item before
 *     every bump.
 * Both are read by the ONE group comparator (`tabGroupRank`, db/pending-tabs.ts), never a second
 * sort chosen by tab key.
 */
export const PENDING_TABS: readonly {
  key: PendingTabKey;
  kinds: readonly InsightKind[];
  groupByKind?: true;
  groupByReason?: true;
}[] = [
  { key: 'my_turn', kinds: ['my_turn'], groupByReason: true },
  { key: 'fixing', kinds: ['ci_failing', 'conflicts'] },
  { key: 'review', kinds: ['stalled_review', 'reviewer_routing', 'reviewer_load'] },
  { key: 'threads', kinds: ['untouched_thread'] },
  { key: 'land', kinds: ['merge', 'update_branch'] },
  { key: 'deps', kinds: ['security', 'dependency_bump'], groupByKind: true },
];

/** The tab a card kind lives in, or null for the two bot kinds (they never reach the board). */
export function pendingTabOf(kind: InsightKind): PendingTabKey | null {
  for (const t of PENDING_TABS) if (t.kinds.includes(kind)) return t.key;
  return null;
}

/** WHO OPENED IT, as the board's lens reads it: 'automation' iff the card names a PR whose
 *  `automation` is set (bots, coding agents, and a person's PR a tool's marker proves the tool made),
 *  else 'people'. ONE predicate for the server's caps and totals and the SPA's filter. A card that
 *  names no PR (review load, a trunk with no landing PR) is 'people', so every card falls on exactly
 *  one side and `people + automation === total` holds by construction. */
export function pendingAuthorSideOf(card: InsightCard): PendingAuthorLens {
  return 'automation' in card && card.automation != null ? 'automation' : 'people';
}
