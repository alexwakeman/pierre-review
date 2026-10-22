// COST ON THE BENCHMARK TAB — the arithmetic and every refusal in it.
//
// `benchmark-placement.test.ts` proves the price reaches this fold from the host's tables and that
// the block is absent/present in the right end-to-end shapes. This file proves the MATHS, over a
// pure module with no database: what the numbers are, which of them refuse, and — the two that
// matter most — that every money figure is a RATE AT THE CURRENT PRICE rather than a spend over
// some past period, and that the counterfactual swaps EXACTLY ONE FACTOR.
//
// ⚠ THE SPAN CARRIES NO MONEY. It shipped with a `usd` field — today's price prorated across the
// reviewer's whole comment span — and every reviewer-side figure was a share of it, so the card
// asserted "US$236.53 over 8.6 weeks": a history nothing here can evidence. `perActedOnUsd` is
// pinned to the SAME DIGITS it had (the arithmetic is identical: `spanUsd ÷ acted` ==
// `monthlyUsd ÷ actedPerMonth`), and the two figures that genuinely moved — `unactedUsd` and
// `conversionGapUsd` — are pinned against BOTH answers, so a revert is named rather than silent.
//
// ⚠ EVERY FIXTURE BELOW GIVES THE COHORT A `threads_per_merged_pr` MEDIAN THAT DIFFERS FROM THE
// CUSTOMER'S, and one test builds twice with two DIFFERENT such medians and demands an identical
// block. That is not decoration: it is what makes "let a second cohort quantile back into the
// counterfactual" observable. Without it an implementation that multiplied two cohort quantiles
// together could produce numbers no assertion here could tell apart — a test that cannot fail,
// which this package has shipped six of.
//
// ⚠ AND NOTHING HERE ASSERTS OVER `JSON.stringify`. `JSON.stringify` renders `Infinity`, `-Infinity`
// and `NaN` as the literal `null`, so a regex hunting for those tokens in a serialised block CANNOT
// MATCH and the guarantee it claims to check is unverified. `expectAllFinite` walks the live values.
//
// Runs from the backend workspace (@pierre/pro ships no vitest devDep):
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test
import { describe, expect, it } from 'vitest';
import type {
  BotBenchmarkCostRefusalReason,
  BotBenchmarkPlacementMetric,
} from '@pierre-review/shared';
import {
  COST_REFUSAL_MESSAGE,
  DAYS_PER_MONTH,
  buildUnitCost,
  resolveUnitPrice,
  type ActedThreadCounts,
  type ResolvedUnitPrice,
} from '../bots/benchmark/cost.js';

const WINDOW_DAYS = 14;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 31);

/**
 * ⚠ ASSERT ON THE VALUES, NEVER ON THE SERIALISED STRING.
 *
 * The assertion this replaced was `expect(JSON.stringify(cost)).not.toMatch(/Infinity|NaN/)`, which
 * can never fail: `JSON.stringify({a: Infinity, b: NaN})` is `{"a":null,"b":null}`, so neither token
 * can appear in the string being searched. A relaxed divide-by-zero guard would have produced a
 * `perActedOnUsd` of `Infinity`, reached the wire as `null`, rendered as an em dash — and left both
 * "no Infinity anywhere" assertions green.
 *
 * This walks the live object and fails on the first non-finite number, naming its path.
 */
function expectAllFinite(value: unknown, path = 'cost'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${String(value)}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectAllFinite(v, `${path}.${k}`);
  }
}

/** A `compared` metric: the customer's own value plus the cohort's fitted quantiles. */
function compared(value: number, p50: number): BotBenchmarkPlacementMetric {
  return {
    status: 'compared',
    value,
    units: 20,
    percentile: 50,
    cohort: {
      nRepos: 60,
      quantiles: { p10: p50 / 2, p25: p50, p50, p75: p50, p90: p50 * 2 },
      ciMedian95: null,
      direction: 'higher_is_better',
      minUnits: 5,
      unit: 'rate',
    },
  };
}

/** The customer HAS a value; the COHORT refused this metric in this cell. */
function uncompared(value: number): BotBenchmarkPlacementMetric {
  return {
    status: 'uncompared',
    value,
    units: 20,
    reason: 'cohort_metric_refused',
    cohortRefusal: { rule: 'cell_floor', message: 'x' },
  };
}

function excluded(reason: 'below_min_units' | 'vendor_silent'): BotBenchmarkPlacementMetric {
  return { status: 'excluded', reason, message: 'x' };
}

/**
 * The house fixture. Twenty settled threads of which four were acted on (20 %), against a cohort
 * whose median acted-on rate is 60 % — and whose median THREAD rate is 3.0, twice the customer's.
 */
function metrics(
  over: Partial<Record<'threads_per_merged_pr' | 'acted_on_rate', BotBenchmarkPlacementMetric>> = {},
): Record<string, BotBenchmarkPlacementMetric> {
  return {
    threads_per_merged_pr: over.threads_per_merged_pr ?? compared(1.5, 3.0),
    acted_on_rate: over.acted_on_rate ?? compared(0.2, 0.6),
  };
}

const flat = (monthlyUsd: number): ResolvedUnitPrice => ({
  monthlyUsd,
  costModel: 'flat',
  unitMonthlyUsd: null,
  seats: null,
  pricedReviewers: 1,
  seatPriceUnresolved: 0,
  seatCountZero: 0,
});

/** SIXTY DAYS of observed reviewer output, ending a month ago. ⚠ DELIBERATELY NOT FOURTEEN: every
 *  money figure below would be identical under both bases if the span happened to equal the window,
 *  and the whole defect this replaced was a fortnight's price divided into a slice's work. */
const SPAN = { fromMs: NOW - 90 * DAY, toMs: NOW - 30 * DAY, comments: 20 };

function build(
  price: ResolvedUnitPrice | null,
  opts: {
    mergedPrsLast14d?: number;
    repoHeldDays?: number;
    span?: { fromMs: number; toMs: number; comments: number } | null;
    threads?: ActedThreadCounts;
    metrics?: Record<string, BotBenchmarkPlacementMetric>;
    sharedWithUnits?: number;
  } = {},
) {
  return buildUnitCost({
    price,
    windowDays: WINDOW_DAYS,
    mergedPrsLast14d: opts.mergedPrsLast14d ?? 10,
    // A repository the host has held for a year: the window is COMPLETE, so the merge count is a
    // real count rather than an undercount. The partial-window case has its own test below.
    repoHeldDays: opts.repoHeldDays ?? 400,
    span: opts.span === undefined ? SPAN : opts.span,
    threads: opts.threads ?? { acted: 4, settled: 20 },
    metrics: opts.metrics ?? metrics(),
    sharedWithUnits: opts.sharedWithUnits ?? 1,
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('the price itself: null is not zero, and per_seat multiplies on read', () => {
  it('answers null when NO row carries a price — the block is absent, not empty', () => {
    // ⚠ THE WHOLE POINT. `null` = nobody has said what this costs. A block rendering "US$0.00 per
    // acted-on thread" would be a claim about a reviewer nobody priced.
    expect(resolveUnitPrice([{ unitMonthlyUsd: null, costModel: 'flat' }], 8)).toBeNull();
    expect(resolveUnitPrice([], 8)).toBeNull();
    expect(build(null)).toBeNull();
  });

  it('treats a stored 0 as a REAL price, never as a missing one', () => {
    // ⚠ `0` = "we pay nothing for this", deliberately recorded. Any implementation that leans on
    // truthiness collapses this into the null case and the distinction disappears from the product.
    const price = resolveUnitPrice([{ unitMonthlyUsd: 0, costModel: 'flat' }], 8);
    expect(price).not.toBeNull();
    expect(price?.monthlyUsd).toBe(0);
    expect(price?.pricedReviewers).toBe(1);
  });

  it('multiplies a per-seat unit by the seat count ON READ, and reports both halves', () => {
    const price = resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], 8);
    expect(price?.monthlyUsd).toBe(120); // 15 × 8 — the product is never stored
    expect(price?.unitMonthlyUsd).toBe(15);
    expect(price?.seats).toBe(8);
    expect(price?.costModel).toBe('per_seat');
  });

  it('DROPS a per-seat price it cannot resolve rather than reading the unit as the monthly', () => {
    // ⚠ Reading US$15/developer as US$15/month understates by the seat count, silently and in the
    // direction that flatters the reviewer. It is excluded and COUNTED instead.
    const price = resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], null);
    // ⚠ NOT `null`, AND THAT IS THE FIX. `null` is the NO-PRICE answer and produces no block at
    // all — total silence on a card where somebody typed US$15 a developer, taking the disclosure
    // that explains it off the screen too. The monthly figure is what is missing, not the price.
    expect(price).not.toBeNull();
    expect(price?.monthlyUsd).toBeNull();
    expect(price?.pricedReviewers).toBe(0);
    expect(price?.seatPriceUnresolved).toBe(1);
    expect(price?.seatCountZero).toBe(0);
    const mixed = resolveUnitPrice(
      [
        { unitMonthlyUsd: 15, costModel: 'per_seat' },
        { unitMonthlyUsd: 40, costModel: 'flat' },
      ],
      null,
    );
    expect(mixed?.monthlyUsd).toBe(40);
    expect(mixed?.seatPriceUnresolved).toBe(1);
    expect(mixed?.seatCountZero).toBe(0);
    expect(mixed?.pricedReviewers).toBe(1);
  });

  it('DROPS a per-seat price against ZERO seats too — a computed zero is not a stored one', () => {
    // ⚠ RULE 1, ONE LEVEL DOWN, AND IT SHIPPED WRONG. `resolveUnitPrice` multiplied a per-seat unit
    // by the seat count with no guard, and `buildUnitCost` then tested `monthlyUsd === 0` — so a
    // maintenance-mode workspace (distinct human pull-request authors over the trailing 30 days is
    // 0, while merges by any author are not, so no repository gate fires) rendered "US$15.00 per
    // seat × 0 seats" beside "Recorded as free: this reviewer is recorded as costing this Workspace
    // nothing". Somebody typed US$15 a developer. That sentence is false.
    const alone = resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], 0);
    // ⚠ A BLOCK WITH NO MONTHLY FIGURE, exactly as an unresolvable one — never `null`, which is the
    // no-price answer and would render nothing at all for a reviewer somebody priced.
    expect(alone?.monthlyUsd).toBeNull();
    expect(alone?.seatCountZero).toBe(1);
    expect(alone?.seatPriceUnresolved).toBe(0);
    expect(alone?.pricedReviewers).toBe(0);
    const mixed = resolveUnitPrice(
      [
        { unitMonthlyUsd: 15, costModel: 'per_seat' },
        { unitMonthlyUsd: 40, costModel: 'flat' },
      ],
      0,
    );
    // ⚠ THE MUTATION LIVES ON THIS LINE. Without the `seats <= 0` guard the total is 40 + 15×0 = 40
    // and `seatCountZero` is 0 — the SAME total, so a test asserting only `monthlyUsd` could not
    // tell the two implementations apart. The counter is what makes the drop observable.
    expect(mixed?.monthlyUsd).toBe(40);
    expect(mixed?.seatCountZero).toBe(1);
    expect(mixed?.pricedReviewers).toBe(1);
    // ⚠ AND IT IS ITS OWN COUNTER, NOT `seatPriceUnresolved`. "This build cannot read your seat
    // count" and "your seat count is zero this month" have different remedies.
    expect(mixed?.seatPriceUnresolved).toBe(0);
    // A NEGATIVE seat count is the same fact arriving through a broken seam.
    expect(resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], -3)?.monthlyUsd).toBeNull();
    // …and a seat count of 1 is a real, ordinary answer that must NOT be swept up with it.
    expect(resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], 1)?.monthlyUsd).toBe(15);
  });

  it('sums the rows of the logins folded into ONE unit, and an unpriced row adds nothing', () => {
    // Two logins the Workspace calls one vendor are ONE unit. Within a workspace there is exactly
    // one row per actor, so a total over them is the sanctioned plain sum — it is ACROSS workspaces
    // that summing is forbidden, and nothing here crosses one.
    const both = resolveUnitPrice(
      [
        { unitMonthlyUsd: 100, costModel: 'flat' },
        { unitMonthlyUsd: 20, costModel: 'flat' },
      ],
      8,
    );
    expect(both?.monthlyUsd).toBe(120);
    expect(both?.pricedReviewers).toBe(2);
    // ⚠ …and the per-seat detail is DROPPED once two rows back the figure: "US$15 × 8 seats" would
    // describe one of them while the total described the other.
    const mixed = resolveUnitPrice(
      [
        { unitMonthlyUsd: 15, costModel: 'per_seat' },
        { unitMonthlyUsd: 20, costModel: 'flat' },
      ],
      8,
    );
    expect(mixed?.monthlyUsd).toBe(140);
    expect(mixed?.unitMonthlyUsd).toBeNull();
    expect(mixed?.seats).toBeNull();
    expect(mixed?.costModel).toBe('flat');
    // One priced login and one unpriced one is a real, common shape: the answer is the one price.
    const partial = resolveUnitPrice(
      [
        { unitMonthlyUsd: null, costModel: 'flat' },
        { unitMonthlyUsd: 20, costModel: 'flat' },
      ],
      8,
    );
    expect(partial?.monthlyUsd).toBe(20);
    expect(partial?.pricedReviewers).toBe(1);
  });
});

describe('the two time bases: a fortnight for the repository, the observed pace for the reviewer', () => {
  it('prorates the monthly price over the FORTNIGHT, and a month is not 28 days and not 30', () => {
    expect(DAYS_PER_MONTH).toBe(30.44);
    const cost = build(flat(120));
    // 120 × 14 ÷ 30.44. ⚠ PINNED TO SIX PLACES so the constant cannot be "simplified" to 30 (which
    // gives 56.00) or to 28 (60.00) — both wrong in the direction that inflates the finding.
    expect(cost?.windowUsd).toBe(55.190539);
    expect(cost?.windowDays).toBe(14);
    expect(cost?.monthlyUsd).toBe(120);
    // …and the reviewer's own sixty observed days, which measure WORK and carry no money.
    expect(cost?.span?.days).toBe(60);
    expect(cost?.span?.comments).toBe(20);
    expect(cost?.span?.fromIso).toBe(new Date(SPAN.fromMs).toISOString());
    expect(cost?.span?.toIso).toBe(new Date(SPAN.toMs).toISOString());
  });

  it('puts NO MONEY on the span — a price prorated across it is a history we cannot evidence', () => {
    // ⚠ THE STRUCTURAL HALF OF "STATE A RATE, NEVER A HISTORY". The span shipped carrying
    // `usd: monthlyUsd × days ÷ 30.44`, and the headline rendered "US$189.22 of this reviewer's
    // US$236.53 over the 8.6 weeks its comments span here" — a claim about money already spent,
    // which a CURRENT price and a RECENT throughput do not license: the price may have changed, the
    // subscription may be younger than the span, and nothing bounds the span by `repoHeldDays`.
    // A cap would have kept the claim and shrunk it, so the FIELD is gone rather than clamped.
    const cost = build(flat(120));
    expect(cost?.span).not.toBeNull();
    expect(cost?.span).not.toHaveProperty('usd');
    // …and it is gone from the WIRE, not merely unread: a field nobody reads is a field somebody
    // reads later. 236.53088 is the number it held at this fixture's inputs.
    expect(JSON.stringify(cost?.span)).not.toContain('usd');
    expect(JSON.stringify(cost)).not.toContain('236.53');
  });

  it('states each money figure as a RATE at the current price, and keeps the identity', () => {
    // ⚠ THE ARITHMETIC DID NOT CHANGE AND THE CLAIM DID. `spanUsd ÷ acted` ==
    // `monthlyUsd ÷ (acted × 30.44 ÷ spanDays)`, so the per-thread figures are the SAME NUMBERS
    // they were — which is what makes this a change of meaning rather than of value, and what lets
    // the two figures that DID move be pinned against both answers below.
    const cost = build(flat(120));
    if (cost?.yours.status !== 'value') throw new Error('unreachable');
    if (cost.atPeerEngagement.status !== 'value') throw new Error('unreachable');
    if (cost.unacted.status !== 'value') throw new Error('unreachable');
    const spanUsd = (120 * 60) / DAYS_PER_MONTH; // what the deleted field held: 236.53088
    // The per-thread figures: identical under both bases, to the last stored digit.
    expect(cost.yours.perActedOnUsd).toBe(59.13272);
    expect(cost.yours.perActedOnUsd).toBeCloseTo(spanUsd / cost.yours.actedThreads, 6);
    expect(cost.atPeerEngagement.perActedOnUsd).toBe(19.710907);
    expect(cost.atPeerEngagement.perActedOnUsd).toBeCloseTo(
      spanUsd / cost.atPeerEngagement.actedThreadsAtPeer,
      6,
    );
    // ⚠ AND THE TWO THAT MOVED, PINNED AGAINST BOTH ANSWERS. A revert to the span basis produces
    // the second number in each pair, and these lines name it.
    expect(cost.unacted.unactedUsd).toBe(96); // 120 × 0.8, a month
    expect(cost.unacted.unactedUsd).not.toBe(189.224704); // 236.53088 × 0.8, over the span
    expect(cost.atPeerEngagement.conversionGapUsd).toBe(48); // 120 × (0.6 − 0.2), a month
    expect(cost.atPeerEngagement.conversionGapUsd).not.toBe(94.612352); // the span answer
    // The divisor rides the wire beside its quotient, so the block is checkable from the payload
    // alone: 4 threads over 60 days is 2.029333 a month, and 120 ÷ that is the figure above.
    expect(cost.yours.actedPerMonth).toBe(2.029333); // 4 × 30.44 ÷ 60
    expect(cost.atPeerEngagement.actedPerMonthAtPeer).toBe(6.088); // 12 × 30.44 ÷ 60
    expect(120 / cost.yours.actedPerMonth).toBeCloseTo(cost.yours.perActedOnUsd, 4);
  });

  it('divides the WINDOW price by the window’s merges, never the span price', () => {
    // ⚠ `$ per merged PR` IS THE ONE FIGURE THAT STAYS ON THE FORTNIGHT, at both ends of the
    // fraction. A span-priced numerator over a fortnight's merges would be the same two-window
    // defect this feature was built to remove, pointing the other way.
    const cost = build(flat(120), { mergedPrsLast14d: 10 });
    expect(cost?.perMergedPr).toEqual({
      status: 'value',
      value: 5.519054, // 55.190539 ÷ 10 — a monthly divisor would print 12.00, a span one 23.65
      mergedPrs: 10,
    });
  });

  it('MEASURES the acted-on threads rather than projecting them from two rates', () => {
    // ⚠ THE DEFECT THIS REPLACED. The first cut computed
    // `mergedPrsLast14d × threadsPerMergedPr × actedOnRate` — a strict 14-day merge count times two
    // rates folded over a slice budgeted to roughly ninety days — and divided the fortnight's price
    // by the result. Three factors, two time bases, and a served disclosure that named a
    // population mismatch rather than the time one.
    const cost = build(flat(120));
    expect(cost?.yours).toEqual({
      status: 'value',
      actedThreads: 4, // the fold's own `threadsSettledCompleteActed`, not a product
      settledThreads: 20,
      actedOnRate: 0.2,
      actedPerMonth: 2.029333, // 4 × 30.44 ÷ 60 — the span annualises the WORK, nothing else
      perActedOnUsd: 59.13272, // 120 ÷ 2.029333
    });
    // ⚠ THE OLD ANSWER, SPELLED OUT SO THE REGRESSION IS NAMED: 10 merges × 1.5 threads × 0.2 = 3
    // projected threads, and 55.190539 ÷ 3 = 18.396846. Both factors of that product are still in
    // the fixture's metrics, so an implementation that went back to it would produce this number.
    if (cost?.yours.status !== 'value') throw new Error('unreachable');
    expect(cost.yours.perActedOnUsd).not.toBeCloseTo(18.396846, 6);
  });

  it('REFUSES when the span cannot be observed, rather than falling back on the fortnight', () => {
    // ⚠ "A PROJECTION PRESENTED BESIDE MEASURED FIGURES IS THE THING THAT GOES UNNOTICED." One
    // comment, or none with a readable timestamp, is no stretch of time — and the fortnight is not
    // a substitute for it, because the threads being counted were gathered over the whole slice.
    for (const span of [
      null,
      { fromMs: NOW - 90 * DAY, toMs: NOW - 90 * DAY, comments: 4 }, // all in one instant
      { fromMs: NOW - 90 * DAY, toMs: NOW - 30 * DAY, comments: 1 }, // a single comment
    ]) {
      const cost = build(flat(120), { span });
      expect(cost?.span).toBeNull();
      for (const arm of [cost!.unacted, cost!.yours, cost!.atPeerEngagement]) {
        expect(arm.status).toBe('refused');
        if (arm.status !== 'refused') throw new Error('unreachable');
        expect(arm.reason).toBe('span_unobserved');
      }
      // ⚠ AND `$ per merged PR` SURVIVES IT. That figure never touches the span, and withholding it
      // here would be a refusal borrowed from a fact it does not depend on.
      expect(cost?.perMergedPr.status).toBe('value');
      expectAllFinite(cost);
    }
  });
});

describe('the two money figures — what the price buys unacted, and what closing the gap is worth', () => {
  it('states the UNACTED share of the monthly price from the customer’s own rate alone', () => {
    // ⚠ `monthlyUsd × (1 − yourRate)`, a month. This is what the headline's first sentence names,
    // and it is NOT the counterfactual gap: the first cut printed `× (1 − your ÷ cohort)` under
    // these words, which is smaller by a factor of the cohort rate whenever that rate is below 1.
    const cost = build(flat(120));
    expect(cost?.unacted).toEqual({
      status: 'value',
      actedOnRate: 0.2,
      actedThreads: 4,
      settledThreads: 20,
      unactedUsd: 96, // 120 × 0.8 — a RATE at today's price, not 236.53088 × 0.8 over the span
    });
  });

  it('keeps the unacted figure and the counterfactual gap DIFFERENT NUMBERS', () => {
    // ⚠ THE HEADLINE DEFECT, PINNED AS ARITHMETIC. At a cohort median of 60 % the two differ by
    // exactly that factor — 96 × 0.6 = 57.60, against a gap of 48.00 — and a sentence naming one
    // while printing the other under-reports the first by half.
    const cost = build(flat(120));
    if (cost?.unacted.status !== 'value') throw new Error('unreachable');
    if (cost.atPeerEngagement.status !== 'value') throw new Error('unreachable');
    expect(cost.atPeerEngagement.conversionGapUsd).toBe(48); // 120 × (0.6 − 0.2), a month
    expect(cost.unacted.unactedUsd).not.toBe(cost.atPeerEngagement.conversionGapUsd);
    // …and the UNACTED figure is the LARGER of the two whenever the cohort median is below 1, which
    // is the direction the collapsed sentence got wrong.
    expect(cost.unacted.unactedUsd).toBeGreaterThan(cost.atPeerEngagement.conversionGapUsd);
  });

  it('gives the WHOLE monthly price as unacted when nothing was acted on, and still compares', () => {
    // ⚠ THE STRONGEST FINDING THIS BLOCK PRODUCES, and the one where the per-thread figure REFUSES
    // while the other two still render: an acted-on count of 0 makes the division impossible — but
    // "all of it reaches nothing" is exactly the sentence the reader needs, and it needs no cohort.
    const cost = build(flat(120), {
      threads: { acted: 0, settled: 20 },
      metrics: metrics({ acted_on_rate: compared(0, 0.6) }),
    });
    if (cost?.unacted.status !== 'value') throw new Error('unreachable');
    expect(cost.unacted.unactedUsd).toBe(120); // the WHOLE monthly price, never 236.53088
    expect(cost.unacted.actedOnRate).toBe(0);
    expect(cost?.yours.status).toBe('refused');
    if (cost.yours.status !== 'refused') throw new Error('unreachable');
    expect(cost.yours.reason).toBe('nothing_acted_on');
    if (cost.atPeerEngagement.status !== 'value') throw new Error('unreachable');
    expect(cost.atPeerEngagement.conversionGapUsd).toBe(72); // 120 × 0.6, a month
    // …and a difference with no left-hand side is null, never 0 — 0 would read as "no gap".
    expect(cost.atPeerEngagement.perActedOnGapUsd).toBeNull();
    expectAllFinite(cost);
  });

  it('BOUNDS both money figures by the MONTHLY PRICE, in both directions', () => {
    // ⚠ THE DEFECT THIS FORMULA REPLACED. `× (1 − your ÷ cohort)` is bounded in [0,1] only while
    // the customer sits at or below the cohort median. The shipped corpus holds real fitted
    // `acted_on_rate` medians as low as 0.242857, so a repository where every settled thread was
    // acted on produced −4.1 × the spend — and the panel rendered "US$172.06 more of the US$55.19
    // reaches something", a figure three times the total it is a share of.
    const cost = build(flat(120), {
      threads: { acted: 20, settled: 20 },
      metrics: metrics({ acted_on_rate: compared(1, 0.242857) }),
    });
    if (cost?.atPeerEngagement.status !== 'value') throw new Error('unreachable');
    expect(cost.atPeerEngagement.conversionGapUsd).toBe(-90.85716); // 120 × (0.242857 − 1)
    // ⚠ THE INVARIANT, NOT THE NUMBER, AND ITS BOUND IS NOW THE PRICE ITSELF: both figures are
    // `monthlyUsd` times a quantity in [−1, 1] — a rate, and a difference of two rates — so neither
    // can exceed the monthly price, structurally rather than by a clamp. The ratio version at these
    // inputs is −4.1 × the spend, which fails this line whatever the spend is anchored on.
    expect(Math.abs(cost.atPeerEngagement.conversionGapUsd)).toBeLessThanOrEqual(120);
    // …and nothing is unacted at a rate of 1, which the ratio version could not express either.
    if (cost.unacted.status !== 'value') throw new Error('unreachable');
    expect(cost.unacted.unactedUsd).toBe(0);
    expect(cost.unacted.unactedUsd).toBeLessThanOrEqual(120);
  });

  it('is exactly zero when the two rates match', () => {
    const cost = build(flat(120), {
      threads: { acted: 12, settled: 20 },
      metrics: metrics({ acted_on_rate: compared(0.6, 0.6) }),
    });
    if (cost?.atPeerEngagement.status !== 'value') throw new Error('unreachable');
    expect(cost.atPeerEngagement.conversionGapUsd).toBe(0);
    expect(cost.atPeerEngagement.perActedOnGapUsd).toBe(0);
  });
});

describe('THE COUNTERFACTUAL — one factor, never two', () => {
  it('swaps the cohort’s acted-on rate in and leaves the thread count and price alone', () => {
    const cost = build(flat(120));
    expect(cost?.atPeerEngagement).toEqual({
      status: 'value',
      cohortActedOnRate: 0.6,
      // ⚠ THE MUTATION TEST LIVES ON THIS NUMBER. 20 (the CUSTOMER's settled threads) × 0.6.
      // Anything cohort-derived in the left factor changes it, and every figure below with it.
      actedThreadsAtPeer: 12,
      actedPerMonthAtPeer: 6.088, // 12 × 30.44 ÷ 60 — the same count as a monthly pace
      perActedOnUsd: 19.710907, // 120 ÷ 6.088
      perActedOnGapUsd: 39.421813, // 59.13272 − 19.710907
      conversionGapUsd: 48, // 120 × (0.6 − 0.2), a month — never 236.53088 × 0.4
    });
  });

  it('does not read `threads_per_merged_pr` AT ALL — only one cohort figure may enter', () => {
    // ⚠ THE STRONGEST FORM OF "ONE FACTOR, NEVER TWO": not "the number differs from the two-quantile
    // version" but "the cohort's thread rate cannot reach this block at all". Two builds whose ONLY
    // difference is that metric — customer value AND cohort median both moved — must be identical.
    // Multiplying a cohort-p50 volume by a cohort-p50 rate and calling it "what a peer pays" is a
    // real statistical error: THE MEDIAN OF A PRODUCT IS NOT THE PRODUCT OF THE MEDIANS.
    const a = build(flat(120), {
      metrics: metrics({ threads_per_merged_pr: compared(1.5, 3.0) }),
    });
    const b = build(flat(120), {
      metrics: metrics({ threads_per_merged_pr: compared(9.25, 0.125) }),
    });
    expect(a).toEqual(b);
    // …and a metric that is not even present changes nothing either.
    const c = build(flat(120), { metrics: { acted_on_rate: compared(0.2, 0.6) } });
    expect(c).toEqual(a);
  });

  it('derives the customer’s rate from the COUNTS, so the rate and the counts cannot disagree', () => {
    // ⚠ ONE SOURCE FOR ONE FACT. The metric's own `value` is a second spelling of `acted ÷ settled`;
    // reading the rate from there while printing the counts beside it gives a card two numbers that
    // can drift apart. The metric is the GATE (see the next describe), the counters are the VALUE.
    const cost = build(flat(120), {
      threads: { acted: 7, settled: 20 },
      // The metric still says 0.2 — a stale rate a metric-reading implementation would print.
      metrics: metrics({ acted_on_rate: compared(0.2, 0.6) }),
    });
    if (cost?.unacted.status !== 'value') throw new Error('unreachable');
    expect(cost.unacted.actedOnRate).toBe(0.35); // 7 ÷ 20, not the metric's 0.2
    expect(cost.unacted.unactedUsd).toBe(78); // 120 × 0.65
  });
});

describe('the refusals, each its own sentence', () => {
  const reasonOf = (arm: { status: string }): unknown =>
    arm.status === 'refused' ? (arm as { reason?: unknown }).reason : arm.status;

  it('NO PRICE SET renders nothing at all — absent, not empty and not zero', () => {
    expect(build(null)).toBeNull();
  });

  it('a price of exactly 0 renders the price and REFUSES every figure derived from it', () => {
    // ⚠ Every division of 0 is 0.00, which is TRUE and reads as a broken panel. The price is a
    // real recorded fact and still renders; the four derived figures refuse with a sentence.
    const cost = build(flat(0));
    expect(cost).not.toBeNull();
    expect(cost?.monthlyUsd).toBe(0);
    expect(cost?.windowUsd).toBe(0);
    for (const arm of [cost?.perMergedPr, cost?.unacted, cost?.yours, cost?.atPeerEngagement]) {
      expect(arm?.status).toBe('refused');
      if (arm?.status !== 'refused') throw new Error('unreachable');
      expect(arm.reason).toBe('price_is_zero');
      // ⚠ STRUCTURALLY: reading a figure off a refusal must be impossible, not 0.00.
      expect(arm).not.toHaveProperty('value');
      expect(arm).not.toHaveProperty('perActedOnUsd');
      expect(arm).not.toHaveProperty('unactedUsd');
      expect(arm.message).toMatch(/nothing/i);
    }
    // ⚠ AND THE SENTENCE RULES OUT THE OTHER WAY OF REACHING ZERO, because a reader who has just
    // been told "recorded as free" has no other way to know a seat count was not involved.
    if (cost?.perMergedPr.status !== 'refused') throw new Error('unreachable');
    expect(cost.perMergedPr.message).toMatch(/stored, deliberate zero/);
  });

  it('a repository that merged nothing refuses with the placement’s OWN reason', () => {
    // ⚠ The placement above already refuses this repository as `repo_inactive_in_window`. Cost must
    // not resurrect the division, and must not invent a second sentence for one cause.
    const cost = build(flat(120), { mergedPrsLast14d: 0 });
    expect(cost).not.toBeNull();
    expect(reasonOf(cost!.perMergedPr)).toBe('no_merges_in_window');
    expect(reasonOf(cost!.unacted)).toBe('no_merges_in_window');
    expect(reasonOf(cost!.yours)).toBe('no_merges_in_window');
    expect(reasonOf(cost!.atPeerEngagement)).toBe('no_merges_in_window');
    // …and nothing anywhere in the block is an Infinity or a NaN dressed as a number.
    // ⚠ ON THE VALUES. The assertion this replaced searched `JSON.stringify(cost)` for the strings
    // `Infinity` and `NaN`, which that function never emits — it writes both as `null`.
    expectAllFinite(cost);
  });

  it('withholds every reviewer-side figure when the customer’s OWN rate was withheld — and keeps $/merged PR', () => {
    // ⚠ THE DECISION, STATED: `$ per merged PR` divides a price by the repository's own merges and
    // asks NOTHING of the reviewer, so a withheld reviewer-side rate has no bearing on it. It is
    // most worth reading exactly here — "you paid this much and this is what it produced" is the
    // whole question when the reviewer's own metrics came back empty.
    const cost = build(flat(120), {
      metrics: metrics({ acted_on_rate: excluded('below_min_units') }),
    });
    expect(cost?.perMergedPr.status).toBe('value');
    expect(reasonOf(cost!.unacted)).toBe('own_rate_withheld');
    expect(reasonOf(cost!.yours)).toBe('own_rate_withheld');
    if (cost?.yours.status !== 'refused') throw new Error('unreachable');
    // The sentence names WHICH rate and WHICH gate, rather than a generic "not enough data".
    expect(cost.yours.metric).toBe('acted_on_rate');
    expect(cost.yours.metricReason).toBe('below_min_units');
    // ⚠ An `excluded` arm carries no cohort at all — `compare()` withholds before it reads the
    // cell — so the counterfactual names the customer-side gate that hid it, not a cohort refusal
    // that may not exist.
    expect(reasonOf(cost.atPeerEngagement)).toBe('own_rate_withheld');
  });

  it('does NOT read the raw counts past a withheld metric', () => {
    // ⚠ THE GATE IS THE METRIC AND THE COUNTERS ARE THE VALUE, and going straight to the counters
    // is the tempting simplification that breaks it. `below_min_units` exists because a rate over a
    // handful of threads is noise wearing a percentage sign; the counts are RIGHT THERE and reading
    // them anyway would resurrect exactly the number the fold refused to publish.
    const cost = build(flat(120), {
      threads: { acted: 1, settled: 2 },
      metrics: metrics({ acted_on_rate: excluded('below_min_units') }),
    });
    expect(reasonOf(cost!.unacted)).toBe('own_rate_withheld');
    expect(JSON.stringify(cost)).not.toContain('unactedUsd');
  });

  it('refuses the counterfactual alone when the COHORT published no rate', () => {
    const cost = build(flat(120), { metrics: metrics({ acted_on_rate: uncompared(0.2) }) });
    // The customer's own figures are untouched: they need no cohort at all.
    expect(cost?.yours.status).toBe('value');
    expect(cost?.unacted.status).toBe('value');
    expect(cost?.perMergedPr.status).toBe('value');
    expect(reasonOf(cost!.atPeerEngagement)).toBe('cohort_rate_unfitted');
  });

  it('refuses the counterfactual when the cohort’s own median is zero', () => {
    const cost = build(flat(120), { metrics: metrics({ acted_on_rate: compared(0.2, 0) }) });
    expect(cost?.yours.status).toBe('value');
    expect(cost?.unacted.status).toBe('value');
    expect(reasonOf(cost!.atPeerEngagement)).toBe('cohort_rate_zero');
  });

  it('refuses the per-thread figures when the reviewer settled no thread anybody acted on', () => {
    const cost = build(flat(120), {
      threads: { acted: 0, settled: 20 },
      metrics: metrics({ acted_on_rate: compared(0, 3) }),
    });
    expect(cost?.perMergedPr.status).toBe('value');
    expect(reasonOf(cost!.yours)).toBe('nothing_acted_on');
    // ⚠ …AND THE OTHER TWO STILL RENDER. This is the case they exist for.
    expect(cost?.unacted.status).toBe('value');
    expect(cost?.atPeerEngagement.status).toBe('value');
  });

  it('refuses everything on a PARTIAL window — the undercount lands in a denominator', () => {
    // ⚠ THE DEFECT THIS GATE CLOSES. The placement refuses a repository held for less than the
    // window because its merge count is an undercount and would place it in too quiet a band. Cost
    // DIVIDES by that same count, so the undercount inflates instead: three days of a fortnight's
    // merges under a full fortnight's price reports several times the true cost per merged PR —
    // and that is the most quotable number on the tab.
    const cost = build(flat(120), { repoHeldDays: 3, mergedPrsLast14d: 2 });
    expect(cost).not.toBeNull();
    expect(cost?.windowUsd).toBe(55.190539); // the price is still a real, whole-window price
    for (const arm of [cost!.perMergedPr, cost!.unacted, cost!.yours, cost!.atPeerEngagement]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      expect(arm.reason).toBe('repo_window_incomplete');
    }
    // ⚠ AND IT OUTRANKS THE ZERO-PRICE SENTENCE, matching `cohortFor`'s order: facts about the
    // repository before facts about the money.
    const free = build(flat(0), { repoHeldDays: 3, mergedPrsLast14d: 2 });
    expect(reasonOf(free!.perMergedPr)).toBe('repo_window_incomplete');
    // …and exactly at the boundary the window IS complete: `<`, never `<=`.
    expect(build(flat(120), { repoHeldDays: 14 })?.perMergedPr.status).toBe('value');
    expect(build(flat(120), { repoHeldDays: 13.999 })?.perMergedPr.status).toBe('refused');
  });

  it('renders a BLOCK, never silence, when a price was entered and could not be stated', () => {
    // ⚠ THE THIRD STATE, AND THE ONE THAT SHIPPED AS TOTAL SILENCE. A workspace whose only priced
    // reviewer for this unit is per-seat, against an empty or unreadable seat count, has every
    // priced row dropped — and a `resolveUnitPrice` that then answered `null` handed it the
    // NO-PRICE experience: no block, no figure, and no disclosure either, on a card where somebody
    // typed US$15 a developer. `seatCountZero` could only ever reach the screen when some OTHER
    // login kept the block alive, which is not the shape the counter was written for.
    for (const seats of [0, null]) {
      const price = resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], seats);
      const cost = build(price);
      expect(cost).not.toBeNull();
      expect(cost?.monthlyUsd).toBeNull(); // ⚠ NOT 0 — that is "recorded as free", which is a lie
      expect(cost?.windowUsd).toBeNull();
      expect(cost?.pricedReviewers).toBe(0);
      for (const arm of [cost!.perMergedPr, cost!.unacted, cost!.yours, cost!.atPeerEngagement]) {
        expect(arm.status).toBe('refused');
        if (arm.status !== 'refused') throw new Error('unreachable');
        expect(arm.reason).toBe('price_unresolved');
        // ⚠ STRUCTURALLY: no figure may be read off it, exactly as with a stored zero.
        expect(arm).not.toHaveProperty('value');
        expect(arm).not.toHaveProperty('perActedOnUsd');
      }
      expectAllFinite(cost);
    }
    // …and the two counters still say WHICH of the two happened, which is the whole point of
    // rendering anything at all here.
    expect(build(resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], 0))?.seatCountZero).toBe(1);
    expect(
      build(resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], null))?.seatPriceUnresolved,
    ).toBe(1);
    // ⚠ AND NOBODY ENTERING A PRICE IS STILL SILENCE — the two must not collapse into each other.
    expect(build(resolveUnitPrice([{ unitMonthlyUsd: null, costModel: 'flat' }], 0))).toBeNull();
  });

  it('gives the TEN reasons ten DIFFERENT sentences, and keeps the tenth out of this fold', () => {
    const seen = new Map<string, string>();
    const collect = (arm: unknown): void => {
      const a = arm as { status: string; reason?: string; message?: string };
      if (a.status !== 'refused' || a.reason == null || a.message == null) return;
      seen.set(a.reason, a.message);
    };
    for (const cost of [
      build(flat(0)),
      build(flat(120), { repoHeldDays: 3 }),
      build(flat(120), { mergedPrsLast14d: 0 }),
      build(flat(120), { span: null }),
      build(flat(120), { metrics: metrics({ acted_on_rate: excluded('vendor_silent') }) }),
      build(flat(120), {
        threads: { acted: 0, settled: 20 },
        metrics: metrics({ acted_on_rate: compared(0, 0.6) }),
      }),
      build(flat(120), { metrics: metrics({ acted_on_rate: uncompared(0.2) }) }),
      build(flat(120), { metrics: metrics({ acted_on_rate: compared(0.2, 0) }) }),
      build(resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], 0)),
    ]) {
      if (cost == null) continue;
      collect(cost.perMergedPr);
      collect(cost.unacted);
      collect(cost.yours);
      collect(cost.atPeerEngagement);
    }
    // ⚠ NINE OF THE TEN ARE REACHABLE FROM *THIS* FOLD, and the tenth's absence from this list is
    // an assertion rather than an omission — see below.
    expect([...seen.keys()].sort()).toEqual([
      'cohort_rate_unfitted',
      'cohort_rate_zero',
      'no_merges_in_window',
      'nothing_acted_on',
      'own_rate_withheld',
      'price_is_zero',
      'price_unresolved',
      'repo_window_incomplete',
      'span_unobserved',
    ]);
    // ⚠ NINE FACTS, NINE REMEDIES, on a PER-REPOSITORY block. Collapsing two of them is the defect
    // this vocabulary exists to prevent, one level down from the placement refusals — and the
    // sharpest pair is "recorded as free" against "we could not multiply your per-seat price out",
    // one keystroke apart in the code and opposite claims on the screen.
    expect(new Set(seen.values()).size).toBe(9);
    for (const message of seen.values()) expect(message.length).toBeGreaterThan(40);

    // ⚠ AND THE VOCABULARY ITSELF IS ELEVEN, BECAUSE IT IS SHARED WITH A SECOND GRAIN. `rollup.ts`
    // refuses in these same words on purpose: two grains that state one money fact in two different
    // sentences teach a reader to distrust both. So the map is asserted whole here — the file that
    // owns it — rather than half of it here and half in the rollup's own suite.
    const ALL_REASONS: BotBenchmarkCostRefusalReason[] = [
      'cohort_rate_unfitted',
      'cohort_rate_zero',
      'no_merges_in_window',
      'nothing_acted_on',
      'own_rate_withheld',
      'price_is_zero',
      'price_unresolved',
      'repo_window_incomplete',
      'span_unobserved',
      'window_underpopulated',
      'workspace_truncated',
    ];
    expect(Object.keys(COST_REFUSAL_MESSAGE).sort()).toEqual([...ALL_REASONS].sort());
    expect(new Set(Object.values(COST_REFUSAL_MESSAGE)).size).toBe(11);
    for (const reason of ALL_REASONS) {
      expect(COST_REFUSAL_MESSAGE[reason].length, reason).toBeGreaterThan(40);
    }

    // ⚠ THE LAST TWO ARE UNREACHABLE FROM `buildUnitCost`, AND THAT IS THE CLAIM RATHER THAN A GAP
    // IN THE SWEEP ABOVE. Both are facts about an ESTATE: `workspace_truncated` is one whole price
    // over a partial sum of repositories, `window_underpopulated` is one whole price over a calendar
    // month too thin to divide by — and this module prices ONE repository over an observed span,
    // which is a claim neither describes. Nothing it can be handed makes it say either, which is why
    // the sweep finds nine.
    expect(seen.has('workspace_truncated')).toBe(false);
    expect(seen.has('window_underpopulated')).toBe(false);
    expect([...seen.values()]).not.toContain(COST_REFUSAL_MESSAGE.workspace_truncated);
    expect([...seen.values()]).not.toContain(COST_REFUSAL_MESSAGE.window_underpopulated);
    // ⚠ AND ITS SENTENCE IS ABOUT A WINDOW, NOT ABOUT A SAMPLE SIZE IN THE ABSTRACT — the remedy
    // is TIME, which is what separates it from `below_min_units` (answered by pooling) one grain up.
    expect(COST_REFUSAL_MESSAGE.window_underpopulated).toMatch(/last month/);
    // …and its sentence names the remedy, which is what makes it a tenth SENTENCE rather than a
    // tenth spelling of "not enough data".
    expect(COST_REFUSAL_MESSAGE.workspace_truncated).toMatch(/Narrow to a repository/);
  });
});

describe('no shape of input puts a non-finite number on the wire', () => {
  it('sweeps every divisor this block can hit and demands a finite number or a refusal', () => {
    // ⚠ THE ASSERTION THAT REPLACED AN UNFALSIFIABLE ONE, AND IT IS ITS OWN TEST ON PURPOSE.
    //
    // The shipped guard was `expect(JSON.stringify(cost)).not.toMatch(/Infinity|NaN/)`, on a single
    // fixture. It could not fail for two independent reasons, and both had to be fixed: the regex
    // hunts for tokens `JSON.stringify` never emits (it writes all three as `null`), and one
    // fixture only ever reaches one divisor. So this sweep drives EVERY divisor in the module —
    // the window merge count, the span length, the customer's acted-on count, the counterfactual's
    // — through its zero, and asserts on the LIVE VALUES.
    //
    // ⚠ IT ASSERTS NOTHING ABOUT STATUS, deliberately. The sibling tests pin which arm refuses and
    // why; if this one also pinned that, a relaxed guard would be killed by the status assertion
    // and this line would be along for the ride, unable to fail on its own.
    //
    // MUTATION-TESTED IN ISOLATION (`-t` on this test alone), and the result is recorded honestly
    // rather than rounded up — this package has shipped six tests that could not fail:
    //   KILLED by this test alone — `buildYours`' `acted > 0`, `perMergedPr`'s `mergedPrsLast14d
    //     <= 0`, `ownEngagement`'s `settled > 0`. Each is a real reachable divide-by-zero.
    //   SURVIVES — `buildCounterfactual`'s `actedAtPeer > 0`, because it is UNREACHABLE:
    //     `ownEngagement` has already proved `settled > 0` and `cohortActedOnRate` has already
    //     proved `p50 > 0`, so the product cannot be zero. It is defence in depth, and the module
    //     says so at the guard.
    //   KILLED by this test alone since the money moved onto a per-month basis — `resolveSpan`'s
    //     `days > 0` guard, on the ONE-MILLISECOND shape below. Under the old basis a sub-rounding
    //     span produced a `spanUsd` of 0 and every derived figure was a finite WRONG ZERO; the
    //     divisor is now `actedThreads × 30.44 ÷ days`, so a `days` that rounds to 0 is an
    //     `Infinity` on the wire, arriving as a JSON `null` and rendering as an em dash.
    const shapes: Array<Parameters<typeof build>[1]> = [];
    for (const merged of [0, 1, 10]) {
      for (const span of [
        null,
        SPAN,
        { fromMs: NOW - DAY, toMs: NOW, comments: 2 }, // one day
        { fromMs: NOW - 90 * DAY, toMs: NOW - 90 * DAY, comments: 9 }, // zero length
        // ⚠ ONE MILLISECOND: real length, and `round6(1.157e-8)` is exactly 0. The per-month
        // divisor is the ROUNDED `days` on the wire, so this is the shape that turns a divisor
        // into an Infinity.
        { fromMs: NOW - 1, toMs: NOW, comments: 3 },
      ]) {
        for (const threads of [
          { acted: 0, settled: 0 },
          { acted: 0, settled: 20 },
          { acted: 20, settled: 20 },
          { acted: 4, settled: 20 },
        ]) {
          for (const rate of [
            compared(threads.settled === 0 ? 0 : threads.acted / threads.settled, 0.6),
            compared(0.2, 0), // a cohort median of zero
            uncompared(0.2),
            excluded('vendor_silent'),
          ]) {
            shapes.push({ mergedPrsLast14d: merged, span, threads, metrics: metrics({ acted_on_rate: rate }) });
          }
        }
      }
    }
    expect(shapes.length).toBe(240);
    for (const price of [flat(0), flat(0.01), flat(120), flat(9_999_999)]) {
      for (const shape of shapes) {
        expectAllFinite(build(price, shape));
      }
    }
  });
});

describe('the per-workspace disclosure', () => {
  it('still carries the count of cards sharing one price — vestigial, and pinned as such', () => {
    // ⚠ THIS FIELD IS THE RECORD OF A FIX THAT DID NOT WORK, AND THE ASSERTION IS KEPT FOR THAT
    // REASON RATHER THAN FOR THE PRODUCT CLAIM IT ONCE CARRIED. The price is per WORKSPACE and this
    // block's unit is one (repository, vendor) pair, so one subscription covering six repositories
    // produced six blocks each carrying the whole figure; the count was what let the panel say "do
    // not add these up". That is a caveat compensating for a grain mismatch, and THE GRAIN MOVED
    // INSTEAD — money is now stated once per vendor over the whole Workspace
    // (`BotBenchmarkWorkspaceRollup.cost`), where adding is not something a reader can do because
    // there is one figure.
    //
    // So NOTHING READS THIS ON A WIRE ANY MORE: `benchmark-placement.test.ts` asserts the string
    // `sharedWithUnits` appears nowhere in a placement response. It survives on this pure fold's
    // input and output, unchanged, because `buildUnitCost` is now the pinned executable
    // specification of these rules rather than a production path — and shrinking the specification
    // is not what "retired" means. The assertions below are byte-for-byte the ones that shipped.
    expect(build(flat(120), { sharedWithUnits: 4 })?.sharedWithUnits).toBe(4);
    expect(build(flat(120))?.sharedWithUnits).toBe(1);
  });

  it('serves the span’s own caveat rather than leaving it to a renderer', () => {
    const note = build(flat(120))?.spanNote ?? '';
    // ⚠ IT MUST NAME THE TIME MISMATCH, which is what the note it replaced did not: that one
    // disclosed a human-vs-any-author population difference and called the bias "slightly high",
    // while the real error was a fortnight's price divided into ninety days of work.
    expect(note).toMatch(/ninety days/);
    expect(note).toMatch(/fourteen-day window/);
    expect(note).toMatch(/earliest to its latest/);
    // ⚠ AND IT MUST NOT DESCRIBE A BILLING PERIOD, which is what the SECOND draft did: it said the
    // price was "prorated over exactly that stretch", beside figures that are rates at today's
    // price. A note contradicting the figure next to it is the defect relocated into prose.
    expect(note).toMatch(/RATES at the price recorded today/);
    expect(note).toMatch(/measurement window for the WORK/);
    expect(note).toMatch(/no spend over it is claimed/);
    expect(note).not.toMatch(/prorated/i);
  });
});
