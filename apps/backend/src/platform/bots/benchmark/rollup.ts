import type {
  BotBenchmarkCostRefusal,
  BotBenchmarkCostUnacted,
  BotBenchmarkCostYours,
  BotBenchmarkPlacementCohort,
  BotBenchmarkPlacementCounters,
  BotBenchmarkPlacementMetric,
  BotBenchmarkPlacementReviewer,
  BotBenchmarkRollupContribution,
  BotBenchmarkRollupExpectation,
  BotBenchmarkRollupRefusal,
  BotBenchmarkRollupRefusalReason,
  BotBenchmarkRollupSpread,
  BotBenchmarkWorkspaceCost,
  BotBenchmarkWorkspaceRollup,
} from '@pierre-review/shared';
import {
  COST_WINDOW_DAYS,
  COST_WINDOW_MIN_ACTED,
  DAYS_PER_MONTH,
  costRefusal,
  round6,
  type ResolvedUnitPrice,
} from './cost.js';

// ONE VENDOR OVER A WHOLE WORKSPACE — the fold from n per-repository units to the card that states
// the money.
//
// PURE. No database, no request, no clock: per-repository facts, a resolved price and a window
// length go in, and the wire block comes out. `cost.ts` is its sibling and its dependency — every
// null-vs-zero rule, every seat rule and every money REFUSAL SENTENCE is imported from there rather
// than restated, because two grains that disagree about what "recorded as free" means teach a
// reader to distrust both.
//
// ── THE SIX RULES ───────────────────────────────────────────────────────────────────────────────
//
//  1. ⚠ THE GRAIN IS THE WHOLE POINT. `workspace_reviewers` prices a reviewer ONCE PER WORKSPACE,
//     and the placement's unit is one (repository, vendor) pair — so the per-repository block
//     divided a whole subscription by one repository's work and had to disclose that five other
//     cards carried the same number. That disclosure was a caveat compensating for a grain
//     mismatch. This module moves the grain instead: numerator and denominator now describe the
//     same population, so there is nothing to disclose and nothing a reader can double-count.
//
//  2. ⚠⚠ THE MONEY DIVIDES BY A CHOSEN CALENDAR MONTH — `COST_WINDOW_DAYS`, ONE WINDOW, BOTH ENDS.
//
//         actedInWindow = Σ_r ( threads this reviewer settled AND that were acted on, whose
//                               SETTLE POINT fell in [now − COST_WINDOW_DAYS, now) )
//         perActedOnUsd = monthlyUsd ÷ actedInWindow
//
//     Both halves of that fraction cover the same month, so the quotient is checkable from the two
//     numbers printed beside it — which is the property the figure it replaced did not have.
//
//     ⚠ THE RULE THIS SUPERSEDES, KEPT BECAUSE ITS ARGUMENT OUTLIVES ITS CONCLUSION. This block
//     used to read `actedPerMonth = Σ_r ( acted_r × DAYS_PER_MONTH ÷ spanDays_r )` — a sum of
//     per-repository RATES, never `Σ acted ÷ union-span`, because a reviewer that ran in repository
//     A in January and B in July has a seven-month union and was working for two, and the union
//     form understates the pace threefold while reading entirely plausible on screen. That argument
//     is still correct AND NOW VACUOUS: no span divides anything here, so spans have nothing to be
//     non-additive about. It is written down because the defect it guards against is the shape of
//     the one this change fixed — a per-month claim resting on a window nobody chose — and the next
//     figure that reaches for an observed stretch of time will need it back, in this form.
//
//     ⚠ WHAT IS ADDITIVE HERE IS COUNTS, AND ONLY BECAUSE THEY SHARE ONE WINDOW. `actedInWindow` is
//     a plain sum over the live repositories: every term is counted over the SAME calendar month,
//     so there is no per-repository divisor to keep straight. A repository whose observation span
//     could not be read now contributes NORMALLY (it is still counted in `spanUnobservedRepos`, but
//     only as a note about the evidence table's own column) — the previous rule dropped it from the
//     pace entirely, which understated the estate's throughput.
//
//  3. ⚠ COUNTS POOL; RATES ARE GATED PER REPOSITORY. The per-repository fold withholds an
//     `acted_on_rate` over a handful of threads (`below_min_units`), and that gate applies to the
//     ROW in the evidence table — but its raw COUNTS still enter the pooled numerator and
//     denominator. That is not a loophole, it is what a rollup is FOR: pooling is the remedy for a
//     thin sample, and four threads in one repository plus four hundred in another is a five-repo
//     denominator, not five small ones. The gate stops a noisy rate being PRINTED; it does not stop
//     real threads being COUNTED.
//
//  4. ⚠⚠ THE TWO HALVES OF A COMPARISON MUST SHARE ONE POPULATION. `expectedRate` exists only over
//     the repositories whose cohort published an `acted_on_rate` median — the FITTED subset — so
//     the customer's rate it is set against is computed over that SAME subset (`yoursRateOnFitted`),
//     never the card's pooled headline rate. They are different numbers over different
//     denominators, and one row carrying one of each is the defect docs/PERIOD-REPORTING.md names
//     "ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS" — shipped three times there
//     before it was believed. Both rates and BOTH repository counts ride the wire so a renderer is
//     physically able to label them apart, and a test can assert it did.
//
//  5. ⚠ ONE FACTOR IS SWAPPED, NEVER TWO — `cost.ts` rule 4, one grain up, and it survives the fold
//     because the swap happens PER REPOSITORY before anything is summed:
//
//         actedAtPeer = Σ_r ( settled_r × cohortMedian_r )
//
//     Each repository meets its OWN cell's median. Blending the medians into one estate figure and
//     multiplying it by an estate thread count is the median-of-a-product error wearing a sum, and
//     it is wrong in a direction nobody could check. The thread COUNTS and the PRICE stay the
//     customer's; only the RATE is the cohort's, and no second cohort quantile enters the
//     expression.
//
//  6. ⚠ TRUNCATION KILLS THE MONEY AND SPARES THE REST, AND IT OUTRANKS EVERY OTHER GUARD. A
//     request folds at most `MAX_PLACEMENT_REPOS` repositories; past that the response says
//     `truncated: true`. A per-repository figure is unharmed by that — it is about its own
//     repository — but a WORKSPACE figure divides one WHOLE price by a PARTIAL sum, so every one of
//     them reads too high by an amount nothing here can state. Counters and the placement spread
//     still render: a sum of counts over eight repositories is an honest sum over eight
//     repositories, and a rank distribution is a shape rather than a total. It is only the money
//     that refuses, with `workspace_truncated`.
//
// ── GUARD ORDER ─────────────────────────────────────────────────────────────────────────────────
//
// `cost.ts`'s order, with truncation prepended and the span step replaced by the window's own:
// TRUNCATION → repository facts → money facts → reviewer facts → WINDOW facts → cohort facts. Two
// different refusals on one card for one cause is how a reader stops believing either, so an estate
// that merged nothing says so with the same sentence whatever the price happens to be.
//
// The WINDOW step is three gates in this order, and they are not interchangeable:
//   `repo_window_incomplete`  the month is not a whole month for this estate (a repository held for
//                             less than it) — partial work against a whole price, INFLATING
//   `nothing_acted_on`        the month is whole and empty
//   `window_underpopulated`   the month is whole and too thin to divide a price by (< 10)
// ⚠ NONE OF THEM FALLS BACK. An empty month behind months of history is a DORMANT reviewer, and a
// lifetime average against today's price is a plausible number measuring nothing.

/** The fitter's own name for the one metric this module reads. Spelled identically to `cost.ts`'s
 *  so an `own_rate_withheld` refusal stays joinable to the metric row it is about. */
const ACTED_ON_RATE = 'acted_on_rate';

// ── The refusals a COMPARISON is withheld under (the money's own vocabulary is `cost.ts`'s) ──────

/** ⚠ FIVE SENTENCES, NOT ONE "no peer data". Each names a different fact with a different remedy —
 *  and none of them is a money refusal, which is the whole reason this vocabulary is separate from
 *  `BotBenchmarkCostRefusalReason`: those withhold a figure a PRICE would fix, these withhold a
 *  comparison no price can buy. */
export const ROLLUP_REFUSAL_MESSAGE: Readonly<Record<BotBenchmarkRollupRefusalReason, string>> = {
  single_repo:
    'This bot runs in only one repository here, so there is nothing to spread across. One result ' +
    'is not a pattern, and showing it as "1 of 1 above average" would invite you to read one as ' +
    'a trend. That repository’s own card has the full comparison.',
  no_placed_repos:
    'None of the repositories this bot runs in could be matched to other teams’ repositories of a ' +
    'similar size, so there is nothing to rank. The table below gives the reason for each one, ' +
    'and they are not all the same reason — having no comparison is not the same as scoring ' +
    'average.',
  // ⚠ NAMES BOTH CAUSES, because a zero median is one of them and reads as a measurement if it is
  // not spelled out. The repository card refuses the same cell in `cohort_rate_zero`'s words.
  no_fitted_cohort_rate:
    'We have no usable figure for how much other teams act on this bot at any of these repository ' +
    'sizes, so there is nothing to put in place of your own rate. Either too few teams were ' +
    'measured, or the ones we have act on none of it — which is not a target to aim at. Your own ' +
    'figures above are unaffected.',
  no_settled_threads:
    'This bot finished no comment threads anywhere in this Workspace, so every rate here would ' +
    'divide by nothing. A bot that only posts summaries, or one whose threads are all still open, ' +
    'has not had the chance to be acted on yet — showing that as 0% would blame the bot for a ' +
    'gap in the data.',
  vendor_not_in_corpus:
    'We have never measured this bot at other teams, so nothing about how they use it can be ' +
    'shown. It may be a product we have not seen yet, or an unbranded account we cannot identify. ' +
    'Everything else on this card — the counts, the table and the cost — comes from your own data ' +
    'and is unaffected.',
};

function rollupRefusal(reason: BotBenchmarkRollupRefusalReason): BotBenchmarkRollupRefusal {
  return { status: 'refused', reason, message: ROLLUP_REFUSAL_MESSAGE[reason] };
}

function isCostRefusal(v: unknown): v is BotBenchmarkCostRefusal {
  return typeof v === 'object' && v !== null && (v as { status?: string }).status === 'refused';
}

// ── The inputs ──────────────────────────────────────────────────────────────────────────────────

/**
 * ONE REPOSITORY'S CONTRIBUTION, exactly as the per-repository fold already computed it.
 *
 * ⚠ NOTHING IS RE-DERIVED HERE. Every field is lifted off the unit the placement route already
 * built, so the rollup and the repository's own card cannot disagree about a number they both
 * display. A second computation of `acted_on_rate` in this module would be a second answer to a
 * question the product exists to answer once.
 */
export interface RollupRepoFacts {
  repoId: number;
  repoOwner: string;
  repoName: string;
  /** ⚠ ANY AUTHOR — the banding axis, and `perMergedPr`'s divisor once summed. */
  mergedPrsLast14d: number;
  /** The unit's placement, verbatim. Read for the band label, the refusal reason, and the
   *  partial-window gate. */
  placement: BotBenchmarkPlacementCohort;
  /** The unit's counters, verbatim. These POOL — every key in any member is summed. */
  counters: BotBenchmarkPlacementCounters;
  /** ⚠ THE METRIC IS THE GATE AND THE COUNTERS ARE THE VALUE (`cost.ts`'s `ownEngagement`, same
   *  rule). This decides whether this repository may PRINT a rate and whether it holds a cohort
   *  median; it is never the source of the pooled arithmetic. `undefined` when the fold emitted no
   *  `acted_on_rate` for this unit at all. */
  actedOnRateMetric: BotBenchmarkPlacementMetric | undefined;
  /** Days since the host first held this repository. ⚠ THE COST WINDOW'S OWN COMPLETENESS GATE, and
   *  a DIFFERENT threshold from the placement's: a repository held for 20 days has a full
   *  fourteen-day banding window and only two thirds of a calendar month, so its acted-on count is
   *  an undercount against a whole price. Lifted off `unit.activity.repoHeldDays`, never re-derived. */
  repoHeldDays: number;
  /** The reviewer's own observed working period IN THIS REPOSITORY, in days — `cost.ts`'s
   *  `resolveSpan` output. ⚠ A DISCLOSURE ONLY. It divided the per-month pace until this figure
   *  moved to a chosen calendar month; today it is the evidence table's observation-period column
   *  and nothing else reads it. `null` is a real and common state. */
  spanDays: number | null;
  /** `threadsSettledComplete` — the rate's denominator, a real count, OVER THE WHOLE READ SLICE.
   *  Pools into the card's headline rate; it is NOT what the money divides by. */
  settled: number;
  /** `threadsSettledCompleteActed` — the numerator, a real count, never a projection. Same
   *  population as `settled`. */
  acted: number;
  /** ⚠ THE SAME TWO COUNTS INSIDE `COST_WINDOW_DAYS` — the fold's own `costWindow` pair, a SUBSET
   *  of the two above by construction (same gates, same loop, one extra predicate). These are what
   *  the money divides by, and the only reason the quotient is checkable from the card. */
  settledInWindow: number;
  actedInWindow: number;
}

export interface WorkspaceRollupInput {
  /** The workspace's own automation key — the card's identity. ⚠ NOT `vendor`, which is `null` for
   *  every brand the corpus has never seen, and NOT `owner/name`, which a rollup has n of. */
  key: string;
  vendor: string | null;
  botKind: string | null;
  reviewers: BotBenchmarkPlacementReviewer[];
  /** EVERY repository the request folded for this vendor, live or silent. The fold picks the live
   *  ones itself, so the caller never has to know the liveness rule — one definition, here. */
  repos: RollupRepoFacts[];
  /** How many repositories the request folded at all, so the card can say "live in 3 of 11". */
  reposConsidered: number;
  /** `null` ⇒ NO PRICE SET for this reviewer in this Workspace ⇒ no cost block at all
   *  (`cost.ts` rule 1). Resolved by `resolveUnitPrice`, never a fourth per-seat multiply. */
  price: ResolvedUnitPrice | null;
  /** The placement's 14-day banding window — `perMergedPr`'s basis, and NOTHING ELSE'S. */
  windowDays: number;
  /** The response's own `truncated` flag. ⚠ Rule 6: it kills every money figure on this card. */
  truncated: boolean;
}

/**
 * THE BASIS, IN ONE SENTENCE — served so a renderer cannot drop it.
 *
 * ⚠ IT NAMES THE TWO NUMBERS THE FIGURE DIVIDES, AND THEY ARE BOTH ON THE CARD. That is the whole
 * job: a reader who can see "US$783.00 a month" and "243 threads acted on in the last month" can
 * do the division and land on the figure printed above them. The card this replaced could not be
 * checked from anything on it.
 *
 * ⚠ IT REPLACED 106 WORDS, EVERY CLAUSE OF WHICH WAS ABOUT A TIME BASE THAT NO LONGER EXISTS.
 * `ROLLUP_SPAN_NOTE` explained that the pace was a sum of per-repository stretches, that those
 * stretches were not joined, and that a repository without one contributed nothing — three careful
 * caveats about an observed span that nothing divides by any more. A caveat that no longer
 * describes the arithmetic is worse than no caveat: it is a false account of how the number was
 * made, in the voice of a disclosure.
 *
 * ⚠ THE MULTI-REPOSITORY CLAUSE IS CONDITIONAL, because on a single-repository card "summed across
 * 1 repository" is noise that makes a simple sentence read like a qualified one.
 */
export function rollupBasisNote(args: {
  monthlyUsd: number | null;
  actedInWindow: number | null;
  coveredRepos: number;
}): string {
  const windowLabel = `the last ${Math.round(COST_WINDOW_DAYS)} days`;
  const spread =
    args.coveredRepos > 1
      ? `, summed across the ${args.coveredRepos} repositories this reviewer is live in`
      : '';
  if (args.monthlyUsd == null || args.actedInWindow == null) {
    // ⚠ NO FIGURES WHEN THERE ARE NO FIGURES. Every arm refused, so this sentence states the basis
    // the card WOULD have used rather than inventing two numbers to divide.
    return (
      `The per-comment figure is the monthly price divided by the comments your team used in ` +
      `${windowLabel}${spread}. Both halves cover the same month.`
    );
  }
  return (
    `${formatUsd(args.monthlyUsd)} a month divided by the ${args.actedInWindow} ` +
    `${args.actedInWindow === 1 ? 'comment' : 'comments'} your team used in ${windowLabel}` +
    `${spread}. Both halves cover the same month.`
  );
}

/** ⚠ THE SERVER'S OWN `US$`, AND IT MUST MATCH THE PANEL'S. A bare `$` is four currencies, and the
 *  one sentence on this card that a reader is invited to CHECK against a figure beside it cannot
 *  spell that figure differently from the row above. Two decimals always — this is a price. */
function formatUsd(usd: number): string {
  return `US$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ── Reading the per-repository facts ────────────────────────────────────────────────────────────

/** ⚠ ONE DEFINITION OF "LIVE", AND IT IS ABOUT OBSERVED WORK RATHER THAN ABOUT DECLARATION. The
 *  workspace's declared lineup produces a fold unit for every reviewer in EVERY repository, so a
 *  vendor installed on one repository of eleven arrives here with ten all-zero units. Counting
 *  those into `liveInRepos` would say "live in 11 of 11" about a reviewer nobody installed, and —
 *  worse — would put ten silent repositories' merge counts into the denominator of a cost figure
 *  the reviewer had no part in, deflating it by an order of magnitude. */
function isLive(f: RollupRepoFacts): boolean {
  return (
    (f.counters.volume['commentsObserved'] ?? 0) > 0 ||
    (f.counters.outcome['commentsObserved'] ?? 0) > 0
  );
}

/** True when the placement refused for a PARTIAL WINDOW — the one refusal whose repository must be
 *  kept out of `perMergedPr`'s denominator (its merge count is a known undercount). ⚠ THE
 *  FOURTEEN-DAY ONE. Its sibling below is a different threshold about a different figure. */
function isPartialWindow(f: RollupRepoFacts): boolean {
  return f.placement.status === 'refused' && f.placement.reason === 'repo_window_incomplete';
}

/**
 * ⚠ THE COST WINDOW'S OWN COMPLETENESS GATE — a SECOND, WIDER threshold, and it kills a different
 * figure.
 *
 * A repository held for 20 days passes the placement's fourteen-day window and still has only two
 * thirds of a calendar month of settle points in it. Its `actedInWindow` is therefore an undercount
 * while `monthlyUsd` is whole, and `monthlyUsd ÷ actedInWindow` reads too HIGH — the inflating
 * direction, exactly as `workspace_truncated` does one grain up, and for exactly the same reason:
 * a whole price over partial work.
 *
 * ⚠ EXCLUDING THE REPOSITORY WOULD MAKE IT WORSE, not better, which is why this refuses instead of
 * disclosing. `perMergedPr` can drop a partial repository because that figure divides by a SUM the
 * repository contributes a term to; dropping a term here removes work from a denominator the whole
 * price still sits over, so the quotient rises further. The honest answer is to withhold the
 * per-thread money and say for how long — the remedy is time, and it is stateable.
 */
function isCostWindowIncomplete(f: RollupRepoFacts): boolean {
  return f.repoHeldDays < COST_WINDOW_DAYS;
}

/** The cohort's USABLE MEDIAN acted-on rate for this repository's own cell, or `null`. ⚠ ONLY A
 *  `compared` metric carries a cohort at all: an `excluded` arm was withheld before the cell was
 *  ever read, and an `uncompared` one means the cohort itself refused this metric here.
 *
 *  ⚠⚠ `p50 <= 0` IS NOT A MEDIAN OF ZERO, IT IS NO MEDIAN — `cost.ts`'s `cohortActedOnRate` gate,
 *  spelled identically on purpose (it refuses `cohort_rate_zero` there). This is NOT hypothetical
 *  and NOT an edge case: in the shipped corpus ALL THREE of `qodo`'s bands publish an
 *  `acted_on_rate` p50 of exactly 0, so every Qodo repository in every Workspace lands here. A zero
 *  median means the corpus is saying "nobody acts on this reviewer anywhere in this band" — a
 *  degenerate cell, not a target — and admitting it to the fitted subset does two wrong things at
 *  once. It DILUTES `expectedRate` toward zero (a mixed estate reported a peer expectation of 30 %
 *  where the one cohort that published a usable one said 60 %, and a conversion gap of US$12 where
 *  the honest figure was US$48 — understated FOURFOLD, in the direction that flatters the
 *  customer); and when every fitted cell is degenerate it drives `actedPerMonthAtPeer` to zero,
 *  which the span guard below then reports as `span_unobserved` — telling a reader that this
 *  reviewer "left no measurable stretch of time" about repositories whose spans were observed
 *  perfectly well. Excluding the cell instead makes it an `excludedRepos` term the wire already
 *  publishes, and an all-degenerate estate refuses `no_fitted_cohort_rate`, which is the same claim
 *  the repository card makes in `cohort_rate_zero`'s words. The two grains must not disagree about
 *  whether a number exists. */
function cohortMedianOf(metric: BotBenchmarkPlacementMetric | undefined): number | null {
  if (metric == null || metric.status !== 'compared') return null;
  const p50 = metric.cohort.quantiles['p50'];
  if (typeof p50 !== 'number' || !Number.isFinite(p50) || p50 <= 0) return null;
  return p50;
}

/** Plain key-by-key sum. ⚠ AN ABSENT KEY CONTRIBUTES 0, NEVER DROPS THE KEY — the additivity
 *  invariant is over the UNION of every member's keys, so a counter one repository does not report
 *  still appears with the others' total rather than vanishing from the card. */
function sumMaps(maps: readonly Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) {
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

function poolCounters(live: readonly RollupRepoFacts[]): BotBenchmarkPlacementCounters {
  return {
    volume: sumMaps(live.map((f) => f.counters.volume)),
    outcome: sumMaps(live.map((f) => f.counters.outcome)),
    overdueEligible: sumMaps(live.map((f) => f.counters.overdueEligible)),
    overdueUntouched: sumMaps(live.map((f) => f.counters.overdueUntouched)),
    repository: sumMaps(live.map((f) => f.counters.repository)),
  };
}

function contributionOf(f: RollupRepoFacts): BotBenchmarkRollupContribution {
  const metric = f.actedOnRateMetric;
  return {
    repoId: f.repoId,
    repoOwner: f.repoOwner,
    repoName: f.repoName,
    mergedPrsLast14d: f.mergedPrsLast14d,
    band:
      f.placement.status === 'placed'
        ? {
            activityBand: f.placement.activityBand,
            nBands: f.placement.nBands,
            bandLabel: f.placement.bandLabel,
          }
        : null,
    placementRefusal: f.placement.status === 'refused' ? f.placement.reason : null,
    // ⚠ THE ROW OBEYS THE GATE EVEN THOUGH THE FOLD DOES NOT (rule 3). A withheld metric means this
    // repository's rate is noise wearing a percentage sign, and a small table cell does not make it
    // less so — while its COUNTS are real and pool into the headline two fields over.
    actedOnRate: metric == null || metric.status === 'excluded' ? null : round6(metric.value),
    // ⚠ NEVER 0 FOR AN ABSENT COMPARISON — that reads as "worst in the cohort".
    percentile: metric != null && metric.status === 'compared' ? metric.percentile : null,
    settledThreads: f.settled,
    actedThreads: f.acted,
    spanDays: f.spanDays,
  };
}

// ── The spread ──────────────────────────────────────────────────────────────────────────────────

/**
 * HOW THE ESTATE'S PLACEMENTS SIT AROUND THE COHORT MEDIAN — a shape, never a total.
 *
 * ⚠ COUNTING IS THE ONLY HONEST SUMMARY OF n PERCENTILES. Averaging them is meaningless twice over:
 * they come from DIFFERENT cohorts (different band, usually different n), and a mean of ranks is
 * not the rank of anything. "Above the median in four of six repositories" is a sentence a reader
 * can check against the evidence table underneath it; "average percentile 63" is not.
 *
 * ⚠ AND ITS POPULATION IS NARROWER THAN THE CARD'S — only a PLACED repository whose metric COMPARED
 * holds a percentile, so `placed` is routinely below `liveInRepos`.
 */
function buildSpread(vendor: string | null, live: readonly RollupRepoFacts[]): BotBenchmarkRollupSpread {
  if (vendor == null) return rollupRefusal('vendor_not_in_corpus');
  let placed = 0;
  let below = 0;
  let at = 0;
  let above = 0;
  for (const f of live) {
    if (f.placement.status !== 'placed') continue;
    const metric = f.actedOnRateMetric;
    if (metric == null || metric.status !== 'compared') continue;
    placed += 1;
    if (metric.percentile < 50) below += 1;
    else if (metric.percentile === 50) at += 1;
    else above += 1;
  }
  if (placed === 0) return rollupRefusal('no_placed_repos');
  // ⚠ ONE POINT IS NOT A THIN SPREAD, IT IS NO SPREAD. Its own repository card says everything
  // there is to say about it, and stating it here as a distribution invites a pattern to be read
  // out of a single placement.
  if (placed === 1) return rollupRefusal('single_repo');
  return { status: 'value', placed, below, at, above };
}

// ── The expectation ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ESTATE-MATCHED EXPECTATION — every repository met with ITS OWN cohort's median (rule 5), and
 * both halves of the comparison computed over ONE population (rule 4).
 *
 * ⚠ THE RATES SURVIVE WITHOUT A PRICE. They are the customer's own measurements met with the
 * corpus's, and withholding them because nobody typed a subscription figure would delete a real
 * finding for want of an unrelated fact. Only the two MONEY fields go quiet, and `moneyRefusal`
 * says why — except in the one case where there is no money anywhere on the card, which is a
 * reviewer nobody priced (no `cost` block at all, and `moneyRefusal: null`).
 */
function buildExpectation(
  input: WorkspaceRollupInput,
  live: readonly RollupRepoFacts[],
  money: number | BotBenchmarkCostRefusal | null,
): BotBenchmarkRollupExpectation {
  // COHORT FACTS, LAST IN THE GUARD ORDER — and the vendor gate is first among them because "we
  // have never measured this brand" is a different sentence from "we measured it and this band is
  // not fitted", with a different remedy (none, versus wait for the next corpus refresh).
  if (input.vendor == null) return rollupRefusal('vendor_not_in_corpus');

  let fittedRepos = 0;
  let settledOnFitted = 0;
  let actedOnFitted = 0;
  let actedAtPeer = 0;
  let actedAtPeerInWindow = 0;
  for (const f of live) {
    const median = cohortMedianOf(f.actedOnRateMetric);
    if (median == null) continue;
    fittedRepos += 1;
    settledOnFitted += f.settled;
    actedOnFitted += f.acted;
    // ⚠ THE ONE SWAP, PER REPOSITORY. `settled` is the customer's; `median` is that repository's own
    // cell's. A blended estate median multiplied by an estate thread count is the median-of-a-
    // product error wearing a sum.
    const atPeer = f.settled * median;
    actedAtPeer += atPeer;
    // ⚠ THE SAME SWAP AGAIN, ON THE WINDOWED COUNT, BECAUSE THE MONEY IS WINDOWED. The two rates
    // (`expectedRate`, `yoursRateOnFitted`) stay over the WHOLE read slice — they are set against
    // cohort medians fitted over the corpus's own unwindowed slice, and narrowing one side of that
    // comparison would compare two different questions. The MONEY may not: a per-thread price
    // computed over the slice while the measured one is computed over a month would put two
    // different time bases in adjacent rows of one table, which is the defect this change removes
    // arriving from the counterfactual's side.
    actedAtPeerInWindow += f.settledInWindow * median;
  }
  // ⚠ OVER `live`, NOT OVER THE FITTED SUBSET, AND THAT ASYMMETRY IS DELIBERATE. A repository
  // younger than the cost window is a fact about the ESTATE the WHOLE price sits over, not about
  // either denominator — so it must silence BOTH money figures. Counted inside the fitted loop it
  // would miss a young repository whose cohort published no median, and the card would then refuse
  // the measured per-thread price while printing a counterfactual one beside it: two answers about
  // one subscription, which is the "one cause, two accounts" failure this whole vocabulary avoids.
  // The two POPULATION gates below stay on this arm's own denominator, exactly as
  // `nothing_acted_on` does one grain down — the counterfactual is the case they exist for.
  const costWindowIncompleteFitted = live.filter(isCostWindowIncomplete).length;

  if (fittedRepos === 0) return rollupRefusal('no_fitted_cohort_rate');
  if (!(settledOnFitted > 0)) return rollupRefusal('no_settled_threads');

  const expectedRate = round6(actedAtPeer / settledOnFitted);
  // ⚠ RULE 4, THE LINE THAT MATTERS: the divisor is the FITTED subset's settled count, not the
  // card's pooled one. `cost.unacted.actedOnRate` is the headline rate over every live repository
  // and is a DIFFERENT NUMBER; the two must never share a row.
  const yoursRateOnFitted = round6(actedOnFitted / settledOnFitted);

  const monthlyUsd = typeof money === 'number' ? money : null;
  let perActedOnUsd: number | null = null;
  let conversionGapUsd: number | null = null;
  // A cost refusal (truncation, a zero price, an unstatable price, a repository gate) IS the reason
  // the money is missing, restated here so this section never sends a reader looking for it.
  let moneyRefusal: BotBenchmarkCostRefusal | null = isCostRefusal(money) ? money : null;
  if (monthlyUsd != null) {
    // ⚠ THE SAME THREE WINDOW GATES `yours` USES, IN THE SAME ORDER AND WITH THE SAME SENTENCES —
    // the two figures sit in adjacent rows of one table, and a reader given two accounts of one
    // cause stops believing either. ⚠ BOTH FIGURES GO QUIET TOGETHER, not one: `conversionGapUsd`'s
    // own arithmetic never divides by the window, but a card that withheld the measured per-thread
    // price and printed the counterfactual one beside it would invite exactly the comparison it had
    // just refused to support.
    if (costWindowIncompleteFitted > 0) {
      moneyRefusal = costRefusal('repo_window_incomplete');
    } else if (!(actedAtPeerInWindow > 0)) {
      moneyRefusal = costRefusal('nothing_acted_on');
    } else if (actedAtPeerInWindow < COST_WINDOW_MIN_ACTED) {
      moneyRefusal = costRefusal('window_underpopulated');
    } else {
      // ⚠ A PRICE OVER A COUNTERFACTUAL COUNT IN THE SAME CALENDAR MONTH — the measured figure's
      // arithmetic with one factor swapped, so the two rows are subtractable and the reader may
      // read them side by side.
      perActedOnUsd = round6(monthlyUsd / actedAtPeerInWindow);
      // ⚠ A DIFFERENCE OF TWO SHARES, NEVER A RATIO — bounded in [−monthlyUsd, monthlyUsd]
      // structurally (rule 7 one grain down). The ratio form rendered −4.1 × the spend AS MONEY.
      // ⚠ AND ITS TWO RATES ARE THE SLICE-WIDE ONES, deliberately: it is a share of the monthly
      // price, not a per-thread price, so it is not noisy over a thin month — and both of its
      // factors must come from the population the cohort medians were fitted against.
      conversionGapUsd = round6(monthlyUsd * (expectedRate - yoursRateOnFitted));
      moneyRefusal = null;
    }
  }

  return {
    status: 'value',
    yoursRateOnFitted,
    expectedRate,
    fittedRepos,
    // ⚠ PUBLISHED, NOT LEFT TO A SUBTRACTION. `liveInRepos − fittedRepos` is the same arithmetic and
    // gives a renderer nothing to hold when it wants to name what is missing from the comparison.
    excludedRepos: live.length - fittedRepos,
    actedAtPeer: round6(actedAtPeer),
    // ⚠ THE COUNTERFACTUAL COUNT INSIDE THE COST WINDOW — which, the window being one calendar
    // month, IS a monthly pace, exactly as `yours.actedPerMonth` is. `null` when there is nothing
    // for a price to divide by; the money refusal beside it says which of the three causes fired.
    actedPerMonthAtPeer: actedAtPeerInWindow > 0 ? round6(actedAtPeerInWindow) : null,
    perActedOnUsd,
    conversionGapUsd,
    moneyRefusal,
  };
}

// ── The money ───────────────────────────────────────────────────────────────────────────────────

interface CostFold {
  cost: BotBenchmarkWorkspaceCost | null;
  /** The resolved money, the refusal standing in for it, or `null` when nobody priced this
   *  reviewer — handed to `buildExpectation` so both sections refuse for the same stated cause. */
  money: number | BotBenchmarkCostRefusal | null;
}

/**
 * WHAT THIS VENDOR COSTS PER UNIT OF WORK ACROSS THE ESTATE, or `null` when no price is set.
 *
 * ⚠ THE GUARD ORDER IS THE RULE (see the header): truncation, then facts about the REPOSITORIES,
 * then facts about the MONEY, then facts about the REVIEWER, then facts about the WINDOW. An estate
 * that merged nothing says so with the same sentence whatever the price happens to be — two
 * different refusals on one card for one cause is how a reader stops believing either.
 *
 * ⚠ TWO WINDOWS LIVE IN THIS BLOCK AND NEITHER MAY BE READ FOR THE OTHER. `windowDays` is the
 * cohort's fourteen-day banding window and is `perMergedPr`'s basis ALONE; `COST_WINDOW_DAYS` is
 * the calendar month the per-acted-on figure divides by at both ends. They have separate
 * completeness gates, separate counters and separate sentences.
 */
function buildRollupCost(input: WorkspaceRollupInput, live: readonly RollupRepoFacts[]): CostFold {
  const { price, windowDays } = input;
  if (price == null) return { cost: null, money: null };

  const windowPrice = (monthly: number): number => round6((monthly * windowDays) / DAYS_PER_MONTH);
  const windowUsd = price.monthlyUsd == null ? null : windowPrice(price.monthlyUsd);

  // ⚠ THE PARTIAL-WINDOW REPOSITORIES LEAVE THE MERGE SUM AND NOTHING ELSE. Their merge count is a
  // known undercount, and it lands in a DENOMINATOR — leaving them in inflates the estate's cost
  // per merged pull request silently, in the direction that flatters the finding. Their counters
  // and their threads still pool, because only the merge count is windowed.
  let mergedPrs = 0;
  let partialWindowRepos = 0;
  let costWindowIncompleteRepos = 0;
  let spanUnobservedRepos = 0;
  let pooledSettled = 0;
  let pooledActed = 0;
  let settledInWindow = 0;
  let actedInWindow = 0;
  for (const f of live) {
    if (isPartialWindow(f)) partialWindowRepos += 1;
    else mergedPrs += f.mergedPrsLast14d;
    // ⚠ COUNTED, NOT EXCLUDED — see `isCostWindowIncomplete`. Its threads still enter the windowed
    // sums; what the count decides is whether the per-thread money may be STATED at all.
    if (isCostWindowIncomplete(f)) costWindowIncompleteRepos += 1;
    // Rule 3: raw counts pool regardless of whether this repository's own rate was printable.
    pooledSettled += f.settled;
    pooledActed += f.acted;
    // Rule 2: every term is counted over the SAME calendar month, so this is a plain sum with no
    // per-repository divisor to keep straight.
    settledInWindow += f.settledInWindow;
    actedInWindow += f.actedInWindow;
    // A DISCLOSURE ONLY, about the evidence table's observation-period column. Nothing below
    // divides by a span.
    if (f.spanDays == null || !(f.spanDays > 0)) spanUnobservedRepos += 1;
  }

  // TRUNCATION OUTRANKS EVERYTHING (rule 6): a partial estate makes the exact claim false, and no
  // other refusal describes that.
  let repoRefusal: BotBenchmarkCostRefusal | null = input.truncated
    ? costRefusal('workspace_truncated')
    : null;
  if (repoRefusal == null) {
    // The two repository gates in `cost.ts`'s own order: an INCOMPLETE window first (every merge
    // count is an undercount), then a COMPLETE window the estate did not use.
    if (live.length > 0 && partialWindowRepos === live.length) {
      repoRefusal = costRefusal('repo_window_incomplete');
    } else if (mergedPrs <= 0) {
      repoRefusal = costRefusal('no_merges_in_window');
    }
  }

  // THE MONEY, or the one refusal standing in for it — repository facts first, then the two ways a
  // price can exist and still not be usable: entered but unstatable, and a real, stored 0.
  const money: number | BotBenchmarkCostRefusal =
    repoRefusal ??
    (price.monthlyUsd == null
      ? costRefusal('price_unresolved')
      : price.monthlyUsd === 0
        ? costRefusal('price_is_zero')
        : price.monthlyUsd);

  // REVIEWER FACTS. ⚠ NO METRIC GATE AT THIS GRAIN, AND THAT IS RULE 3 RATHER THAN AN OVERSIGHT:
  // `below_min_units` withholds a per-repository RATE, and pooling is the remedy it exists for. The
  // one thing that can still fail is an empty pooled denominator, which is `denominator_empty`
  // stated at estate grain — a reviewer that settled no threads anywhere.
  const engagement: { rate: number } | BotBenchmarkCostRefusal =
    pooledSettled > 0
      ? { rate: round6(pooledActed / pooledSettled) }
      : costRefusal('own_rate_withheld', {
          metric: ACTED_ON_RATE,
          metricReason: 'denominator_empty',
        });

  const perMergedPr: BotBenchmarkWorkspaceCost['perMergedPr'] = isCostRefusal(money)
    ? money
    : {
        status: 'value',
        // ⚠ INDEPENDENT OF THE REVIEWER — a price divided by the estate's own merges, asking
        // nothing of the bot, so it survives every metric being withheld. And it is the ONE figure
        // here anchored on the 14-day window at BOTH ends of its fraction.
        value: round6(windowPrice(money) / mergedPrs),
        mergedPrs,
      };

  // ⚠ `unacted` KEEPS THE WHOLE READ SLICE AND DOES NOT MOVE TO THE WINDOW. Two reasons, and both
  // are the same rule from opposite ends. It is the card's HEADLINE rate, additively consistent
  // with the pooled `counters` printed above it and with `expectation.yoursRateOnFitted` beside it;
  // narrowing it to a month would break that agreement on a card whose evidence table exists to be
  // checked against its headline. And it is not a per-thread PRICE — it is a share of the monthly
  // price times a rate, bounded structurally, so a thin month cannot make it noisy. ⚠ IT ALSO NO
  // LONGER REFUSES ON A MISSING SPAN: its arithmetic never divided by one, and the warrant it used
  // to borrow from the observed stretch now comes from the window the card names.
  const unacted: BotBenchmarkCostUnacted | BotBenchmarkCostRefusal = isCostRefusal(money)
    ? money
    : isCostRefusal(engagement)
      ? engagement
      : {
          status: 'value',
          actedOnRate: engagement.rate,
          actedThreads: pooledActed,
          settledThreads: pooledSettled,
          // ⚠ BOUNDED IN [0, monthlyUsd] BECAUSE THE SECOND FACTOR IS A RATE — structural, not a
          // clamp. It survives a rate of 0, where it is the WHOLE monthly price and the strongest
          // finding this block can produce.
          unactedUsd: round6(money * (1 - engagement.rate)),
        };

  // ── THE PER-THREAD MONEY, OVER ONE CHOSEN CALENDAR MONTH ────────────────────────────────────
  //
  // ⚠ THE GUARD ORDER, AND EVERY STEP OF IT IS A DIFFERENT FACT: money (truncation, the estate's
  // own repository gates, the price) → the reviewer's pooled denominator → the WINDOW's
  // completeness → the window's own population. The last two are new and they are not
  // interchangeable: `repo_window_incomplete` says the month we counted is not a whole month for
  // this estate, `nothing_acted_on` says it is whole and empty, and `window_underpopulated` says it
  // is whole and too thin to divide by. Three facts, three remedies, three sentences.
  //
  // ⚠ REFUSE, NEVER FALL BACK. An empty window behind months of history is a DORMANT reviewer; a
  // lifetime average smeared against today's price would be a plausible number measuring nothing,
  // which is the class of defect this whole change removes.
  const yours: BotBenchmarkCostYours | BotBenchmarkCostRefusal = isCostRefusal(money)
    ? money
    : isCostRefusal(engagement)
      ? engagement
      : costWindowIncompleteRepos > 0
        ? costRefusal('repo_window_incomplete')
        : !(actedInWindow > 0)
          ? costRefusal('nothing_acted_on')
          : actedInWindow < COST_WINDOW_MIN_ACTED
            ? costRefusal('window_underpopulated')
            : {
                status: 'value',
                // ⚠ THE WINDOW'S OWN PAIR, NOT THE POOLED ONE TWO ARMS UP. These are the numbers
                // the renderer prints beside the figure, and they are what makes the division
                // checkable; `unacted` carries the slice-wide pair under the same field names and
                // the two must be labelled apart on screen.
                actedThreads: actedInWindow,
                settledThreads: settledInWindow,
                actedOnRate: round6(actedInWindow / settledInWindow),
                // ⚠ THE SAME NUMBER AS `actedThreads`, BY CONSTRUCTION. The window IS a month, so a
                // count inside it already is a monthly pace and there is no annualising factor left
                // to get wrong. It stays on the wire because the shared type promises it and
                // because a reader who wants the pace should not have to know that.
                actedPerMonth: actedInWindow,
                // ⚠ A PRICE DIVIDED BY A COUNT, AND NOTHING ELSE. Both halves cover one calendar
                // month; `basisNote` says so and prints both numbers.
                perActedOnUsd: round6(money / actedInWindow),
              };

  return {
    cost: {
      monthlyUsd: price.monthlyUsd,
      costModel: price.costModel,
      unitMonthlyUsd: price.unitMonthlyUsd,
      seats: price.seats,
      pricedReviewers: price.pricedReviewers,
      seatPriceUnresolved: price.seatPriceUnresolved,
      seatCountZero: price.seatCountZero,
      windowDays,
      windowUsd,
      coveredRepos: live.length,
      spanUnobservedRepos,
      partialWindowRepos,
      costWindowDays: COST_WINDOW_DAYS,
      costWindowIncompleteRepos,
      perMergedPr,
      unacted,
      yours,
      basisNote: rollupBasisNote({
        // ⚠ THE FIGURES COME FROM THE ARM THAT SHIPPED, NEVER FROM THE RAW LOCALS. When `yours`
        // refused there is no division to describe, and printing "US$783.00 ÷ 3 threads" beneath a
        // refusal would restate the exact number the refusal withheld.
        monthlyUsd: yours.status === 'value' ? price.monthlyUsd : null,
        actedInWindow: yours.status === 'value' ? yours.actedThreads : null,
        coveredRepos: live.length,
      }),
    },
    money,
  };
}

// ── The card ────────────────────────────────────────────────────────────────────────────────────

/**
 * ONE VENDOR'S WHOLE-WORKSPACE CARD.
 *
 * ⚠ THE POPULATION IS THE LIVE REPOSITORIES, DECIDED HERE AND NOWHERE ELSE. The workspace's declared
 * lineup produces a fold unit for every reviewer in every repository, so a vendor installed on one
 * repository of eleven arrives with ten all-zero units; counting those would claim "live in 11 of
 * 11" and — worse — would drop ten silent repositories' merge counts into the denominator of a cost
 * figure the reviewer had no part in.
 *
 * ⚠ AND `counters` IS A PLAIN SUM OVER THAT POPULATION, KEY BY KEY. The whole equals the sum of the
 * parts for EVERY key, which is precisely what makes the evidence table checkable against the
 * headline it sits under — and it is the invariant a test should assert directly rather than
 * spot-check on one counter.
 */
export function buildWorkspaceRollup(input: WorkspaceRollupInput): BotBenchmarkWorkspaceRollup {
  const live = input.repos.filter(isLive);
  const { cost, money } = buildRollupCost(input, live);
  const rollup: BotBenchmarkWorkspaceRollup = {
    key: input.key,
    vendor: input.vendor,
    botKind: input.botKind,
    reviewers: input.reviewers,
    liveInRepos: live.length,
    reposConsidered: input.reposConsidered,
    counters: poolCounters(live),
    contributions: live.map(contributionOf),
    spread: buildSpread(input.vendor, live),
    expectation: buildExpectation(input, live, money),
  };
  // NO PRICE ⇒ NO KEY. A "$0.00 per acted-on thread" is a claim about a reviewer nobody priced;
  // absence is the truth (`cost.ts` rule 1).
  if (cost != null) rollup.cost = cost;
  return rollup;
}
