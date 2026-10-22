import type {
  BotBenchmarkCostAtPeerEngagement,
  BotBenchmarkCostRefusal,
  BotBenchmarkCostRefusalReason,
  BotBenchmarkCostSpan,
  BotBenchmarkCostUnacted,
  BotBenchmarkCostYours,
  BotBenchmarkPlacementCost,
  BotBenchmarkPlacementMetric,
  BotBenchmarkUnitExclusionReason,
  CostModel,
} from '@pierre-review/shared';

// WHAT THE REVIEWER COSTS PER UNIT OF WORK — the arithmetic, and every refusal in it.
//
// PURE. No database, no request, no clock: a price, a merge count, the unit's own metric map and
// the window length go in, and the wire block comes out. That is deliberate — every rule below is
// a decision with a wrong answer that compiles (a null coalesced to a zero, a cohort quantile
// multiplied by a cohort quantile, a divisor that is legitimately zero), so each one gets a test in
// `test/benchmark-cost.test.ts` rather than a comment in a route.
//
// ── THE SEVEN RULES ─────────────────────────────────────────────────────────────────────────────
//
//  1. ⚠ `null` IS NOT `0`, AND NO PRICE MEANS NO BLOCK. `workspace_reviewers.monthly_cents` is
//     three-valued in meaning and two-valued in storage: NULL = nobody has said what this costs,
//     `0` = a real, deliberate "we pay nothing for this". `buildUnitCost` returns `null` for the
//     first — the key never reaches the wire and the panel renders nothing for that unit. A
//     "$0.00 per acted-on thread" is a CLAIM about a reviewer nobody priced.
//     ⚠ AND A THIRD STATE JOINS THEM AT THE BLOCK LEVEL: `monthlyUsd: null` — a price somebody
//     ENTERED that could not be stated, because every priced row folded into the unit is per-seat
//     and every one was dropped by rule 3. That renders (every figure refusing `price_unresolved`,
//     the two seat counters saying why) rather than falling back on the no-price ABSENCE, which
//     would be silence on a card where a human typed a number. See `resolveUnitPrice`.
//
//  2. ⚠ A PRICE OF EXACTLY 0 IS REAL AND ITS DERIVED FIGURES REFUSE. Every division of 0 is 0.00,
//     which is TRUE and reads as a broken panel. The price renders ("recorded as free"); the four
//     derived figures refuse with `price_is_zero` and a sentence that says why. This is the one
//     place in the file where a refusal is chosen over a correct number, and it is chosen because
//     a row of zeros is indistinguishable from a bug.
//
//  3. ⚠ `per_seat` MULTIPLIES ON READ — AND A SEAT COUNT OF ZERO IS RULE 1 ONE LEVEL DOWN. Nothing
//     downstream of `resolveUnitPrice` multiplies seats, and nothing anywhere stores the product
//     (it can exceed int4 as cents and would go stale). ⚠ `seats === 0` is NOT a price of nothing:
//     the count is a PROXY (distinct human pull-request authors over a fixed trailing 30 days) and
//     an empty one is the proxy failing, not the invoice. Multiplying it out produces a COMPUTED
//     zero that rule 2 then reports as a STORED one — "recorded as free" about a reviewer somebody
//     priced at US$15 a developer. Such a row is dropped and counted, exactly like an unresolvable
//     seat count, and it gets its OWN counter because the two have different remedies.
//
//  4. ⚠ ONE FACTOR IS SWAPPED FOR THE COUNTERFACTUAL, NEVER TWO. `atPeerEngagement` replaces the
//     customer's `acted_on_rate` with the cohort's median AND NOTHING ELSE. Multiplying a
//     cohort-p50 volume by a cohort-p50 engagement rate and calling it "what a peer pays" is a real
//     statistical error — THE MEDIAN OF A PRODUCT IS NOT THE PRODUCT OF THE MEDIANS — invisible on
//     screen and wrong in a direction nobody could check. The thread counts and the price stay the
//     CUSTOMER'S, which is the only reason this number may be rendered at all.
//
//  5. ⚠ STATE A RATE, NEVER A HISTORY — THE SPAN MEASURES THE WORK, NEVER THE MONEY. Two facts are
//     available here and neither is historical: a price recorded TODAY, and a throughput observed
//     RECENTLY. The first cut multiplied them into a past — `spanUsd = monthlyUsd × span.days ÷
//     30.44` — and the card asserted "US$236.53 over 8.6 weeks", a spend this app cannot evidence:
//     the price may have changed, the subscription may be younger than the span, and nothing bounds
//     the span by `repoHeldDays`. ⚠ A CAP WOULD NOT HAVE FIXED IT — it keeps the false claim and
//     merely shrinks it. The CLAIM is the defect, so every money figure is now a RATE at the
//     current price and the span only ANNUALISES THE WORK:
//
//         actedPerMonth = actedThreads × (DAYS_PER_MONTH ÷ span.days)
//         perActedOnUsd = monthlyUsd ÷ actedPerMonth
//
//     ⚠ THE ARITHMETIC IS UNCHANGED AND `perActedOnUsd` IS THE SAME NUMBER — `spanUsd ÷ acted` ==
//     `monthlyUsd ÷ actedPerMonth`, which is why its digits are still pinned to what they were.
//     What moved is `unactedUsd` and `conversionGapUsd`, from "over the span" to "a month", and
//     that IS the change: every figure is now a claim about the PRESENT — at your current price
//     and your recent throughput — which is true and checkable.
//     ⚠ A UNIT WHOSE SPAN CANNOT BE OBSERVED STILL REFUSES (`span_unobserved`), including the two
//     arms whose arithmetic no longer divides by it. A per-month rate asserts a RECENT PACE, and
//     counts with no observable stretch of time behind them are not evidence of one. `perMergedPr`
//     is unaffected: 14-day price ÷ 14-day merges, one period, both ends inside a window the
//     repository is separately gated on having been held for.
//     ⚠ MEASURE, DO NOT PROJECT still stands. `actedThreads` is the fold's own
//     `threadsSettledCompleteActed`, never `mergedPrsLast14d × threadsPerMergedPr × actedOnRate` —
//     a strict 14-day merge count times two rates folded over a slice budgeted to roughly NINETY
//     days, which is what the first cut divided the fortnight's price by.
//
//     ⚠⚠ AND AT THE GRAIN THAT ACTUALLY SHIPS, THIS RULE IS NOW VACUOUS — SEE `COST_WINDOW_DAYS`.
//     `buildUnitCost` below is the pinned executable specification of the PER-REPOSITORY block; no
//     request has built one since money moved to `BotBenchmarkWorkspaceRollup.cost`. The rollup's
//     `$ per acted-on thread` divides by a CHOSEN calendar month at both ends and reads no span at
//     all, so "the span annualises the work" describes nothing that ships. It is kept, and kept
//     here, because the ARGUMENT survives its own conclusion: the defect was a per-month claim
//     resting on a window nobody chose, and a future figure that reaches for an observed stretch of
//     time to divide by will re-open it. The span's remaining job is a DISCLOSURE — the
//     observation period in the rollup's evidence table — and it carries no arithmetic.
//
//  6. ⚠ THE TWO MONEY FIGURES ARE DIFFERENT QUANTITIES AND MUST NOT SHARE A SENTENCE. `unacted` is
//     `monthlyUsd × (1 − yourRate)` — what is CURRENTLY BOUGHT AND NOT ACTED ON, per month, at
//     today's price, own data only. The counterfactual's `conversionGapUsd` is
//     `monthlyUsd × (cohortRate − yourRate)` — what CLOSING THE GAP to the median would be worth,
//     per month. They differ by a factor of the cohort rate and the first is always the larger
//     while that rate is below 1. The headline shipped printing the second under the first's words
//     ("US$11.04 … is buying feedback nobody acts on", where the truth was US$33.11), so they are
//     two fields, and the renderer gets two sentences.
//
//  7. ⚠ THE GAP IS A DIFFERENCE OF SHARES, NEVER A RATIO — that is what BOUNDS it. The first cut
//     was `× (1 − yourRate ÷ cohortRate)`, bounded in [0,1] only while the customer sits at or
//     below the median. Real fitted cells have `acted_on_rate` medians as low as 0.24, so a team
//     engaging at 1.0 produced −4.1 × the spend and the panel rendered it as money. Both `unacted`
//     and the gap are now `monthlyUsd` times a quantity in [−1, 1] — a rate, and a difference of
//     two rates — so both are bounded by the MONTHLY PRICE structurally rather than by a clamp. A
//     clamp would hide the next such error instead of preventing it.

/**
 * ⚠ A MONTH IS NOT 28 DAYS, AND IT IS NOT 30 EITHER. 365.25 ÷ 12 = 30.4375, rounded to the
 * hundredth the way a finance team writes it. A monthly subscription prorated over a fortnight at
 * 14/28 overstates by 8.7 %, at 14/30 by 1.4 %; both are wrong in the direction that flatters the
 * finding, which is why the constant is named and not inlined.
 */
export const DAYS_PER_MONTH = 30.44;

/**
 * THE COST WINDOW — one CHOSEN calendar month, and the successor to the observed span.
 *
 * ⚠ WHAT IT REPLACED, AND WHY THE REPLACEMENT IS THE WHOLE POINT. The Workspace rollup's
 * `$ per acted-on thread` used to annualise the reviewer's work across `spanDays`: the stretch
 * between its earliest and latest comment on the walked slice. Three things were wrong with that
 * and they compounded.
 *   1. THE WINDOW WAS DATA-DERIVED, NOT CHOSEN. It was whatever the slice happened to span — 237
 *      days on a real card, for a repository this build had held for 52 — and a monthly price was
 *      then divided by a pace averaged over it.
 *   2. IT WAS AN ORDER STATISTIC WITH NO ROBUSTNESS. `min()` over comment timestamps: ONE old
 *      comment on ONE long-lived pull request still inside the slice set the entire denominator.
 *      `resolveSpan` guarded spans that were too SHORT and had no guard for one too LONG.
 *   3. IT WAS NEVER SHOWN. `spanDays` rode the wire and no component read it, so a reader looking
 *      at "US$783.00 a month" and "255 of 544 threads acted on" could not get from those to the
 *      US$23.94 printed above them. The figure was unverifiable from the card carrying it.
 * On the real card that produced: US$23.94 per acted-on thread, beside the Bots ROI tab's US$3.2
 * for the same reviewer at the same price. Same question, adjacent tabs, an order of magnitude
 * apart — and the ROI tab had already been moved to a CHOSEN window for exactly this reason
 * (`apps/backend/src/db/queries.ts`, `costPerActedOnUsd`, whose comment records the collision).
 *
 * ⚠ WHY 30.44 AND NOT 30. Because `monthlyUsd` is a price for a CALENDAR MONTH, and this constant
 * is the other half of that same fraction. `DAYS_PER_MONTH` exists, and is named rather than
 * inlined, precisely because a 30-day stand-in is wrong by 1.4 % "in the direction that flatters
 * the finding"; introducing a second, shorter month three lines below it to divide the same price
 * would re-open that error AND leave this figure permanently 1.4 % away from the ROI tab's, which
 * annualises its own count by `DAYS_PER_MONTH ÷ windowDays`. At exactly one month the two
 * arithmetics collapse to the same expression — `monthlyUsd ÷ acted` — and the agreement is
 * STRUCTURAL rather than approximate. `benchmark-roi-agreement.test.ts` fails if this constant
 * ever moves away from `DAYS_PER_MONTH`. A card may render the length as "30 days"; the DIVISOR
 * may not be.
 *
 * ⚠ WHY A FIXED WINDOW AND NOT THE ROI TAB'S CHIP. That control is a reader affordance about the
 * current view. This number sits beside a peer placement, and a placement that changed because
 * somebody flipped a window selector on another tab would be worse than the contradiction it
 * fixes — the same argument `dormantVendorKeys` already makes for bot dormancy, which is likewise
 * a FIXED trailing 30 days rather than the chip's.
 */
export const COST_WINDOW_DAYS = DAYS_PER_MONTH;

/**
 * ⚠ THE FLOOR UNDER THE WINDOWED DIVISOR — `below_min_units`' argument, applied to money.
 *
 * A monthly price divided by three acted-on threads is noise wearing a dollar sign: the quotient
 * moves by tens of per cent on one thread landing either side of the window's edge. Ten is the
 * point below which a reader would be right to distrust the figure and has no way to tell.
 *
 * ⚠ THE REMEDY IS TIME, NOT POOLING, which is why this is its own refusal rather than
 * `below_min_units` one grain up: pooling across repositories is exactly what the rollup already
 * did, and it cannot manufacture threads inside a month that had none.
 */
export const COST_WINDOW_MIN_ACTED = 10;

/** Kill binary64 noise without losing sub-cent precision — a high-volume reviewer can genuinely
 *  cost fractions of a cent per thread, and rounding the WIRE to cents would print "$0.00" for it,
 *  which is rule 2's failure mode arriving from the other direction. Presentation rounds; this
 *  does not. */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Money the user typed, summed and seat-multiplied — cents, the storage granularity. ⚠ NOTHING
 *  DERIVED GOES THROUGH HERE: every figure this block computes off that price is a rate, and rates
 *  can genuinely be sub-cent (`round6`, which is a different function for that reason). */
function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── The price, resolved off the unit's folded reviewer rows ─────────────────────────────────────

/** One `workspace_reviewers` row's price, exactly as stored. ⚠ `unitMonthlyUsd === null` is NO
 *  PRICE SET; `0` is a real price. */
export interface StoredReviewerPrice {
  unitMonthlyUsd: number | null;
  costModel: CostModel;
}

export interface ResolvedUnitPrice {
  /** ⚠ `null` = A PRICE WAS ENTERED AND NONE OF IT COULD BE STATED — every priced row folded here
   *  is per-seat and every one was dropped (no seam, or zero seats). It is NOT "no price": that is
   *  a `null` RESOLUTION and no block at all. See `resolveUnitPrice`'s last paragraph. */
  monthlyUsd: number | null;
  costModel: CostModel;
  unitMonthlyUsd: number | null;
  seats: number | null;
  pricedReviewers: number;
  /** Per-seat rows dropped because the host seam is ABSENT. */
  seatPriceUnresolved: number;
  /** Per-seat rows dropped because the workspace resolved to ZERO seats — rule 3. A different
   *  fact from the one above, with a different remedy, so a different counter. */
  seatCountZero: number;
}

/**
 * The price for ONE (repository, vendor) unit, from the rows of every login folded into it.
 *
 * ⚠ TWO LOGINS THE WORKSPACE CALLS ONE VENDOR ARE ONE UNIT, so their prices are SUMMED. That is
 * the sanctioned within-workspace total — the table holds exactly one row per (account, workspace,
 * actor), so a total over a workspace's rows is a plain sum. It is ACROSS workspaces that summing
 * is forbidden, and nothing here crosses one: every row handed in came from a single explicit
 * `workspace_id` predicate.
 *
 * ⚠ A NULL ROW CONTRIBUTES NOTHING AND DOES NOT MAKE THE SUM NULL. One priced login and one
 * unpriced login is a real, common shape (a vendor's second account nobody re-entered the price
 * on); the answer is the one price that exists, with `pricedReviewers: 1` saying so. If NO row
 * carries a price the answer is `null` — the whole block is then absent.
 *
 * ⚠ A PER-SEAT ROW WHOSE SEAT COUNT COULD NOT BE RESOLVED IS DROPPED, NOT READ AS ITS UNIT. The
 * unit price is a per-developer figure; rendering it as the monthly one understates the cost by
 * the seat count, silently. It is dropped and COUNTED (`seatPriceUnresolved`), because a missing
 * disclosure is the same defect as a wrong number, one line quieter.
 *
 * ⚠ AND A SEAT COUNT OF **ZERO** IS DROPPED TOO, UNDER ITS OWN COUNTER — rule 3. `seats === 0` is a
 * COMPUTED zero (the workspace's distinct human pull-request authors over a fixed trailing 30 days
 * came back empty; a maintenance-mode workspace whose only recent pull requests are Dependabot's
 * reaches it while still merging, so no repository-level gate fires). Multiplying US$15 a developer
 * by it yields a monthly figure of exactly 0, which `buildUnitCost` cannot tell from a STORED zero
 * — and the block then prints "Recorded as free" about a reviewer somebody priced. That is rule 1's
 * null-vs-zero conflation one level down, so it gets its own refusal rather than its own zero.
 *
 * ⚠ AND WHEN EVERY PRICED ROW IS DROPPED, THE ANSWER IS A BLOCK WITH NO MONTHLY FIGURE — NOT
 * SILENCE. Dropping the rows and then returning `null` produces the no-price answer (no block at
 * all) for a workspace where somebody DID enter a price, so the two disclosures below have nowhere
 * to appear and the whole card goes quiet: "a missing disclosure is the same defect as a wrong
 * number, one line quieter", arriving as total silence. It is a real shape — a workspace whose ONLY
 * priced reviewer for this unit is per-seat, against an empty or unreadable seat count — so it
 * answers `monthlyUsd: null` with `pricedReviewers: 0`, and `buildUnitCost` refuses every figure
 * with `price_unresolved` while the counters carry the reason onto the screen. `null` here is NOT
 * `0`: rule 1, at the third level down.
 */
export function resolveUnitPrice(
  rows: readonly StoredReviewerPrice[],
  seats: number | null,
): ResolvedUnitPrice | null {
  let total = 0;
  let priced = 0;
  let unresolved = 0;
  let zeroSeats = 0;
  // The two halves are reported only when EXACTLY ONE priced row backs the figure. With two, the
  // "unit × seats" line would describe one of them and the total would be the other, which is a
  // sentence that does not add up on screen.
  let soleModel: CostModel = 'flat';
  let soleUnit: number | null = null;
  for (const row of rows) {
    const unit = row.unitMonthlyUsd;
    // ⚠ `== null`, never `!unit`: 0 is a price and truthiness eats it.
    if (unit == null) continue;
    if (row.costModel === 'per_seat') {
      if (seats == null) {
        unresolved += 1;
        continue;
      }
      // ⚠ `<= 0`, and it is NOT the same branch as `== null` above. A seat count we could not read
      // and a seat count that is genuinely empty are two facts with two remedies (implement the
      // seam · the workspace has no human authors this month), and the panel says both out loud.
      if (seats <= 0) {
        zeroSeats += 1;
        continue;
      }
      total += unit * seats;
    } else {
      total += unit;
    }
    priced += 1;
    soleModel = row.costModel;
    soleUnit = unit;
  }
  if (priced === 0) {
    // ⚠ TWO DIFFERENT NOTHINGS. Nobody entered a price ⇒ no block (rule 1). Somebody entered one
    // and every row of it was dropped ⇒ a block that says so, because the alternative is silence
    // on a card where a human typed a number.
    if (unresolved === 0 && zeroSeats === 0) return null;
    return {
      monthlyUsd: null,
      // TRUE by construction: only `per_seat` rows are ever dropped.
      costModel: 'per_seat',
      unitMonthlyUsd: null,
      seats: null,
      pricedReviewers: 0,
      seatPriceUnresolved: unresolved,
      seatCountZero: zeroSeats,
    };
  }
  const single = priced === 1;
  return {
    monthlyUsd: roundCents(total),
    costModel: single ? soleModel : 'flat',
    unitMonthlyUsd: single && soleModel === 'per_seat' ? soleUnit : null,
    seats: single && soleModel === 'per_seat' ? seats : null,
    pricedReviewers: priced,
    seatPriceUnresolved: unresolved,
    seatCountZero: zeroSeats,
  };
}

// ── The refusals ────────────────────────────────────────────────────────────────────────────────

/** ⚠ ELEVEN SENTENCES, NOT ONE "no data". Each names a different fact with a different remedy, in
 *  the grammar the rest of this tab already uses. The twelfth state — no price set — is the
 *  ABSENCE of the block and therefore has no entry here.
 *
 *  ⚠ EXPORTED BECAUSE THE WORKSPACE ROLLUP REFUSES IN THE SAME VOCABULARY (`rollup.ts`). The two
 *  grains state the same money facts and must state them in the same words: a reader who sees
 *  "recorded as free" on the estate card and a different sentence for the same cause on the
 *  repository card learns to distrust both. The tenth reason is the one only the rollup can reach —
 *  a per-repository figure is unharmed by a truncated ESTATE. */
export const COST_REFUSAL_MESSAGE: Readonly<Record<BotBenchmarkCostRefusalReason, string>> = {
  // ⚠ ONE FACT, TWO WINDOWS. This card divides by two of them — the fourteen-day activity window
  // the merge count sits in, and the calendar month the acted-on threads are counted over — and a
  // repository held for less than either contributes a partial numerator against a whole price.
  // The sentence names both rather than asserting the fortnight, because at the estate grain the
  // month is the threshold that usually fires and a reader told "the activity window" would go
  // looking at the wrong number.
  repo_window_incomplete:
    'This repository has been tracked for less than the window the figure divides by, so the work ' +
    'counted in it is an undercount while the price is whole — which would report this reviewer ' +
    'as costing several times what it does. Two windows are involved and both fail this way: the ' +
    'fourteen-day activity window the merge count sits in, and the calendar month the acted-on ' +
    'threads are counted over. The placement above refuses the fortnight for the same reason.',
  no_merges_in_window:
    'This repository merged nothing in the activity window, so there is no work for the price to ' +
    'be measured against. The placement above refuses for the same reason; dividing by that zero ' +
    'here would contradict it.',
  // ⚠ NAMES ALL THREE CAUSES, because `resolveSpan` returns null on three and the sentence used to
  // assert only the first. The third is not hypothetical: the host stores comment times in UNIX
  // SECONDS, so a reviewer that posts a walkthrough and its findings in the same second leaves many
  // timestamped comments across a span of exactly zero — and was told it had left fewer than two.
  span_unobserved:
    'This reviewer left no measurable stretch of time on the pull requests read here — either ' +
    'fewer than two of its comments carried a timestamp, or every one of them landed at the same ' +
    'recorded instant. Every reviewer-side figure here is a RATE — the ' +
    'monthly price against a recent pace — and counts with no observable stretch of time behind ' +
    'them are not evidence of a pace. Cost per merged pull request is unaffected: it sits on the ' +
    'fourteen-day window at both ends of its fraction.',
  price_unresolved:
    'A price is recorded for this reviewer in this Workspace and none of it could be stated: every ' +
    'priced account folded into this card is charged per seat, and the seat count was either ' +
    'unreadable or empty. The figure is missing, not the price — the disclosures on this card say ' +
    'which of the two happened. Reading a per-developer unit as a monthly total would understate ' +
    'the cost by the seat count, silently.',
  own_rate_withheld:
    'Your own acted-on rate was withheld for this reviewer, so nothing may be derived from it. ' +
    'The metric row above says which gate fired — and the raw thread counts are deliberately not ' +
    'read past it: a rate over a handful of threads is the number that gate exists to refuse.',
  nothing_acted_on:
    'No thread this reviewer settled here was acted on, so there is no unit of work to divide the ' +
    'price by. The unacted figure and the peer comparison still render — this is the case they ' +
    'exist for.',
  price_is_zero:
    'This reviewer is recorded as costing this Workspace nothing — a stored, deliberate zero, ' +
    'never a per-seat price multiplied by an empty seat count. Every figure derived from a price ' +
    'of zero is exactly zero, which is true and says nothing, so it is not reported as a ' +
    'measurement.',
  cohort_rate_unfitted:
    'The peer cohort published no acted-on rate for this cell, so there is no median to put in ' +
    'place of yours. Your own figures above are unaffected.',
  cohort_rate_zero:
    'The peer cohort’s median acted-on rate in this cell is zero, so the counterfactual would ' +
    'divide by nothing. Nobody acts on this reviewer anywhere in this band.',
  // ⚠ REACHABLE ONLY FROM THE ROLLUP, and it is the successor to what `span_unobserved` used to
  // catch at that grain: a per-month claim whose evidence is too thin to make it.
  window_underpopulated:
    'Fewer than ten of this reviewer’s threads settled AND were acted on in the last month, which ' +
    'is too few to divide a monthly price by: one thread landing either side of the window’s edge ' +
    'would move the figure by tens of per cent. The counters and the acted-on rate above are over ' +
    'every pull request read here and are unaffected. This is a statement about the last month ' +
    'only — a reviewer with months of history behind an empty one is dormant, and averaging its ' +
    'whole history against today’s price would answer a different question.',
  // ⚠ REACHABLE ONLY FROM THE ROLLUP. A per-repository figure is about its own repository and is
  // unharmed by other repositories going unread; a WORKSPACE figure divides one whole price by a
  // sum over repositories, and a missing term makes it wrong in the flattering direction — the
  // price is complete and the work is not.
  workspace_truncated:
    'This Workspace holds more repositories than one request folds, so the work these figures ' +
    'would be divided by is incomplete while the price is whole — every one of them would read ' +
    'too high, and by an amount nothing here can state. The counters and the placement spread ' +
    'above are honest sums and ranks over the repositories that were read; the money is not, so ' +
    'it is withheld rather than approximated. Narrow to a repository to read its own figures.',
};

/** The refusal constructor, exported for `rollup.ts` so both grains build the same object from the
 *  same sentence — see `COST_REFUSAL_MESSAGE`. */
export function costRefusal(
  reason: BotBenchmarkCostRefusalReason,
  extra?: { metric: string; metricReason?: BotBenchmarkUnitExclusionReason },
): BotBenchmarkCostRefusal {
  const out: BotBenchmarkCostRefusal = {
    status: 'refused',
    reason,
    message: COST_REFUSAL_MESSAGE[reason],
  };
  if (extra != null) {
    out.metric = extra.metric;
    if (extra.metricReason != null) out.metricReason = extra.metricReason;
  }
  return out;
}

// ── Reading the unit's own threads ──────────────────────────────────────────────────────────────

const ACTED_ON_RATE = 'acted_on_rate';

/** The two counts `acted_on_rate` is built from, straight off the fold's outcome counters. */
export interface ActedThreadCounts {
  /** `threadsSettledCompleteActed` — an ACTUAL count over the walked slice, not a projection. */
  acted: number;
  /** `threadsSettledComplete` — the rate's denominator. */
  settled: number;
}

/**
 * The customer's own measured engagement with this reviewer: the counts, and the rate DERIVED from
 * them.
 *
 * ⚠ THE METRIC IS THE GATE AND THE COUNTERS ARE THE VALUE, and mixing that up in either direction
 * is a defect. Reading the RATE off the metric while printing the COUNTS beside it gives two
 * sources for one fact that can silently disagree; reading the COUNTS without consulting the metric
 * walks straight past `below_min_units`, which the fold applies precisely because a rate over a
 * handful of threads is noise wearing a percentage sign. So: the metric decides whether anything
 * may be said, the counters say it.
 *
 * ⚠ BOTH `compared` AND `uncompared` PASS. Only `uncompared` lacks a COHORT — the customer's own
 * arithmetic is untouched by a thin peer cell, and dropping it would delete their figures because
 * somebody else's sample was small.
 */
function ownEngagement(
  metrics: Record<string, BotBenchmarkPlacementMetric>,
  counts: ActedThreadCounts,
): { rate: number; counts: ActedThreadCounts } | BotBenchmarkCostRefusal {
  const metric = metrics[ACTED_ON_RATE];
  if (metric == null) return costRefusal('own_rate_withheld', { metric: ACTED_ON_RATE });
  if (metric.status === 'excluded') {
    return costRefusal('own_rate_withheld', { metric: ACTED_ON_RATE, metricReason: metric.reason });
  }
  // ⚠ DEFENSIVE, AND IT SHOULD NEVER FIRE: an `acted_on_rate` that survived `compare()` had a
  // non-empty denominator (`denominator_empty` is one of the exclusions). It refuses rather than
  // dividing, because the alternative here is an Infinity reaching the wire as a JSON `null`.
  if (!(counts.settled > 0)) return costRefusal('own_rate_withheld', { metric: ACTED_ON_RATE });
  return { rate: round6(counts.acted / counts.settled), counts };
}

/**
 * The cohort's MEDIAN acted-on rate in this cell — the ONE factor the counterfactual swaps.
 *
 * ⚠ AN `excluded` ARM CARRIES NO COHORT AT ALL — `compare()` withholds before it ever reads the
 * cell — so the cohort's median may well be fitted and is simply not on this payload. The honest
 * sentence names the CUSTOMER-side gate that hid it, not a cohort refusal that may not exist.
 */
function cohortActedOnRate(
  metrics: Record<string, BotBenchmarkPlacementMetric>,
): number | BotBenchmarkCostRefusal {
  const metric = metrics[ACTED_ON_RATE];
  if (metric == null) return costRefusal('own_rate_withheld', { metric: ACTED_ON_RATE });
  if (metric.status === 'excluded') {
    return costRefusal('own_rate_withheld', { metric: ACTED_ON_RATE, metricReason: metric.reason });
  }
  if (metric.status === 'uncompared') return costRefusal('cohort_rate_unfitted');
  const p50 = metric.cohort.quantiles['p50'];
  if (typeof p50 !== 'number' || !Number.isFinite(p50)) return costRefusal('cohort_rate_unfitted');
  if (p50 <= 0) return costRefusal('cohort_rate_zero');
  return p50;
}

function isRefusal(v: unknown): v is BotBenchmarkCostRefusal {
  return typeof v === 'object' && v !== null && (v as { status?: string }).status === 'refused';
}

// ── The block ───────────────────────────────────────────────────────────────────────────────────

// ⚠ NO DIRECTIONAL WORD ("above"/"below"). This sentence is SERVED and the renderer chooses where
// to put it; the first draft said "the comparison below" and shipped underneath the comparison it
// was pointing at, which was visible the moment the panel was opened and invisible to every test.
export const SPAN_NOTE =
  'The reviewer-side figures are RATES at the price recorded today, never a history: the monthly ' +
  'price against the throughput measured over the stretch of time this reviewer’s own comments ' +
  'cover on the pull requests read here — its earliest to its latest. That stretch is the ' +
  'measurement window for the WORK and nothing else; no spend over it is claimed, because the ' +
  'price may have changed since and the subscription may be younger than the window. It is also ' +
  'not the fourteen-day window the placement is banded on: the read slice is budgeted from the ' +
  'merge rate and reaches back roughly ninety days. Cost per merged pull request is the one figure ' +
  'here that sits on that fourteen-day window, at both ends of the fraction.';

export interface UnitCostInput {
  /** `null` ⇒ NO PRICE SET for this reviewer in this Workspace ⇒ no block at all. */
  price: ResolvedUnitPrice | null;
  /** The placement's 14-day banding window — `perMergedPr`'s basis, and NOTHING ELSE'S. */
  windowDays: number;
  /** ⚠ ANY AUTHOR — the banding axis. `perMergedPr`'s divisor. */
  mergedPrsLast14d: number;
  /** Days since the host first held this repository. Below `windowDays` the merge count is a
   *  partial-window UNDERCOUNT that lands in `perMergedPr`'s denominator, and the placement above
   *  refuses the whole unit for it — so every arm refuses with the placement's own sentence. */
  repoHeldDays: number;
  /** ⚠ THE REVIEWER'S OWN OBSERVED WORKING PERIOD on the walked slice, in epoch milliseconds — the
   *  measurement window for the WORK, and never a billing period. `null` — or an interval that is
   *  zero-length or rounds to none — ⇒ every span-anchored arm refuses. See rule 5. */
  span: { fromMs: number; toMs: number; comments: number } | null;
  /** ⚠ REAL COUNTS off the fold's outcome counters: `threadsSettledCompleteActed` and
   *  `threadsSettledComplete`, the numerator and denominator of `acted_on_rate`. Rule 5. */
  threads: ActedThreadCounts;
  metrics: Record<string, BotBenchmarkPlacementMetric>;
  /** How many units in this response carry this same per-WORKSPACE price. */
  sharedWithUnits: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * One unit's cost block, or `null` when no price is set (rule 1).
 *
 * ⚠ THE GUARD ORDER IS THE RULE, and it mirrors `cohortFor`'s: facts about the REPOSITORY come
 * before facts about the money, which come before facts about the REVIEWER, which come before facts
 * about the SPAN, which come before facts about the cohort. A repository that merged nothing must
 * say so with the same sentence the placement above it used, whatever the price happens to be —
 * two different refusals on one card for one cause is how a reader stops believing either. And the
 * reviewer's gate outranks the span's because a reviewer that said nothing here has no span either,
 * and "said nothing here" is the half of that pair with a remedy attached.
 *
 * ⚠ THE TWO REPOSITORY GATES REFUSE EVERY ARM, INCLUDING THE SPAN-ANCHORED ONES, and that is a
 * decision about the CARD rather than about a denominator. Only `perMergedPr` divides by the merge
 * count, so only it is arithmetically endangered; but the placement immediately above has just said
 * it cannot measure this repository at all, and a priced figure rendered beside that refusal is two
 * answers to one question on one card.
 */
export function buildUnitCost(input: UnitCostInput): BotBenchmarkPlacementCost | null {
  const { price, windowDays, mergedPrsLast14d, repoHeldDays, metrics, sharedWithUnits } = input;
  if (price == null) return null;

  const windowPrice = (monthly: number): number => round6((monthly * windowDays) / DAYS_PER_MONTH);
  const windowUsd = price.monthlyUsd == null ? null : windowPrice(price.monthlyUsd);
  // ⚠ THE REPOSITORY'S TWO GATES, IN `cohortFor`'S OWN ORDER: an INCOMPLETE window first (the
  // merge count is an undercount and inflates every figure that divides by it), then a COMPLETE
  // window the repository did not use (the count is honestly zero and divides by nothing). Two
  // causes, two sentences, and both are facts about the repository rather than the price.
  const partialWindow = repoHeldDays < windowDays;
  const noMerges = mergedPrsLast14d <= 0;
  const repoRefusal = partialWindow
    ? costRefusal('repo_window_incomplete')
    : noMerges
      ? costRefusal('no_merges_in_window')
      : null;

  // THE MONEY, or the one refusal that stands in for it — repository facts first, then the two
  // ways a price can exist and still not be usable: entered but unstatable, and a real, stored 0.
  const money: number | BotBenchmarkCostRefusal =
    repoRefusal ??
    (price.monthlyUsd == null
      ? costRefusal('price_unresolved')
      : price.monthlyUsd === 0
        ? costRefusal('price_is_zero')
        : price.monthlyUsd);

  // ⚠ PURELY THE WORK'S MEASUREMENT WINDOW — no price reaches it. Rule 5.
  const span = resolveSpan(input.span);

  const perMergedPr: BotBenchmarkPlacementCost['perMergedPr'] = isRefusal(money)
    ? money
    : {
        status: 'value',
        // ⚠ INDEPENDENT OF THE REVIEWER. This divides a price by the repository's own merges and
        // asks nothing of the bot, so it survives every metric being withheld — which is exactly
        // when it is most worth reading ("you paid this much and it said nothing here"). ⚠ AND
        // IT IS THE ONE ARM THE SPAN DOES NOT TOUCH: window price ÷ window merges, one period.
        value: round6(windowPrice(money) / mergedPrsLast14d),
        mergedPrs: mergedPrsLast14d,
      };

  // ⚠ THE THREE SPAN-ANCHORED ARMS SHARE ONE PRELUDE, so a gate can never fire on one and not
  // another: each takes `money` and `engagement` and checks them IN THAT ORDER, which is the doc
  // comment's order — and note that the REVIEWER's own gate runs BEFORE the span's, deliberately:
  // a reviewer that said nothing here has no span EITHER, and "said nothing here" is the fact with
  // the remedy. `span_unobserved` is reserved for a reviewer that demonstrably spoke and still left
  // no measurable stretch of time.
  const engagement = ownEngagement(metrics, input.threads);

  const unacted = buildUnacted(money, engagement, span);
  const yours = buildYours(money, engagement, span);
  const atPeerEngagement = buildCounterfactual(money, engagement, span, metrics, yours);

  return {
    monthlyUsd: price.monthlyUsd,
    costModel: price.costModel,
    unitMonthlyUsd: price.unitMonthlyUsd,
    seats: price.seats,
    pricedReviewers: price.pricedReviewers,
    seatPriceUnresolved: price.seatPriceUnresolved,
    seatCountZero: price.seatCountZero,
    windowDays,
    windowUsd,
    span,
    sharedWithUnits,
    perMergedPr,
    unacted,
    yours,
    atPeerEngagement,
    spanNote: SPAN_NOTE,
  };
}

/**
 * The observed span → the wire's span block, or `null`. ⚠ NO PRICE ENTERS THIS FUNCTION: the span
 * is the measurement window for the WORK, and the money is a rate at today's price (rule 5).
 *
 * ⚠ A ZERO-LENGTH SPAN IS `null`, NOT A SPAN OF ZERO DAYS. Two comments in the same instant, or one
 * comment on its own, describe no stretch of time.
 *
 * ⚠ AND THE GUARD IS ON THE ROUNDED FIGURE, WHICH IS THE ONE THE WIRE CARRIES AND THE ONE THE
 * ARITHMETIC DIVIDES BY. `days` is what a reader can recompute `perActedOnUsd` from, so it has to
 * be the divisor too — and a span under ~0.09 s rounds to exactly 0 at six places, which would make
 * `actedPerMonth` an Infinity and put a non-finite number on the wire as a JSON `null`. Under the
 * old basis the same input produced a `spanUsd` of 0 and a silent, finite WRONG ZERO instead; the
 * arithmetic moved, so the guard moved with it.
 *
 * ⚠ EXPORTED SO THE WORKSPACE ROLLUP READS ITS `spanDays` THROUGH THIS FUNCTION AND NOT A SECOND
 * ONE. Every rule above is a decision — fewer than two comments is no stretch, a zero-length
 * interval is no stretch, a sub-0.09-second interval rounds to a divisor of zero — and a second
 * implementation that agreed on two of the three would put an Infinity on the estate card while the
 * repository card beside it refused. One span rule, one place.
 *
 * ⚠ THE ROLLUP NO LONGER DIVIDES BY THIS. Its `spanDays` is a DISCLOSURE in the evidence table —
 * the stretch this reviewer's own output covers in that repository — and the money beside it is a
 * chosen calendar month at both ends (`COST_WINDOW_DAYS`). The sub-0.09-second guard therefore
 * protects one caller today (`buildUnitCost`, the pinned per-repository specification) and a
 * displayed figure at the other; it stays because a rounded zero is still a wrong number on a
 * screen, and because the day something divides by a span again it must divide by this one.
 */
export function resolveSpan(
  observed: { fromMs: number; toMs: number; comments: number } | null,
): BotBenchmarkCostSpan | null {
  if (observed == null || observed.comments < 2) return null;
  const ms = observed.toMs - observed.fromMs;
  if (!(ms > 0) || !Number.isFinite(ms)) return null;
  const days = round6(ms / MS_PER_DAY);
  if (!(days > 0)) return null;
  return {
    days,
    fromIso: new Date(observed.fromMs).toISOString(),
    toIso: new Date(observed.toMs).toISOString(),
    comments: observed.comments,
  };
}

type Engagement = { rate: number; counts: ActedThreadCounts };

/** THE SPAN ANNUALISES THE WORK AND NOTHING ELSE — a count over the observed stretch, restated as a
 *  count per month, so a monthly price can be divided by it (rule 5). ⚠ It divides by the ROUNDED
 *  `span.days`, which is the figure on the wire, so the quotient is checkable from the payload. */
function perMonth(count: number, span: BotBenchmarkCostSpan): number {
  return (count * DAYS_PER_MONTH) / span.days;
}

/**
 * WHAT IS CURRENTLY BOUGHT AND NOT ACTED ON — `monthlyUsd × (1 − yourRate)`, per month, at today's
 * price, own data only (rule 6).
 *
 * ⚠ IT DOES NOT REFUSE ON A ZERO ACTED-ON RATE, and that is the entire reason it is its own arm.
 * At `rate === 0` the per-thread figure is a division by zero and refuses; this figure is then the
 * whole monthly price, which is the strongest finding the block can produce and exactly what the
 * reader needs.
 *
 * ⚠ IT STILL REFUSES WITHOUT A SPAN even though its arithmetic no longer divides by one. The
 * sentence it feeds is a claim about the PRESENT — this is what the subscription is buying now —
 * and that warrant comes from the observed stretch of time, not from the arithmetic. Counts with no
 * measurable stretch behind them are not evidence of a current pace. (`perMergedPr`, by contrast,
 * carries its own fourteen-day window at both ends and is not withheld here.)
 */
function buildUnacted(
  monthlyUsd: number | BotBenchmarkCostRefusal,
  engagement: Engagement | BotBenchmarkCostRefusal,
  span: BotBenchmarkCostSpan | null,
): BotBenchmarkCostUnacted | BotBenchmarkCostRefusal {
  if (isRefusal(monthlyUsd)) return monthlyUsd;
  if (isRefusal(engagement)) return engagement;
  if (span == null) return costRefusal('span_unobserved');
  return {
    status: 'value',
    actedOnRate: engagement.rate,
    actedThreads: engagement.counts.acted,
    settledThreads: engagement.counts.settled,
    // ⚠ BOUNDED IN [0, monthlyUsd] BECAUSE THE RATE IS A RATE. Rule 7's guarantee, one arm over.
    unactedUsd: round6(monthlyUsd * (1 - engagement.rate)),
  };
}

/** The customer's own price per acted-on thread — the monthly price divided by the monthly PACE the
 *  span measures (rule 5). Nothing here is projected, and nothing here is historical. */
function buildYours(
  monthlyUsd: number | BotBenchmarkCostRefusal,
  engagement: Engagement | BotBenchmarkCostRefusal,
  span: BotBenchmarkCostSpan | null,
): BotBenchmarkCostYours | BotBenchmarkCostRefusal {
  if (isRefusal(monthlyUsd)) return monthlyUsd;
  if (isRefusal(engagement)) return engagement;
  if (span == null) return costRefusal('span_unobserved');
  const acted = engagement.counts.acted;
  if (!(acted > 0)) return costRefusal('nothing_acted_on');
  const actedPerMonth = perMonth(acted, span);
  return {
    status: 'value',
    actedThreads: acted,
    settledThreads: engagement.counts.settled,
    actedOnRate: engagement.rate,
    actedPerMonth: round6(actedPerMonth),
    // ⚠ IDENTICAL TO THE `spanUsd ÷ acted` IT REPLACED — `spanUsd ÷ acted` == `monthlyUsd ÷
    // (acted × 30.44 ÷ spanDays)` — which is why the change of basis moved no digit here. What
    // changed is the CLAIM: a rate at the current price, not a share of a past bill.
    perActedOnUsd: round6(monthlyUsd / actedPerMonth),
  };
}

function buildCounterfactual(
  monthlyUsd: number | BotBenchmarkCostRefusal,
  engagement: Engagement | BotBenchmarkCostRefusal,
  span: BotBenchmarkCostSpan | null,
  metrics: Record<string, BotBenchmarkPlacementMetric>,
  yours: BotBenchmarkCostYours | BotBenchmarkCostRefusal,
): BotBenchmarkCostAtPeerEngagement | BotBenchmarkCostRefusal {
  if (isRefusal(monthlyUsd)) return monthlyUsd;
  if (isRefusal(engagement)) return engagement;
  if (span == null) return costRefusal('span_unobserved');
  const cohortRate = cohortActedOnRate(metrics);
  if (isRefusal(cohortRate)) return cohortRate;
  // ⚠ THE ONE SWAP. The settled-thread COUNT is the customer's; only the rate is the cohort's. A
  // second cohort quantile in this expression — a peer volume, a peer thread rate — turns a bounded
  // what-if into a median-of-a-product error nobody could check.
  const actedAtPeer = engagement.counts.settled * cohortRate;
  // ⚠ DEFENCE IN DEPTH, AND UNREACHABLE TODAY — recorded rather than dressed up as a live guard.
  // `ownEngagement` has already proved `settled > 0` and `cohortActedOnRate` has already proved
  // `p50 > 0`, so this product cannot be zero and NO MUTATION OF THIS LINE TURNS A TEST RED
  // (verified against the finiteness sweep in `benchmark-cost.test.ts`). It stays because a future
  // caller reaching this fold without those two proofs would otherwise divide by zero silently.
  if (!(actedAtPeer > 0)) return costRefusal('nothing_acted_on');
  const actedPerMonthAtPeer = perMonth(actedAtPeer, span);
  const perActedOnUsd = round6(monthlyUsd / actedPerMonthAtPeer);
  return {
    status: 'value',
    cohortActedOnRate: cohortRate,
    actedThreadsAtPeer: round6(actedAtPeer),
    actedPerMonthAtPeer: round6(actedPerMonthAtPeer),
    perActedOnUsd,
    perActedOnGapUsd:
      yours.status === 'value' ? round6(yours.perActedOnUsd - perActedOnUsd) : null,
    // WHAT BETTER ENGAGEMENT WOULD BE WORTH, PER MONTH. ⚠ A DIFFERENCE OF TWO SHARES, NEVER A RATIO
    // (rule 7): both factors are rates in [0,1], so this is bounded in [−monthlyUsd, monthlyUsd]
    // structurally. Negative is a real, GOOD state — this team engages more than the cohort's
    // median — and the renderer must not word it as waste. Defined even when `yours` refused: a
    // rate of 0 made the per-thread figure a division by zero, and this arm still has something
    // true to say.
    //
    // ⚠ AND IT IS NOT `unacted.unactedUsd`. That one is what the price currently buys and nobody
    // acts on; this is what closing the gap to the median would be worth. The headline printed this
    // number under that one's words, understating the first by a factor of the cohort rate.
    conversionGapUsd: round6(monthlyUsd * (cohortRate - engagement.rate)),
  };
}
