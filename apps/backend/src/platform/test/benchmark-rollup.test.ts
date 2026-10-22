// THE WORKSPACE ROLLUP — one vendor, one card, the whole estate.
//
// `benchmark-cost.test.ts` is this file's sibling and its model: pure, hand-built objects, no
// database, exact digits rather than `toBeCloseTo`, and the WRONG answer named beside the right one
// so a regression is spelled out rather than merely absent. Everything that file says about its own
// discipline applies here verbatim; what follows is what this GRAIN adds.
//
// ⚠ THE HOUSE RULE THIS FILE WAS WRITTEN UNDER, and it was paid for in rework: "four separate
// artifacts LOOKED like verification and could not fail — a literal-vs-literal assertion, a pathlib
// tautology, an '88/88 figures reconciled' that was a reading rather than any code, and a coverage
// total that survived deleting the test it counted." So the load-bearing assertions here were
// MUTATION-TESTED against the real implementation — the guard was broken, the test was watched go
// red, and the file was restored — and the results are recorded at each one, INCLUDING the guards
// that survived. A surviving guard is not a failure of the test; hiding it would be.
//
// ⚠ THE THREE THINGS THIS GRAIN CAN GET WRONG THAT THE PER-REPOSITORY GRAIN CANNOT:
//
//   1. ADDITIVITY. Every counter on the card is a plain sum over the live repositories, and the
//      evidence table under it is the audit trail. A card whose headline does not equal the sum of
//      its own rows is uncheckable by the reader it ships for. Asserted as a LOOP over the keys
//      actually present, never a hand-listed subset — a hand-listed subset silently stops covering
//      the next counter somebody adds.
//   2. THE TWO POPULATIONS. `expectedRate` exists only over the repositories whose cohort published
//      a median, so the customer rate it is set against must be computed over that SAME subset.
//      Mixing it with the card's pooled headline rate is the defect docs/PERIOD-REPORTING.md names
//      "ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET POPULATIONS", shipped three times there.
//   3. THE SPANS. A per-month pace across repositories is a SUM OF PER-REPOSITORY RATES. Joining
//      the stretches into one window measures time nobody was working, and it is wrong by a factor
//      of three on an ordinary estate while reading entirely plausible on screen.
//
// Runs from the backend workspace (@pierre/pro ships no vitest devDep):
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/benchmark-rollup
import { describe, expect, it } from 'vitest';
import type {
  BotBenchmarkPlacementCohort,
  BotBenchmarkPlacementCounters,
  BotBenchmarkPlacementMetric,
  BotBenchmarkPlacementRefusalReason,
  BotBenchmarkWorkspaceRollup,
} from '@pierre-review/shared';
import {
  COST_REFUSAL_MESSAGE,
  COST_WINDOW_DAYS,
  COST_WINDOW_MIN_ACTED,
  DAYS_PER_MONTH,
  resolveUnitPrice,
  type ResolvedUnitPrice,
} from '../bots/benchmark/cost.js';
import {
  ROLLUP_REFUSAL_MESSAGE,
  buildWorkspaceRollup,
  rollupBasisNote,
  type RollupRepoFacts,
  type WorkspaceRollupInput,
} from '../bots/benchmark/rollup.js';

const WINDOW_DAYS = 14;

// ── Walking the LIVE values ─────────────────────────────────────────────────────────────────────

/**
 * ⚠ ASSERT ON THE VALUES, NEVER ON THE SERIALISED STRING — `benchmark-cost.test.ts`'s helper,
 * lifted deliberately rather than re-invented.
 *
 * `JSON.stringify({a: Infinity, b: NaN})` is `{"a":null,"b":null}`, so a regex hunting for either
 * token in a serialised block CANNOT MATCH and the guarantee it claims to check is unverified. This
 * grain has four new divisors (a summed merge count, a summed pace, a summed peer pace, a pooled
 * settled count) and every one of them can be driven to zero by a real estate.
 */
function expectAllFinite(value: unknown, path = 'rollup'): void {
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

/** Every value stored under `key`, anywhere in the payload, live — not a string search. Used for
 *  the two whole-payload claims: "no percentile anywhere" and "every money figure is bounded". */
function collectValues(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const v of value) collectValues(v, key, out);
    return out;
  }
  if (value != null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) out.push(v);
      collectValues(v, key, out);
    }
  }
  return out;
}

/** The five counter maps as plain records, so a test can iterate the maps the WIRE actually carries
 *  rather than a list this file remembers to keep up to date. */
function mapsOf(c: BotBenchmarkPlacementCounters): Record<string, Record<string, number>> {
  return c as unknown as Record<string, Record<string, number>>;
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

/** A `compared` metric: the customer's own value, the cohort's fitted quantiles, and a RANK.
 *  ⚠ The percentile is a parameter here (it is a constant in the cost suite) because the spread is
 *  a count of ranks and the whole section is untestable with one value. */
function compared(value: number, p50: number, percentile: number): BotBenchmarkPlacementMetric {
  return {
    status: 'compared',
    value,
    units: 20,
    percentile,
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

/** The customer HAS a value; the COHORT refused this metric in this cell. No median, no rank. */
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

function placedIn(activityBand: number, nBands = 10): BotBenchmarkPlacementCohort {
  return {
    status: 'placed',
    activityBand,
    nBands,
    bandLabel: `${activityBand} of ${nBands}`,
    bandRange: [5, 50],
    cohortRepos: 60,
    aboveTopBandBy: null,
  };
}

function unplaced(reason: BotBenchmarkPlacementRefusalReason): BotBenchmarkPlacementCohort {
  return { status: 'refused', reason, message: 'x' };
}

/** Counters shaped like the fold's, with the two keys `isLive` reads set to a real number. ⚠ The
 *  DEFAULT is live: a silent repository is an explicit opt-in below, because a fixture that is
 *  accidentally silent makes every sum on the card zero and every assertion pass vacuously. */
function counters(over: Partial<BotBenchmarkPlacementCounters> = {}): BotBenchmarkPlacementCounters {
  return {
    volume: over.volume ?? { commentsObserved: 12, findings: 7 },
    outcome: over.outcome ?? { commentsObserved: 12, threadsSettled: 20 },
    overdueEligible: over.overdueEligible ?? { '72': 5 },
    overdueUntouched: over.overdueUntouched ?? { '72': 2 },
    repository: over.repository ?? { mergedPrs: 10 },
  };
}

let nextRepoId = 1;

/** One repository's contribution. Defaults are a live, placed, comparable repository: 20 settled
 *  threads of which 4 were acted on (20 %), against a cohort median of 60 %, over 60 observed days. */
function facts(over: Partial<RollupRepoFacts> = {}): RollupRepoFacts {
  const id = over.repoId ?? nextRepoId++;
  return {
    repoId: id,
    repoOwner: over.repoOwner ?? 'acme',
    repoName: over.repoName ?? `repo-${id}`,
    mergedPrsLast14d: over.mergedPrsLast14d ?? 10,
    placement: over.placement ?? placedIn(6),
    counters: over.counters ?? counters(),
    actedOnRateMetric:
      'actedOnRateMetric' in over ? over.actedOnRateMetric : compared(0.2, 0.6, 30),
    spanDays: 'spanDays' in over ? (over.spanDays ?? null) : 60,
    // ⚠ WELL CLEAR OF `COST_WINDOW_DAYS` BY DEFAULT. A repository younger than the cost window
    // refuses the per-thread money outright, so a fixture that fell under it by accident would make
    // every money assertion below pass vacuously against a refusal.
    repoHeldDays: over.repoHeldDays ?? 400,
    settled: over.settled ?? 20,
    acted: over.acted ?? 4,
    // ⚠ THE WINDOWED PAIR DEFAULTS TO THE WHOLE PAIR — the LOOSEST shape the invariant allows (the
    // window is a subset of the slice, so `inWindow <= total` always), which keeps a fixture from
    // describing an estate whose last month contains more work than its whole history. Tests that
    // care about the two populations DIFFERING set them apart explicitly.
    //
    // ⚠ SO THE BARE DEFAULT REFUSES `window_underpopulated` — four acted-on threads is under the
    // floor. That is deliberate and it is PINNED below ("the default estate is under the floor"),
    // because an unpinned refusing default is exactly the "accidentally silent fixture" this file's
    // header warns about: every money assertion would pass vacuously against a refusal. A test that
    // wants a figure uses `busy()`.
    settledInWindow: over.settledInWindow ?? over.settled ?? 20,
    actedInWindow: over.actedInWindow ?? over.acted ?? 4,
  };
}

/** A repository the vendor is DECLARED in and produced nothing in. ⚠ Its counters are POISONED with
 *  a huge number on purpose: if `isLive` ever loosens, the additivity assertions do not merely
 *  drift, they blow up by 9,000 and name the rule that broke. */
function silent(over: Partial<RollupRepoFacts> = {}): RollupRepoFacts {
  return facts({
    counters: counters({
      volume: { commentsObserved: 0, findings: 9000 },
      outcome: { commentsObserved: 0, threadsSettled: 9000 },
      repository: { mergedPrs: 9000 },
    }),
    mergedPrsLast14d: 9000,
    settled: 0,
    acted: 0,
    settledInWindow: 0,
    actedInWindow: 0,
    spanDays: null,
    actedOnRateMetric: excluded('vendor_silent'),
    ...over,
  });
}

/**
 * A repository whose LAST MONTH clears the per-thread money's floor.
 *
 * ⚠ THE DEFAULT `facts()` DOES NOT, ON PURPOSE (four acted-on threads is under
 * `COST_WINDOW_MIN_ACTED`), so a test that wants a per-acted-on FIGURE has to ask for one. That
 * asymmetry is the point: it makes "this fixture has enough recent work to price" a written
 * decision at every call site rather than a property of a default nobody re-reads.
 *
 * The slice-wide pair stays WIDER than the windowed one — 90 settled / 30 acted over everything
 * read, 60 / 20 inside the last month — because the two populations are different numbers on the
 * real card and a fixture where they coincide cannot tell them apart.
 */
function busy(over: Partial<RollupRepoFacts> = {}): RollupRepoFacts {
  return facts({
    settled: 90,
    acted: 30,
    settledInWindow: 60,
    actedInWindow: 20,
    ...over,
  });
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

/** A price somebody ENTERED that cannot be stated — every priced row per-seat, no seat count. ⚠ The
 *  THIRD state of the price, and it is neither `null` nor `0`. */
const unstatable = (): ResolvedUnitPrice => {
  const price = resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], null);
  if (price == null) throw new Error('unreachable');
  return price;
};

function build(
  repos: RollupRepoFacts[],
  over: Partial<Omit<WorkspaceRollupInput, 'repos'>> = {},
): BotBenchmarkWorkspaceRollup {
  return buildWorkspaceRollup({
    key: over.key ?? 'coderabbit',
    vendor: 'vendor' in over ? (over.vendor ?? null) : 'coderabbit',
    botKind: over.botKind ?? 'code_review',
    reviewers: over.reviewers ?? [{ userId: 1, login: 'coderabbitai[bot]', label: 'CodeRabbit' }],
    repos,
    reposConsidered: over.reposConsidered ?? repos.length,
    price: 'price' in over ? (over.price ?? null) : flat(120),
    windowDays: over.windowDays ?? WINDOW_DAYS,
    truncated: over.truncated ?? false,
  });
}

/** THE HOUSE ESTATE — two live repositories with DIFFERENT everything, so no figure below can be
 *  right by coincidence of a symmetric fixture. */
const HOUSE = (): RollupRepoFacts[] => [
  facts({
    repoId: 1,
    repoName: 'api',
    mergedPrsLast14d: 10,
    spanDays: 60,
    settled: 20,
    acted: 4,
    actedOnRateMetric: compared(0.2, 0.6, 30),
  }),
  facts({
    repoId: 2,
    repoName: 'web',
    mergedPrsLast14d: 20,
    spanDays: 30,
    settled: 30,
    acted: 9,
    actedOnRateMetric: compared(0.3, 0.5, 70),
    counters: counters({
      volume: { commentsObserved: 30, approvals: 3 },
      outcome: { commentsObserved: 30, threadsSettled: 30 },
      overdueEligible: { '72': 8, '168': 4 },
      overdueUntouched: { '168': 1 },
      repository: { mergedPrs: 20, humanAuthors: 6 },
    }),
  }),
];

/** The refused `reason`, or the arm's own status when it did not refuse. ⚠ TAKES `unknown` ON
 *  PURPOSE: it is pointed at BOTH refusal vocabularies (the money's and the comparison's) and at
 *  every value arm of both, and a `{status: string} & Record<string, unknown>` parameter — the shape
 *  the sibling suite uses — does not accept a closed interface like `BotBenchmarkCostRefusal` at
 *  all. Narrowing inside keeps one helper for eleven differently-shaped arms. */
const reasonOf = (arm: unknown): unknown => {
  const a = arm as { status?: unknown; reason?: unknown };
  return a?.status === 'refused' ? a.reason : a?.status;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('THE ADDITIVITY INVARIANT — the whole equals the sum of the parts, for every key', () => {
  it('sums EVERY key of EVERY counter map, with an absent key contributing 0', () => {
    // ⚠ THE LOOP IS THE ASSERTION. A hand-listed `expect(counters.volume.commentsObserved).toBe(42)`
    // pins one number and silently stops covering the next counter the fitter emits — and the
    // fitter's counter names are an OPEN map on the wire precisely so a new one needs no wire edit.
    // So this walks the maps the payload actually carries and, within each, the union of the keys
    // the fixtures actually carry.
    //
    // ⚠ AND THE FIXTURES DISAGREE ON PURPOSE: `findings` is in repository 1 alone, `approvals` and
    // `humanAuthors` in repository 2 alone, and the two overdue maps use DIFFERENT grace-hour keys.
    // A fold that intersected keys instead of unioning them would drop four of the nine keys below,
    // and one that dropped an absent member entirely would drop the key rather than its zero.
    const live = HOUSE();
    const rollup = build(live);
    const got = mapsOf(rollup.counters);

    // The five maps the wire declares — a dropped map is caught here, and a NEW map is covered by
    // the loop below without this file being edited.
    expect(Object.keys(got).sort()).toEqual([
      'outcome',
      'overdueEligible',
      'overdueUntouched',
      'repository',
      'volume',
    ]);

    let keysChecked = 0;
    for (const map of Object.keys(got)) {
      const union = new Set(live.flatMap((f) => Object.keys(mapsOf(f.counters)[map] ?? {})));
      // ⚠ THE KEY SET IS THE UNION, NOT THE INTERSECTION AND NOT THE FIRST MEMBER'S.
      expect([...Object.keys(got[map] ?? {})].sort(), map).toEqual([...union].sort());
      for (const key of union) {
        const want = live.reduce((sum, f) => sum + (mapsOf(f.counters)[map]?.[key] ?? 0), 0);
        expect(got[map]?.[key], `${map}.${key}`).toBe(want);
        keysChecked += 1;
      }
    }
    // ⚠ THE COVERAGE COUNT IS ITSELF ASSERTED, because "a coverage total that survived deleting the
    // test it counted" is one of the four artifacts this feature's plan doc names. If the fixtures
    // ever collapse to one shared key set this line fails rather than the loop quietly running twice.
    expect(keysChecked).toBe(11);

    // Spelled out once, as the reader's own check against the loop: 12 + 30 comments observed.
    expect(got['volume']?.['commentsObserved']).toBe(42);
    expect(got['volume']?.['findings']).toBe(7); // repository 2 contributes 0, not a dropped key
    expect(got['volume']?.['approvals']).toBe(3);
    expect(got['overdueEligible']).toEqual({ '72': 13, '168': 4 });
    expect(got['overdueUntouched']).toEqual({ '72': 2, '168': 1 });

    // MUTATION-TESTED, and the results are what was observed rather than what was expected:
    //   `sumMaps`' `out[k] = (out[k] ?? 0) + v` → `out[k] = v` (last member wins, the shape an
    //     `Object.assign` refactor produces): 5 of 34 RED, first here on `volume.commentsObserved`
    //     (30 ≠ 42).
    //   `poolCounters(live)` → `poolCounters(input.repos)` (silent repositories counted): 1 of 34
    //     RED — the silent-repository test below, and ONLY that one. This test survives it, because
    //     its own fixtures are all live; that is why the silent case is a separate test with its
    //     counters poisoned rather than a clause in this one.
    // Both restored.
  });

  it('pools the LIVE repositories only — a declared-but-silent repository contributes nothing', () => {
    // ⚠ THE LINEUP IS DECLARED PER WORKSPACE AND THE FOLD EMITS A UNIT PER (REPOSITORY, REVIEWER),
    // so a vendor installed on two repositories of eleven arrives here with nine all-zero units.
    // Counting them would say "live in 11 of 11" about a reviewer nobody installed — and would drop
    // nine silent repositories' merge counts into the denominator of a cost figure the reviewer had
    // no part in, deflating it by an order of magnitude.
    const withSilent = build([...HOUSE(), silent({ repoId: 3, repoName: 'legacy' })], {
      reposConsidered: 3,
    });
    expect(withSilent.liveInRepos).toBe(2);
    expect(withSilent.reposConsidered).toBe(3);
    expect(withSilent.contributions.map((c) => c.repoId)).toEqual([1, 2]);
    // The silent repository's poisoned counters are nowhere on the card.
    expect(withSilent.counters.volume['findings']).toBe(7); // never 9007
    expect(withSilent.counters.repository['mergedPrs']).toBe(30); // never 9030
    // …and its 9,000 merges are out of the money too, which is the consequence that actually shows.
    if (withSilent.cost?.perMergedPr.status !== 'value') throw new Error('unreachable');
    expect(withSilent.cost.perMergedPr.mergedPrs).toBe(30);
    expect(withSilent.cost.perMergedPr.value).toBe(1.839685); // 55.190539 ÷ 30
    // ⚠ THE NUMBER THE LOOSE DEFINITION GIVES, NAMED: 55.190539 ÷ 9030 = 0.006112, which reads as a
    // fabulously cheap reviewer and is the direction a silent repository always errs in.
    expect(withSilent.cost.perMergedPr.value).not.toBe(0.006112);
    // A vendor live NOWHERE is a card with no rows at all — the route drops it, and the fold says so.
    const dead = build([silent({ repoId: 4 })], { reposConsidered: 4 });
    expect(dead.liveInRepos).toBe(0);
    expect(dead.contributions).toEqual([]);
  });

  it('keeps the evidence table row-for-row with the population every sum runs over', () => {
    // ⚠ THE TABLE IS THE AUDIT TRAIL. A card whose spread says "3 of 5" while its table lists four
    // repositories is caught by the reader, which is the entire reason the table ships beside the
    // numbers rather than behind a link.
    const rollup = build(HOUSE());
    expect(rollup.contributions).toHaveLength(rollup.liveInRepos);
    if (rollup.cost == null) throw new Error('unreachable');
    expect(rollup.cost.coveredRepos).toBe(rollup.contributions.length);
    const [first, second] = rollup.contributions;
    if (first == null || second == null) throw new Error('unreachable');
    // The counts are always real; the rate and the rank are gated. Repository 1 is fully compared.
    expect(first).toEqual({
      repoId: 1,
      repoOwner: 'acme',
      repoName: 'api',
      mergedPrsLast14d: 10,
      band: { activityBand: 6, nBands: 10, bandLabel: '6 of 10' },
      placementRefusal: null,
      actedOnRate: 0.2,
      percentile: 30,
      settledThreads: 20,
      actedThreads: 4,
      spanDays: 60,
    });
    expect(second.percentile).toBe(70);
    // …and the pooled thread counts are the table's own columns added up.
    if (rollup.cost.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.unacted.settledThreads).toBe(
      rollup.contributions.reduce((s, c) => s + c.settledThreads, 0),
    );
    expect(rollup.cost.unacted.actedThreads).toBe(
      rollup.contributions.reduce((s, c) => s + c.actedThreads, 0),
    );
  });

  it('publishes a WITHHELD rate as null while its counts still pool — the gate is on the ROW', () => {
    // ⚠ RULE 3, AND IT IS NOT A LOOPHOLE. `below_min_units` withholds a per-repository RATE because
    // four threads is noise wearing a percentage sign; pooling is the REMEDY that gate exists for.
    // So the row prints no rate, and its four threads still land in the card's denominator.
    const rollup = build([
      facts({ repoId: 1, settled: 4, acted: 1, actedOnRateMetric: excluded('below_min_units') }),
      facts({ repoId: 2, settled: 96, acted: 25, actedOnRateMetric: compared(0.26, 0.6, 40) }),
    ]);
    const [thin] = rollup.contributions;
    expect(thin?.actedOnRate).toBeNull(); // NOT 0.25 — the number the gate refused to publish
    expect(thin?.percentile).toBeNull(); // ⚠ NEVER 0, which reads as "worst in the cohort"
    expect(thin?.settledThreads).toBe(4); // …and the COUNTS are real and are published
    if (rollup.cost?.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.unacted.settledThreads).toBe(100);
    expect(rollup.cost.unacted.actedThreads).toBe(26);
    expect(rollup.cost.unacted.actedOnRate).toBe(0.26);
  });
});

describe('THE TWO-POPULATION RULE — the pooled headline and the fitted subset are different numbers', () => {
  /** Two fitted repositories and one the cohort refused this metric in. The unfitted one is
   *  DELIBERATELY the busiest and the most engaged, so the pooled rate and the fitted rate cannot be
   *  confused for each other by any rounding. */
  const mixedEstate = (unfitted: { settled: number; acted: number }): RollupRepoFacts[] => [
    facts({ repoId: 1, settled: 20, acted: 4, actedOnRateMetric: compared(0.2, 0.6, 30) }),
    facts({ repoId: 2, settled: 30, acted: 3, actedOnRateMetric: compared(0.1, 0.5, 20) }),
    facts({
      repoId: 3,
      settled: unfitted.settled,
      acted: unfitted.acted,
      actedOnRateMetric: uncompared(unfitted.acted / unfitted.settled),
    }),
  ];

  it('carries BOTH rates and BOTH repository counts, so a renderer can label them apart', () => {
    const rollup = build(mixedEstate({ settled: 50, acted: 40 }));
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    if (rollup.cost?.unacted.status !== 'value') throw new Error('unreachable');

    // THE POOLED HEADLINE — every live repository: (4 + 3 + 40) ÷ (20 + 30 + 50).
    expect(rollup.cost.unacted.actedOnRate).toBe(0.47);
    expect(rollup.cost.coveredRepos).toBe(3);

    // THE FITTED SUBSET — only the two the cohort published a median for: (4 + 3) ÷ (20 + 30).
    expect(rollup.expectation.yoursRateOnFitted).toBe(0.14);
    expect(rollup.expectation.fittedRepos).toBe(2);
    expect(rollup.expectation.excludedRepos).toBe(1);

    // ⚠ THE WHOLE POINT: they are not the same number, they are not close, and BOTH are on the wire
    // with their own denominators. A card carrying one of them cannot label the other.
    expect(rollup.expectation.yoursRateOnFitted).not.toBe(rollup.cost.unacted.actedOnRate);
    expect(rollup.expectation.fittedRepos).not.toBe(rollup.cost.coveredRepos);
    // …and `excludedRepos` is published rather than left to `liveInRepos − fittedRepos`.
    expect(rollup.expectation.fittedRepos + rollup.expectation.excludedRepos).toBe(
      rollup.liveInRepos,
    );

    // The peer side, over the SAME two repositories: 20×0.6 + 30×0.5 = 27, over 50 settled.
    expect(rollup.expectation.actedAtPeer).toBe(27);
    expect(rollup.expectation.expectedRate).toBe(0.54);
  });

  it('computes the gap from the FITTED rate — proved by moving a NON-fitted repository alone', () => {
    // ⚠ THE MUTATION TEST IS THE FIXTURE, not a comment. Two builds differing ONLY in repository 3's
    // acted/settled counts — a repository that is NOT in the fitted subset — must produce the SAME
    // gap. An implementation reading the pooled rate produces two different numbers here, and both
    // of them look perfectly plausible in isolation.
    const engaged = build(mixedEstate({ settled: 50, acted: 40 }));
    const idle = build(mixedEstate({ settled: 50, acted: 5 }));
    if (engaged.expectation.status !== 'value') throw new Error('unreachable');
    if (idle.expectation.status !== 'value') throw new Error('unreachable');
    if (engaged.cost?.unacted.status !== 'value') throw new Error('unreachable');
    if (idle.cost?.unacted.status !== 'value') throw new Error('unreachable');

    // The two estates genuinely differ — the pooled headline moves by 35 points…
    expect(engaged.cost.unacted.actedOnRate).toBe(0.47);
    expect(idle.cost.unacted.actedOnRate).toBe(0.12);
    expect(engaged.cost.unacted.unactedUsd).toBe(63.6); // 120 × 0.53
    expect(idle.cost.unacted.unactedUsd).toBe(105.6); // 120 × 0.88

    // …and every FITTED-subset figure is bit-identical, because the repository that moved is not in
    // that subset.
    expect(engaged.expectation.yoursRateOnFitted).toBe(0.14);
    expect(idle.expectation.yoursRateOnFitted).toBe(0.14);
    expect(engaged.expectation.conversionGapUsd).toBe(48); // 120 × (0.54 − 0.14)
    expect(idle.expectation.conversionGapUsd).toBe(48);
    expect(engaged.expectation).toEqual(idle.expectation);

    // ⚠ THE TWO WRONG ANSWERS, NAMED. A gap taken against the POOLED rate gives 8.40 on the engaged
    // estate and 50.40 on the idle one — a 42-dollar swing produced entirely by a repository the
    // comparison does not cover, on a card that would print both under the same words.
    expect(engaged.expectation.conversionGapUsd).not.toBe(8.4); // 120 × (0.54 − 0.47)
    expect(idle.expectation.conversionGapUsd).not.toBe(50.4); // 120 × (0.54 − 0.12)

    // MUTATION-TESTED. `buildExpectation`'s `yoursRateOnFitted` computed over the POOLED population
    // instead of the fitted subset (the shape a "reuse the engagement rate we already computed"
    // refactor produces): 2 of 34 RED — this test and its sibling above, and nothing else in the
    // file. Restored.
  });

  it('swaps ONE factor per repository — the customer’s threads, the cohort’s rate', () => {
    // ⚠ EACH REPOSITORY MEETS ITS OWN CELL'S MEDIAN, and the counts stay the customer's. Blending
    // the medians into one estate figure and multiplying it by an estate thread count is the
    // median-of-a-product error wearing a sum: THE MEDIAN OF A PRODUCT IS NOT THE PRODUCT OF THE
    // MEDIANS, and it is wrong in a direction nobody could check.
    const rollup = build([
      facts({ repoId: 1, settled: 20, acted: 4, actedOnRateMetric: compared(0.2, 0.6, 30) }),
      facts({ repoId: 2, settled: 30, acted: 9, actedOnRateMetric: compared(0.3, 0.5, 70) }),
    ]);
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    // 20 × 0.6 + 30 × 0.5 = 27 — the CUSTOMER's 20 and 30, the COHORT's 0.6 and 0.5.
    expect(rollup.expectation.actedAtPeer).toBe(27);
    // ⚠ THE BLENDED ANSWER, NAMED: a mean median of 0.55 against the estate's 50 settled threads is
    // 27.5, which is close enough here to pass any assertion written as "about 27" and diverges
    // without limit as the estate's repositories differ in size.
    expect(rollup.expectation.actedAtPeer).not.toBe(27.5);
    // …and the estate-weighted peer rate is NOT the mean of the two medians either.
    expect(rollup.expectation.expectedRate).toBe(0.54);
    expect(rollup.expectation.expectedRate).not.toBe(0.55);
  });
});

describe('THE COST WINDOW — one chosen calendar month at both ends of the fraction', () => {
  it('IS one calendar month, so a count inside it already IS a monthly pace', () => {
    // ⚠ THE CONSTANT ITSELF IS THE ASSERTION, and it is the load-bearing one in this file.
    // `getBotAnalytics.costPerActedOnUsd` (the Bots ROI tab, one tab away, same reviewer, same
    // price) computes `monthlyUsd ÷ ((acted × DAYS_PER_MONTH) ÷ windowDays)`. That expression
    // collapses to `monthlyUsd ÷ acted` — this module's arithmetic — at exactly ONE window length:
    // `windowDays === DAYS_PER_MONTH`. Anywhere else the two tabs disagree by
    // `DAYS_PER_MONTH ÷ COST_WINDOW_DAYS` FOREVER: at a round 30 days that is 1.45 %, small enough
    // to look like a rounding difference and large enough to be wrong.
    expect(COST_WINDOW_DAYS).toBe(DAYS_PER_MONTH);
    // …and a card may RENDER it as "30 days"; the divisor may not be 30.
    expect(Math.round(COST_WINDOW_DAYS)).toBe(30);
    expect(COST_WINDOW_DAYS).not.toBe(30);
  });

  it('divides the monthly price by the threads acted on INSIDE the window, and by nothing else', () => {
    // Two repositories with WILDLY different observation spans, so a revert to the span form is
    // visible rather than coincidentally close.
    const rollup = build([
      busy({ repoId: 1, spanDays: 30, settledInWindow: 40, actedInWindow: 8 }),
      busy({ repoId: 2, spanDays: 237, settledInWindow: 60, actedInWindow: 12 }),
    ]);
    if (rollup.cost?.yours.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.yours.actedThreads).toBe(20); // 8 + 12
    expect(rollup.cost.yours.settledThreads).toBe(100); // 40 + 60
    expect(rollup.cost.yours.perActedOnUsd).toBe(6); // 120 ÷ 20, and NOTHING else
    // ⚠ A COUNT INSIDE ONE MONTH IS A MONTHLY PACE. No annualising factor survives, which is why
    // there is no longer anything here to get wrong in the direction nobody can check.
    expect(rollup.cost.yours.actedPerMonth).toBe(rollup.cost.yours.actedThreads);

    // ⚠ THE SPAN ANSWERS, NAMED — this is the defect, in this fixture's own numbers.
    //   Σ acted × 30.44 ÷ spanDays over the SLICE pair (30 each): 30×30.44÷30 + 30×30.44÷237
    //   = 30.44 + 3.853165 = 34.293165, and 120 ÷ that:
    expect(rollup.cost.yours.actedPerMonth).not.toBe(34.293165);
    expect(rollup.cost.yours.perActedOnUsd).not.toBe(3.499); // ≈ 120 ÷ 34.293165
    // …and the single-span union form, which is what produced US$23.94 on the real erxes card.
    expect(rollup.cost.yours.perActedOnUsd).not.toBe(23.942874);

    // ⚠ THE FIGURE IS RECOMPUTABLE FROM THE TWO NUMBERS THE CARD PRINTS BESIDE IT. That property
    // is the whole change: the version this replaced could not be derived from anything on screen.
    expect(rollup.cost.monthlyUsd! / rollup.cost.yours.actedThreads).toBe(
      rollup.cost.yours.perActedOnUsd,
    );

    // MUTATION-TESTED. `perActedOnUsd: round6(money / actedInWindow)` replaced by
    // `round6(money / pooledActed)` — the slice-wide count: RED here (120 ÷ 60 = 2 against 6), and
    // RED in the two-populations test below. Restored.
  });

  it('counts the WINDOW’s pair on `yours` and the SLICE’s pair on `unacted` — never one row', () => {
    // ⚠ TWO POPULATIONS UNDER THE SAME FIELD NAMES, ON ONE CARD. `unacted` is the headline over
    // every pull request the walk read; `yours` is the last month. They are different numbers and
    // the renderer names each — this is docs/PERIOD-REPORTING.md's "ONE ROW MUST NEVER MIX THE
    // HEADLINE AND SUBSET POPULATIONS", arriving one grain over.
    const rollup = build([busy()]);
    if (rollup.cost?.yours.status !== 'value') throw new Error('unreachable');
    if (rollup.cost.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.unacted.settledThreads).toBe(90);
    expect(rollup.cost.unacted.actedThreads).toBe(30);
    expect(rollup.cost.unacted.actedOnRate).toBe(0.333333); // 30 ÷ 90, the whole slice
    expect(rollup.cost.yours.settledThreads).toBe(60);
    expect(rollup.cost.yours.actedThreads).toBe(20);
    expect(rollup.cost.yours.actedOnRate).toBe(0.333333); // 20 ÷ 60, the last month
    // ⚠ AND `unacted` DID NOT MOVE TO THE WINDOW. It is a share of the monthly price times a rate,
    // additively consistent with the pooled counters printed above it; narrowing it would break the
    // evidence table's agreement with its own headline.
    expect(rollup.cost.unacted.unactedUsd).toBe(80.00004); // 120 × (1 − 0.333333)
    // The windowed pair is a SUBSET of the slice pair, always.
    expect(rollup.cost.yours.settledThreads).toBeLessThan(rollup.cost.unacted.settledThreads);
    expect(rollup.cost.yours.actedThreads).toBeLessThan(rollup.cost.unacted.actedThreads);
  });

  it('refuses `window_underpopulated` under the floor, and keeps everything else', () => {
    // Nine acted-on threads in the month: one short. ⚠ THE FIGURE WOULD MOVE 11 % ON THE TENTH
    // THREAD LANDING INSIDE THE WINDOW, which is why a price divided by a handful is not reported.
    const rollup = build([busy({ actedInWindow: COST_WINDOW_MIN_ACTED - 1, settledInWindow: 40 })]);
    expect(reasonOf(rollup.cost!.yours)).toBe('window_underpopulated');
    expect(rollup.cost!.yours).not.toHaveProperty('perActedOnUsd');
    // ⚠ AND ONLY THE PER-THREAD MONEY. The counters, the pooled rate and the unacted figure are
    // over every pull request read and are untouched by a thin month; withholding them too would
    // delete real findings because a recent window was quiet.
    expect(rollup.cost!.unacted.status).toBe('value');
    expect(rollup.cost!.perMergedPr.status).toBe('value');
    expect(rollup.counters.volume['commentsObserved']).toBe(12);
    // …and EXACTLY at the floor it renders, so the boundary is pinned on both sides.
    const atFloor = build([busy({ actedInWindow: COST_WINDOW_MIN_ACTED, settledInWindow: 40 })]);
    expect(atFloor.cost!.yours.status).toBe('value');
    if (atFloor.cost!.yours.status !== 'value') throw new Error('unreachable');
    expect(atFloor.cost!.yours.perActedOnUsd).toBe(12); // 120 ÷ 10
  });

  it('the default estate is under the floor — pinned, so no assertion passes vacuously', () => {
    // ⚠ THIS FILE'S HEADER WARNS ABOUT THE ACCIDENTALLY-SILENT FIXTURE, and a refusing default is
    // the same hazard wearing money. `facts()` gives four acted-on threads a month; that is under
    // the floor by design (so a test asking for a FIGURE has to say so, via `busy()`), and it is
    // written down here rather than discovered by whoever adds the next money assertion.
    expect(reasonOf(build([facts()]).cost!.yours)).toBe('window_underpopulated');
  });

  it('refuses an EMPTY month rather than falling back to the slice’s own average', () => {
    // ⚠ A DORMANT REVIEWER, AND THE ONE FALLBACK THAT MUST NEVER EXIST. Thirty acted-on threads in
    // the history, none in the last month: the honest answer is a refusal, not the lifetime average
    // smeared against today's price — a plausible number measuring nothing, which is the defect
    // class this whole window exists to remove.
    const rollup = build([busy({ settledInWindow: 0, actedInWindow: 0 })]);
    expect(reasonOf(rollup.cost!.yours)).toBe('nothing_acted_on');
    expect(rollup.cost!.yours).not.toHaveProperty('perActedOnUsd');
    // The slice-wide average it must not have fallen back to: 120 ÷ 30 = US$4.00.
    expect(JSON.stringify(rollup.cost!.yours)).not.toContain('4');
    // …and `unacted` still renders, because a share of the price is not a per-thread price.
    expect(rollup.cost!.unacted.status).toBe('value');
    // ⚠ "EMPTY" AND "TOO THIN" ARE TWO FACTS WITH TWO SENTENCES. Collapsing them would tell a team
    // whose bot went quiet that they merely need a bigger sample.
    expect(reasonOf(build([busy({ actedInWindow: 3, settledInWindow: 20 })]).cost!.yours)).toBe(
      'window_underpopulated',
    );
  });

  it('refuses a repository younger than the cost window, and does NOT exclude it instead', () => {
    // ⚠ EXCLUDING WOULD MAKE IT WORSE. `perMergedPr` can drop a partial repository because that
    // figure divides by a SUM the repository contributes a term to; dropping a term here removes
    // work from a denominator the WHOLE price still sits over, so the quotient rises further. The
    // price is whole and the month is not — the same argument `workspace_truncated` makes about a
    // partial estate, and the same answer: withhold, and say for how long.
    const rollup = build([
      busy({ repoId: 1, repoHeldDays: 400 }),
      busy({ repoId: 2, repoHeldDays: 12 }),
    ]);
    expect(reasonOf(rollup.cost!.yours)).toBe('repo_window_incomplete');
    expect(rollup.cost!.costWindowIncompleteRepos).toBe(1);
    // …the young repository's threads still POOL, so nothing was silently deleted from the card.
    if (rollup.cost!.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost!.unacted.settledThreads).toBe(180);
    expect(rollup.contributions).toHaveLength(2);
    // …and the counterfactual's money goes quiet under the SAME reason, so the card carries one
    // account of one cause rather than two.
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.perActedOnUsd).toBeNull();
    expect(rollup.expectation.moneyRefusal?.reason).toBe('repo_window_incomplete');

    // ⚠ THE THRESHOLD IS THE COST WINDOW, NOT THE PLACEMENT'S FORTNIGHT. A repository held for 20
    // days passes the banding window and still has two thirds of a month — the old gate would have
    // let it through.
    expect(reasonOf(build([busy({ repoHeldDays: 20 })]).cost!.yours)).toBe('repo_window_incomplete');
    expect(build([busy({ repoHeldDays: 31 })]).cost!.yours.status).toBe('value');
  });

  it('lets a repository with NO observable span contribute normally — nothing divides by it', () => {
    // ⚠ THE RULE THAT WAS DELETED, AND IT WAS DELETED IN THE HONEST DIRECTION. A repository without
    // a readable comment span used to contribute NOTHING to the pace, which understated the estate's
    // throughput and therefore OVERSTATED its cost per thread. With the pace gone, its threads count
    // like any other's and the missing span is a note about the evidence table's own column.
    const rollup = build([
      busy({ repoId: 1, spanDays: null }),
      busy({ repoId: 2, spanDays: 30 }),
    ]);
    if (rollup.cost?.yours.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.spanUnobservedRepos).toBe(1);
    expect(rollup.cost.yours.actedThreads).toBe(40); // BOTH repositories, 20 + 20
    expect(rollup.cost.yours.perActedOnUsd).toBe(3); // 120 ÷ 40
    // The old answer, which counted only the spanned repository: 20 × 30.44 ÷ 30 = 20.293333.
    expect(rollup.cost.yours.perActedOnUsd).not.toBe(5.913);
    expect(rollup.contributions[0]?.spanDays).toBeNull();
    // …and a WHOLLY unspanned estate is no longer a money refusal at all.
    const none = build([busy({ spanDays: null }), busy({ repoId: 9, spanDays: null })]);
    expect(none.cost!.yours.status).toBe('value');
    expect(none.cost!.unacted.status).toBe('value');
    expectAllFinite(none);
  });

  it('swaps the cohort median into the WINDOW’s count too, one repository at a time', () => {
    // ⚠ THE MEASURED FIGURE AND THE COUNTERFACTUAL SIT IN ADJACENT ROWS OF ONE TABLE, so they must
    // be on one time base. A per-thread price over the slice beside one over the month is this
    // change's own defect arriving from the counterfactual's side.
    const rollup = build([
      busy({ repoId: 1, settledInWindow: 20, actedInWindow: 10, actedOnRateMetric: compared(0.2, 0.6, 30) }),
      busy({ repoId: 2, settledInWindow: 30, actedInWindow: 12, actedOnRateMetric: compared(0.3, 0.5, 70) }),
    ]);
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    // 20 × 0.6 + 30 × 0.5 = 27 — the CUSTOMER's windowed counts, each meeting its OWN cell's median.
    expect(rollup.expectation.actedPerMonthAtPeer).toBe(27);
    expect(rollup.expectation.perActedOnUsd).toBe(4.444444); // 120 ÷ 27
    // ⚠ THE BLENDED ANSWER, NAMED: one mean median of 0.55 against the estate's 50 windowed threads
    // is 27.5 — close enough to pass "about 27" and unbounded as the repositories differ in size.
    expect(rollup.expectation.actedPerMonthAtPeer).not.toBe(27.5);
    // ⚠ AND THE SLICE-WIDE ANSWER, NAMED: 90 × 0.6 + 90 × 0.5 = 99, which is what a counterfactual
    // left on the old population would have printed beside a windowed measured figure.
    expect(rollup.expectation.actedPerMonthAtPeer).not.toBe(99);
    // ⚠ THE TWO RATES STAY ON THE SLICE, deliberately: they are set against cohort medians fitted
    // over the corpus's own unwindowed slice, and narrowing one side compares two questions.
    expect(rollup.expectation.yoursRateOnFitted).toBe(0.333333); // 60 ÷ 180, not 22 ÷ 50
  });
});

describe('`workspace_truncated` — a partial estate kills the money and spares the rest', () => {
  it('refuses EVERY money arm while the counters, the table and the spread still render', () => {
    const rollup = build(HOUSE(), { truncated: true, reposConsidered: 12 });
    // THE MONEY, all of it.
    for (const arm of [rollup.cost!.perMergedPr, rollup.cost!.unacted, rollup.cost!.yours]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      expect(arm.reason).toBe('workspace_truncated');
      // ⚠ STRUCTURALLY: reading a figure off a refusal must be impossible, not too high.
      expect(arm).not.toHaveProperty('value');
      expect(arm).not.toHaveProperty('unactedUsd');
      expect(arm).not.toHaveProperty('perActedOnUsd');
    }
    // …and the PRICE itself still renders. It is a real recorded fact; nothing about the estate
    // being partial makes the subscription less real.
    expect(rollup.cost!.monthlyUsd).toBe(120);
    expect(rollup.cost!.windowUsd).toBe(55.190539);

    // THE EXPECTATION'S MONEY HALVES GO WITH IT — under the SAME refusal object, so a truncated
    // estate never produces two accounts of one cause…
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.perActedOnUsd).toBeNull();
    expect(rollup.expectation.conversionGapUsd).toBeNull();
    expect(rollup.expectation.moneyRefusal?.reason).toBe('workspace_truncated');
    // …while its RATES survive, because a rate over the repositories that WERE read is an honest
    // rate over the repositories that were read.
    expect(rollup.expectation.yoursRateOnFitted).toBe(0.26);
    expect(rollup.expectation.expectedRate).toBe(0.54);

    // THE COUNTERS AND THE SPREAD: a sum of counts over the repositories read is an honest sum, and
    // a rank distribution is a shape rather than a total.
    expect(rollup.counters.volume['commentsObserved']).toBe(42);
    expect(rollup.spread).toEqual({ status: 'value', placed: 2, below: 1, at: 0, above: 1 });
    expect(rollup.contributions).toHaveLength(2);
    expectAllFinite(rollup);
  });

  it('OUTRANKS every other cost refusal, whatever else is also wrong', () => {
    // ⚠ THE GUARD ORDER IS THE RULE. Two different refusals on one card for one cause is how a
    // reader stops believing either — and truncation is the one that makes the exact claim FALSE
    // rather than merely unavailable, so it goes first whatever the price or the repositories say.
    const shapes: Array<[string, BotBenchmarkWorkspaceRollup]> = [
      ['a stored zero price', build(HOUSE(), { truncated: true, price: flat(0) })],
      ['an unstatable price', build(HOUSE(), { truncated: true, price: unstatable() })],
      [
        'an estate that merged nothing',
        build([facts({ mergedPrsLast14d: 0 }), facts({ mergedPrsLast14d: 0 })], {
          truncated: true,
        }),
      ],
      [
        'a wholly partial window',
        build(
          [
            facts({ placement: unplaced('repo_window_incomplete') }),
            facts({ placement: unplaced('repo_window_incomplete') }),
          ],
          { truncated: true },
        ),
      ],
      ['a thin cost window', build([facts({ actedInWindow: 1 })], { truncated: true })],
      ['a repository younger than the cost window', build([busy({ repoHeldDays: 3 })], { truncated: true })],
      [
        'no settled threads anywhere',
        build([facts({ settled: 0, acted: 0 })], { truncated: true }),
      ],
    ];
    for (const [label, rollup] of shapes) {
      expect(reasonOf(rollup.cost!.perMergedPr), label).toBe('workspace_truncated');
      expect(reasonOf(rollup.cost!.unacted), label).toBe('workspace_truncated');
      expect(reasonOf(rollup.cost!.yours), label).toBe('workspace_truncated');
      expectAllFinite(rollup, label);
    }
    // …and each of those SAME shapes untruncated reaches its own reason, so the assertions above are
    // not passing because the fixtures happen to be otherwise fine.
    expect(reasonOf(build(HOUSE(), { price: flat(0) }).cost!.unacted)).toBe('price_is_zero');
    expect(
      reasonOf(build([facts({ mergedPrsLast14d: 0 })]).cost!.perMergedPr),
    ).toBe('no_merges_in_window');
    expect(reasonOf(build([facts({ actedInWindow: 1 })]).cost!.yours)).toBe('window_underpopulated');
    expect(reasonOf(build([busy({ repoHeldDays: 3 })]).cost!.yours)).toBe('repo_window_incomplete');

    // MUTATION-TESTED. The `input.truncated` guard moved BELOW the two repository gates: 1 of 34
    // RED — this test, on the "merged nothing" row (`no_merges_in_window` reached first); the
    // "wholly partial window" row is the second one it would have caught. ⚠ The four PRICE and WINDOW
    // rows survive that mutation, because those guards sit AFTER the repository ones either way —
    // which is exactly why this test sweeps six shapes rather than asserting on one.
    // Restored.
  });
});

describe('THE SPREAD — a shape over the placed subset, never a total and never a single point', () => {
  it('counts below, at and above, and its denominator is NOT `liveInRepos`', () => {
    const rollup = build([
      facts({ repoId: 1, actedOnRateMetric: compared(0.2, 0.6, 12) }), // below
      facts({ repoId: 2, actedOnRateMetric: compared(0.2, 0.6, 50) }), // exactly at
      facts({ repoId: 3, actedOnRateMetric: compared(0.2, 0.6, 88) }), // above
      // Placed, but the cohort refused this metric in its cell — no percentile exists.
      facts({ repoId: 4, actedOnRateMetric: uncompared(0.2) }),
      // Comparable-looking metric, but the repository itself was never placed.
      facts({ repoId: 5, placement: unplaced('cell_not_in_corpus'), actedOnRateMetric: compared(0.2, 0.6, 99) }),
    ]);
    expect(rollup.spread).toEqual({ status: 'value', placed: 3, below: 1, at: 1, above: 1 });
    // ⚠ `below + at + above === placed`, and `placed` is SMALLER than the card's population. A
    // renderer quoting `liveInRepos` here is quoting the wrong denominator.
    expect(rollup.liveInRepos).toBe(5);
    if (rollup.spread.status !== 'value') throw new Error('unreachable');
    expect(rollup.spread.below + rollup.spread.at + rollup.spread.above).toBe(rollup.spread.placed);
    expect(rollup.spread.placed).toBeLessThan(rollup.liveInRepos);
    // ⚠ 50 IS `at`, NOT `above`. A `>= 50` comparison moves the median itself into the flattering
    // bucket, and the median is the one rank that lands there most often.
    expect(rollup.spread.at).toBe(1);
  });

  it('refuses `single_repo` at exactly one placement, and never returns `{placed: 1}`', () => {
    // ⚠ ONE POINT IS NOT A THIN SPREAD, IT IS NO SPREAD. "1 of 1 above the median" invites a reader
    // to see a pattern in a single placement, and the repository's own card already says everything
    // there is to say about it.
    const one = build([
      facts({ repoId: 1, actedOnRateMetric: compared(0.2, 0.6, 88) }),
      facts({ repoId: 2, actedOnRateMetric: uncompared(0.2) }),
    ]);
    expect(one.spread).toEqual({
      status: 'refused',
      reason: 'single_repo',
      message: ROLLUP_REFUSAL_MESSAGE.single_repo,
    });
    // ⚠ STRUCTURALLY: there is no count to read off it.
    expect(one.spread).not.toHaveProperty('placed');
    expect(one.spread).not.toHaveProperty('above');
    // …and exactly at the boundary, TWO placements are a spread: `=== 1`, never `<= 1`.
    const two = build([
      facts({ repoId: 1, actedOnRateMetric: compared(0.2, 0.6, 88) }),
      facts({ repoId: 2, actedOnRateMetric: compared(0.2, 0.6, 12) }),
    ]);
    expect(two.spread.status).toBe('value');
  });

  it('refuses `no_placed_repos` at zero, which is an absence and not a middling score', () => {
    const none = build([
      facts({ repoId: 1, placement: unplaced('repo_window_incomplete') }),
      facts({ repoId: 2, actedOnRateMetric: excluded('below_min_units') }),
    ]);
    expect(reasonOf(none.spread)).toBe('no_placed_repos');
    expect(none.spread).not.toHaveProperty('placed');
    // ⚠ AND THE TABLE STILL NAMES THE REASON PER REPOSITORY — they are not the same reason, and the
    // card's one sentence is their sum rather than a substitute for them.
    expect(none.contributions[0]?.placementRefusal).toBe('repo_window_incomplete');
    expect(none.contributions[1]?.placementRefusal).toBeNull(); // placed; its METRIC was withheld
    expect(none.contributions[1]?.percentile).toBeNull();
  });
});

describe('A VENDOR THE CORPUS HAS NEVER MEASURED — counters and cost, no comparison at all', () => {
  it('renders the customer’s own facts and refuses both comparison sections', () => {
    // ⚠ THE COMMON CASE, NOT THE EDGE CASE. Sonar, GitHub Advanced Security and `github-actions` are
    // real multi-repository reviewers and none of them is in the seven-vendor corpus. A card that
    // vanished for want of a peer would delete the customer's own measurements — and their price —
    // because a third party has not been fitted.
    const rollup = build([
      facts({
        repoId: 1,
        placement: unplaced('vendor_not_in_corpus_vocabulary'),
        actedOnRateMetric: excluded('vendor_silent'),
      }),
      facts({
        repoId: 2,
        placement: unplaced('vendor_not_in_corpus_vocabulary'),
        actedOnRateMetric: excluded('vendor_silent'),
        settled: 30,
        acted: 9,
        spanDays: 30,
        counters: counters({ volume: { commentsObserved: 30 }, repository: { mergedPrs: 20 } }),
      }),
    ], { vendor: null, key: 'sonarqube', botKind: 'static_analysis' });

    // THE CARD'S IDENTITY IS THE WORKSPACE KEY, never `vendor` — n unbranded vendors would otherwise
    // collapse onto one `null` card.
    expect(rollup.key).toBe('sonarqube');
    expect(rollup.vendor).toBeNull();
    expect(rollup.botKind).toBe('static_analysis');

    // THE CUSTOMER'S OWN FACTS, in full.
    expect(rollup.counters.volume['commentsObserved']).toBe(42);
    expect(rollup.contributions).toHaveLength(2);
    if (rollup.cost?.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.unacted.actedOnRate).toBe(0.26); // 13 ÷ 50
    expect(rollup.cost.unacted.unactedUsd).toBe(88.8); // 120 × 0.74
    // ⚠ THE WINDOW'S FLOOR IS NOT A COHORT FACT. This estate acted on 13 threads over everything
    // read, which is above the floor, so the money renders whatever the corpus knows about the brand.
    if (rollup.cost.yours.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.yours.actedThreads).toBe(13);
    expect(rollup.cost.yours.perActedOnUsd).toBe(9.230769); // 120 ÷ 13

    // AND NOTHING ABOUT A PEER.
    expect(reasonOf(rollup.spread)).toBe('vendor_not_in_corpus');
    expect(reasonOf(rollup.expectation)).toBe('vendor_not_in_corpus');
    // ⚠ Both sections say it in the SAME words, because it is one fact.
    if (rollup.spread.status !== 'refused') throw new Error('unreachable');
    if (rollup.expectation.status !== 'refused') throw new Error('unreachable');
    expect(rollup.spread.message).toBe(ROLLUP_REFUSAL_MESSAGE.vendor_not_in_corpus);
    expect(rollup.expectation.message).toBe(rollup.spread.message);

    // ⚠ NO PERCENTILE ANYWHERE IN THE PAYLOAD — walked LIVE, key by key, not searched for in a
    // serialised string. A rank against a cohort that has never seen this brand is a fabrication,
    // and `0` is the shape it would take.
    const ranks = collectValues(rollup, 'percentile');
    expect(ranks.length).toBeGreaterThan(0); // the key exists on every row — this is not vacuous
    expect(ranks.every((r) => r === null)).toBe(true);
    expect(ranks).not.toContain(0);
    expectAllFinite(rollup);
  });

  it('refuses the expectation ALONE when the vendor IS in the corpus and no cell was fitted', () => {
    // ⚠ A DIFFERENT FACT WITH A DIFFERENT REMEDY: "we have never measured this brand" versus "we
    // measured it and these bands refused this one metric". One is permanent, one waits for the next
    // corpus refresh, and collapsing them into a single "no peer data" is the defect this
    // vocabulary exists to prevent.
    const rollup = build([
      busy({ repoId: 1, actedOnRateMetric: uncompared(0.2) }),
      busy({ repoId: 2, actedOnRateMetric: uncompared(0.3) }),
    ]);
    expect(reasonOf(rollup.expectation)).toBe('no_fitted_cohort_rate');
    expect(reasonOf(rollup.spread)).toBe('no_placed_repos');
    // The customer's own money is untouched: it needs no cohort at all.
    expect(rollup.cost!.unacted.status).toBe('value');
    expect(rollup.cost!.yours.status).toBe('value');
    expect(rollup.cost!.perMergedPr.status).toBe('value');
  });

  it('refuses `no_settled_threads` when the fitted repositories settled nothing', () => {
    // A summariser that opens no review threads. Reporting that as 0 % engagement is a claim about a
    // reviewer that has not yet been given the chance to be acted on.
    const rollup = build([
      facts({ repoId: 1, settled: 0, acted: 0 }),
      facts({ repoId: 2, settled: 0, acted: 0 }),
    ]);
    expect(reasonOf(rollup.expectation)).toBe('no_settled_threads');
    // …and the money says the same thing in ITS vocabulary, naming the metric and the gate rather
    // than a generic "not enough data".
    if (rollup.cost?.unacted.status !== 'refused') throw new Error('unreachable');
    expect(rollup.cost.unacted.reason).toBe('own_rate_withheld');
    expect(rollup.cost.unacted.metric).toBe('acted_on_rate');
    expect(rollup.cost.unacted.metricReason).toBe('denominator_empty');
    // ⚠ AND `$ per merged PR` STILL RENDERS — "you paid this much and this is what it produced" is
    // the whole question when the reviewer's own metrics came back empty.
    expect(rollup.cost.perMergedPr.status).toBe('value');
  });
});

describe('NULL IS NOT ZERO — three prices, three different answers', () => {
  it('NO PRICE SET carries no `cost` KEY at all — absent, not empty and not zero', () => {
    // ⚠ THE WHOLE POINT. "US$0.00 per acted-on thread" is a claim about a reviewer nobody priced.
    const rollup = build(HOUSE(), { price: null });
    expect('cost' in rollup).toBe(false);
    expect(rollup.cost).toBeUndefined();
    // …and the rest of the card is unaffected: counters, table, spread and the comparison's RATES
    // are the customer's own measurements and owe a subscription figure nothing.
    expect(rollup.counters.volume['commentsObserved']).toBe(42);
    expect(rollup.spread.status).toBe('value');
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.expectedRate).toBe(0.54);
    expect(rollup.expectation.yoursRateOnFitted).toBe(0.26);
    // ⚠ AND `moneyRefusal` IS `null` HERE, NOT A SENTENCE. There is no money anywhere on this card,
    // so there is no absence to explain — the other reading of this `null` (both figures present)
    // is distinguished by the `cost` key, which is exactly why the two share a field.
    expect(rollup.expectation.moneyRefusal).toBeNull();
    expect(rollup.expectation.perActedOnUsd).toBeNull();
    expect(rollup.expectation.conversionGapUsd).toBeNull();
  });

  it('A STORED 0 is a real price: the block renders and every derived figure refuses', () => {
    // ⚠ `0` = "we pay nothing for this", deliberately recorded. Every division of it is 0.00, which
    // is TRUE and reads as a broken panel — so the price renders and the figures refuse with a
    // sentence. Any implementation leaning on truthiness collapses this into the absent case.
    const rollup = build(HOUSE(), { price: flat(0) });
    expect(rollup.cost).not.toBeUndefined();
    expect(rollup.cost!.monthlyUsd).toBe(0);
    expect(rollup.cost!.windowUsd).toBe(0);
    for (const arm of [rollup.cost!.perMergedPr, rollup.cost!.unacted, rollup.cost!.yours]) {
      expect(arm.status).toBe('refused');
      if (arm.status !== 'refused') throw new Error('unreachable');
      expect(arm.reason).toBe('price_is_zero');
      expect(arm).not.toHaveProperty('value');
      expect(arm).not.toHaveProperty('unactedUsd');
    }
    // ⚠ THE SENTENCE RULES OUT THE OTHER WAY OF REACHING ZERO, because a reader who has just been
    // told "recorded as free" has no other way to know a seat count was not involved.
    if (rollup.cost!.perMergedPr.status !== 'refused') throw new Error('unreachable');
    expect(rollup.cost!.perMergedPr.message).toMatch(/stored, deliberate zero/);
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.moneyRefusal?.reason).toBe('price_is_zero');
    expect(rollup.expectation.expectedRate).toBe(0.54); // the RATES are unharmed by a free reviewer
  });

  it('A PRICE ENTERED AND UNSTATABLE renders a block with NO monthly figure and the counters', () => {
    // ⚠ THE THIRD STATE, AND THE ONE THAT SHIPPED AS TOTAL SILENCE one grain down. Every priced row
    // is per-seat and every one was dropped; answering `null` would hand the NO-PRICE experience to
    // a workspace where somebody typed US$15 a developer, taking the disclosure that explains it off
    // the screen with it.
    const rollup = build(HOUSE(), { price: unstatable() });
    expect(rollup.cost).not.toBeUndefined();
    expect(rollup.cost!.monthlyUsd).toBeNull(); // ⚠ NOT 0 — that is "recorded as free", which is a lie
    expect(rollup.cost!.windowUsd).toBeNull();
    expect(rollup.cost!.pricedReviewers).toBe(0);
    expect(rollup.cost!.seatPriceUnresolved).toBe(1);
    expect(rollup.cost!.seatCountZero).toBe(0);
    for (const arm of [rollup.cost!.perMergedPr, rollup.cost!.unacted, rollup.cost!.yours]) {
      expect(reasonOf(arm)).toBe('price_unresolved');
    }
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.moneyRefusal?.reason).toBe('price_unresolved');
    expectAllFinite(rollup);

    // …and the three answers are pairwise different, which is the assertion the collapse would kill.
    expect('cost' in build(HOUSE(), { price: null })).toBe(false);
    expect(build(HOUSE(), { price: flat(0) }).cost?.monthlyUsd).toBe(0);
    expect(build(HOUSE(), { price: unstatable() }).cost?.monthlyUsd).toBeNull();
  });

  it('carries the per-seat halves through unchanged — the multiply lives in `resolveUnitPrice`', () => {
    // ⚠ THE MULTIPLY EXISTS IN THREE PLACES AND MUST STAY IN LOCKSTEP; a fourth one here is how the
    // estate card and the repository card come to disagree about what a subscription costs. The
    // rollup does no arithmetic on the price at all — it reports the resolved figure and both halves.
    const price = resolveUnitPrice([{ unitMonthlyUsd: 15, costModel: 'per_seat' }], 8);
    const rollup = build(HOUSE(), { price });
    expect(rollup.cost!.monthlyUsd).toBe(120); // 15 × 8, computed exactly once, upstream
    expect(rollup.cost!.unitMonthlyUsd).toBe(15);
    expect(rollup.cost!.seats).toBe(8);
    expect(rollup.cost!.costModel).toBe('per_seat');
    expect(rollup.cost!.windowUsd).toBe(55.190539);
  });
});

describe('THE REPOSITORY GATES AT ESTATE GRAIN — one bad repository is excluded, not fatal', () => {
  it('keeps a PARTIAL-WINDOW repository out of the merge sum ALONE, and discloses it', () => {
    // ⚠ A PARTIAL WINDOW IS AN UNDERCOUNT AND IT LANDS IN A DENOMINATOR, so leaving it in inflates
    // the estate's cost per merged pull request — silently, and in the direction that flatters the
    // finding. Only the MERGE COUNT is windowed, so only the merge sum drops it: its counters, its
    // threads and its pace all still pool, and its row still prints.
    const rollup = build([
      facts({ repoId: 1, mergedPrsLast14d: 10, placement: unplaced('repo_window_incomplete') }),
      facts({ repoId: 2, mergedPrsLast14d: 20, settled: 30, acted: 9, spanDays: 30 }),
    ]);
    expect(rollup.cost!.partialWindowRepos).toBe(1);
    if (rollup.cost!.perMergedPr.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost!.perMergedPr.mergedPrs).toBe(20); // repository 1's 10 are an undercount
    expect(rollup.cost!.perMergedPr.value).toBe(2.759527); // 55.190539 ÷ 20
    // ⚠ THE INFLATED ANSWER, NAMED: 55.190539 ÷ 30 = 1.839685 reads 33 % CHEAPER, which is the
    // direction a partial window always errs in and the one nobody queries.
    expect(rollup.cost!.perMergedPr.value).not.toBe(1.839685);
    // …and everything that does not divide by the window keeps both repositories.
    if (rollup.cost!.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost!.unacted.settledThreads).toBe(50);
    expect(rollup.cost!.coveredRepos).toBe(2);
    expect(rollup.contributions).toHaveLength(2);
    expect(rollup.contributions[0]?.placementRefusal).toBe('repo_window_incomplete');
  });

  it('refuses the whole block only when EVERY live repository is partial', () => {
    const all = build([
      facts({ repoId: 1, placement: unplaced('repo_window_incomplete') }),
      facts({ repoId: 2, placement: unplaced('repo_window_incomplete') }),
    ]);
    for (const arm of [all.cost!.perMergedPr, all.cost!.unacted, all.cost!.yours]) {
      expect(reasonOf(arm)).toBe('repo_window_incomplete');
    }
    // ⚠ AND IT OUTRANKS THE ZERO-PRICE SENTENCE — facts about the repositories before facts about
    // the money, `cost.ts`'s order lifted verbatim.
    const free = build(
      [facts({ placement: unplaced('repo_window_incomplete') })],
      { price: flat(0) },
    );
    expect(reasonOf(free.cost!.perMergedPr)).toBe('repo_window_incomplete');
  });

  it('refuses `no_merges_in_window` only when the estate merged nothing, not when one repo did not', () => {
    const some = build([
      facts({ repoId: 1, mergedPrsLast14d: 0 }),
      facts({ repoId: 2, mergedPrsLast14d: 20 }),
    ]);
    if (some.cost!.perMergedPr.status !== 'value') throw new Error('unreachable');
    // ⚠ A QUIET FORTNIGHT IN ONE REPOSITORY IS NOT A REFUSAL — pooling is what this grain is for,
    // and refusing the estate because one member was idle would make the card fragile in exactly
    // the shape a real estate takes.
    expect(some.cost!.perMergedPr.mergedPrs).toBe(20);
    const none = build([facts({ mergedPrsLast14d: 0 }), facts({ mergedPrsLast14d: 0 })]);
    for (const arm of [none.cost!.perMergedPr, none.cost!.unacted, none.cost!.yours]) {
      expect(reasonOf(arm)).toBe('no_merges_in_window');
    }
    expectAllFinite(none);
  });

  it('refuses the per-thread figure alone when nothing anywhere was acted on', () => {
    // ⚠ THE STRONGEST FINDING THIS CARD PRODUCES, and the one where the per-thread figure refuses
    // while the other two render: "all of it reaches nothing" needs no cohort and no division.
    const rollup = build([
      facts({ repoId: 1, acted: 0, actedOnRateMetric: compared(0, 0.6, 5) }),
      facts({ repoId: 2, acted: 0, settled: 30, spanDays: 30, actedOnRateMetric: compared(0, 0.5, 3) }),
    ]);
    expect(reasonOf(rollup.cost!.yours)).toBe('nothing_acted_on');
    if (rollup.cost!.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost!.unacted.unactedUsd).toBe(120); // the WHOLE monthly price
    expect(rollup.cost!.unacted.actedOnRate).toBe(0);
    expect(rollup.cost!.perMergedPr.status).toBe('value');
    // …and the comparison still renders, which is exactly the case it exists for.
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.yoursRateOnFitted).toBe(0);
    // 120 × (0.54 − 0), where 0.54 is (20×0.6 + 30×0.5) ÷ 50 — the estate-WEIGHTED peer rate.
    expect(rollup.expectation.conversionGapUsd).toBe(64.8);
    // ⚠ THE UNWEIGHTED ANSWER, NAMED, because this fixture is where the two diverge most visibly:
    // a plain mean of the two medians is 0.55 and would print 66.00, letting a repository with 20
    // threads move the expectation as far as one with 30. This test caught exactly that slip while
    // it was being written.
    expect(rollup.expectation.conversionGapUsd).not.toBe(66);
    expectAllFinite(rollup);
  });
});

describe('THE REFUSAL VOCABULARIES — eleven money reasons, five comparison reasons', () => {
  it('gives the ELEVEN cost reasons eleven DIFFERENT sentences, each over forty characters', () => {
    // ⚠ THIS IS TWO ASSERTIONS AND THEY ARE DIFFERENT JOBS, so neither is a literal-vs-literal
    // tautology. First the VOCABULARY: the `Record` type forces all eleven keys to exist, and this
    // demands eleven pairwise-distinct sentences of real length — collapsing two of them is precisely
    // the defect the vocabulary exists to prevent, and "recorded as free" versus "we could not
    // multiply your per-seat price out" are one keystroke apart in the code and opposite claims on
    // the screen. Then REACHABILITY: the eight the rollup can actually produce are collected from
    // real builds and each is matched against the constant, so a hand-written sentence at a refusal
    // site would fail rather than quietly diverge from its twin one grain down.
    const messages = Object.values(COST_REFUSAL_MESSAGE);
    expect(messages).toHaveLength(11);
    expect(new Set(messages).size).toBe(11);
    for (const m of messages) expect(m.length).toBeGreaterThan(40);

    const seen = new Map<string, string>();
    const collect = (arm: unknown): void => {
      // ⚠ `moneyRefusal` IS LEGITIMATELY `null` — both figures present, or no `cost` block at all —
      // so the collector must tolerate it rather than the sweep throwing on the first healthy card.
      if (arm == null || typeof arm !== 'object') return;
      const a = arm as { status: string; reason?: string; message?: string };
      if (a.status !== 'refused' || a.reason == null || a.message == null) return;
      seen.set(a.reason, a.message);
    };
    for (const rollup of [
      build(HOUSE(), { truncated: true }),
      build(HOUSE(), { price: flat(0) }),
      build(HOUSE(), { price: unstatable() }),
      build([facts({ mergedPrsLast14d: 0 })]),
      build([facts({ placement: unplaced('repo_window_incomplete') })]),
      build([facts()]),
      build([busy({ repoHeldDays: 3 })]),
      build([facts({ settled: 0, acted: 0 })]),
      build([busy({ acted: 0, actedInWindow: 0, actedOnRateMetric: compared(0, 0.6, 5) })]),
    ]) {
      if (rollup.cost == null) continue;
      collect(rollup.cost.perMergedPr);
      collect(rollup.cost.unacted);
      collect(rollup.cost.yours);
      if (rollup.expectation.status === 'value') collect(rollup.expectation.moneyRefusal);
    }
    // ⚠ EIGHT OF ELEVEN, AND THE SHORTFALL IS RECORDED HONESTLY RATHER THAN ROUNDED UP.
    // `span_unobserved` joined the two cohort reasons as unreachable here when the money moved to a
    // chosen calendar month: no figure on this card divides by an observed span any more, so the
    // rollup cannot state that refusal at all. It stays in the shared vocabulary because
    // `buildUnitCost` — the pinned per-repository specification — still reaches it, and
    // `benchmark-cost.test.ts` still sweeps it there. `cohort_rate_unfitted`
    // and `cohort_rate_zero` are UNREACHABLE from this grain by construction: a cohort that
    // published no median, or a median of zero, removes that repository from the fitted subset
    // entirely, and an estate with none left refuses in the ROLLUP vocabulary
    // (`no_fitted_cohort_rate`) rather than the money one. They are covered by
    // `benchmark-cost.test.ts`, where they are reachable.
    expect([...seen.keys()].sort()).toEqual([
      'no_merges_in_window',
      'nothing_acted_on',
      'own_rate_withheld',
      'price_is_zero',
      'price_unresolved',
      'repo_window_incomplete',
      'window_underpopulated',
      'workspace_truncated',
    ]);
    for (const [reason, message] of seen) {
      expect(message, reason).toBe(COST_REFUSAL_MESSAGE[reason as keyof typeof COST_REFUSAL_MESSAGE]);
    }
  });

  it('gives the FIVE rollup reasons five DIFFERENT sentences, and reaches every one of them', () => {
    const messages = Object.values(ROLLUP_REFUSAL_MESSAGE);
    expect(messages).toHaveLength(5);
    expect(new Set(messages).size).toBe(5);
    for (const m of messages) expect(m.length).toBeGreaterThan(40);
    // ⚠ AND THEY DO NOT OVERLAP THE MONEY VOCABULARY. These withhold a COMPARISON no price can buy;
    // those withhold a FIGURE every one of whose remedies involves a price. A sentence appearing in
    // both would mean one of the two grains is describing the wrong kind of absence.
    expect(new Set([...messages, ...Object.values(COST_REFUSAL_MESSAGE)]).size).toBe(16);

    const seen = new Map<string, string>();
    const collect = (section: { status: string; reason?: string; message?: string }): void => {
      if (section.status !== 'refused' || section.reason == null || section.message == null) return;
      seen.set(section.reason, section.message);
    };
    for (const rollup of [
      // single_repo — one placed, comparable repository beside one that is neither.
      build([facts({ repoId: 1 }), facts({ repoId: 2, actedOnRateMetric: uncompared(0.2) })]),
      // no_placed_repos + no_fitted_cohort_rate — placed nowhere, fitted nowhere.
      build([
        facts({ repoId: 1, placement: unplaced('repo_window_incomplete'), actedOnRateMetric: uncompared(0.2) }),
        facts({ repoId: 2, placement: unplaced('repo_inactive_in_window'), actedOnRateMetric: uncompared(0.3) }),
      ]),
      // no_settled_threads — fitted cells, nothing settled in any of them.
      build([facts({ settled: 0, acted: 0 }), facts({ repoId: 2, settled: 0, acted: 0 })]),
      // vendor_not_in_corpus — a brand the corpus walk has never seen.
      build(HOUSE(), { vendor: null }),
    ]) {
      collect(rollup.spread);
      collect(rollup.expectation);
    }
    expect([...seen.keys()].sort()).toEqual([
      'no_fitted_cohort_rate',
      'no_placed_repos',
      'no_settled_threads',
      'single_repo',
      'vendor_not_in_corpus',
    ]);
    for (const [reason, message] of seen) {
      expect(message, reason).toBe(
        ROLLUP_REFUSAL_MESSAGE[reason as keyof typeof ROLLUP_REFUSAL_MESSAGE],
      );
    }
  });

  it('serves ONE sentence naming the two numbers the figure divides, and prints both', () => {
    // ⚠ THE BASIS IS THE FIX, NOT A CAVEAT ABOUT IT. Its predecessor was 106 words explaining an
    // observed span that nothing divides by any more — a false account of how the number was made,
    // in the voice of a disclosure. What ships is the division itself.
    const rollup = build([busy({ repoId: 1 }), busy({ repoId: 2 })]);
    const note = rollup.cost?.basisNote ?? '';
    if (rollup.cost?.yours.status !== 'value') throw new Error('unreachable');
    expect(note).toBe(
      rollupBasisNote({ monthlyUsd: 120, actedInWindow: 40, coveredRepos: 2 }),
    );
    // ⚠ BOTH HALVES ARE IN THE SENTENCE, SPELLED THE WAY THE ROWS SPELL THEM — a reader is being
    // invited to divide one by the other and land on the figure above.
    expect(note).toContain('US$120.00 a month');
    expect(note).toContain('40 comments your team used in the last 30 days');
    expect(note).toContain('Both halves cover the same month');
    // …and the multi-repository clause is there when, and only when, pooling actually happened.
    expect(note).toContain('summed across the 2 repositories');
    expect(rollupBasisNote({ monthlyUsd: 120, actedInWindow: 40, coveredRepos: 1 })).not.toContain(
      'summed across',
    );
    // ⚠ AND IT NEVER RESTATES A WITHHELD FIGURE. When the money refused there is no division to
    // describe, so the sentence names the basis without inventing two numbers to divide.
    const thin = build([facts()]);
    expect(thin.cost!.yours.status).toBe('refused');
    expect(thin.cost!.basisNote).not.toMatch(/US\$/);
    expect(thin.cost!.basisNote).toContain('Both halves cover the same month');
    // …and no clause of the caveat it replaced survives anywhere on the card.
    for (const pattern of [/NOT joined/, /borrowing/, /prorated/i, /January/]) {
      expect(note).not.toMatch(pattern);
    }
  });

  it('serves the window itself, so no renderer has to inline a number the server owns', () => {
    // ⚠ A HARD-CODED "30" IN THE PANEL WOULD GO ON PRINTING 30 the day the constant moves, on the
    // one card whose entire claim is that a price and a thread count cover the SAME month.
    expect(build([busy()]).cost?.costWindowDays).toBe(COST_WINDOW_DAYS);
    expect(build([busy()]).cost?.costWindowIncompleteRepos).toBe(0);
    // ⚠ AND IT IS NOT `windowDays`. Two windows live on this block — the cohort's fourteen-day
    // banding window (`perMergedPr`'s basis alone) and the cost month — and reading either for the
    // other's figure is a fortnight's price over a month's work, or the reverse.
    expect(build([busy()]).cost?.windowDays).toBe(WINDOW_DAYS);
    expect(build([busy()]).cost?.windowDays).not.toBe(COST_WINDOW_DAYS);
  });
});

describe('no shape of estate puts a non-finite or unbounded number on the wire', () => {
  it('sweeps every divisor this fold can hit and demands finite, bounded money or a refusal', () => {
    // ⚠ THE FOUR NEW DIVISORS THIS GRAIN INTRODUCES, each driven through its zero: the summed merge
    // count, the summed per-repository pace, the summed peer pace, and the pooled settled count. One
    // fixture only ever reaches one of them, which is why this is a sweep and not an assertion on
    // the house estate.
    //
    // ⚠ AND IT ASSERTS NOTHING ABOUT WHICH ARM REFUSES, deliberately. The sibling tests pin that; if
    // this one also pinned it, a relaxed guard would be killed by the status assertion and these
    // lines would be along for the ride, unable to fail on their own.
    //
    // MUTATION-TESTED IN ISOLATION, honestly:
    //   KILLED — `buildRollupCost`'s `mergedPrs <= 0` gate (Infinity in `perMergedPr.value`), its
    //     `pooledSettled > 0` gate (NaN in `actedOnRate`), `buildYours`' `actedPerMonth > 0` gate
    //     (Infinity in `perActedOnUsd`), and `buildExpectation`'s `actedPerMonthAtPeer > 0` gate
    //     (Infinity in the expectation's `perActedOnUsd`). Each is a real, reachable estate.
    //   SURVIVES — `spannedRepos === 0` in `unacted`, because its arithmetic no longer divides by a
    //     span at all: it is a WARRANT gate rather than a divide-by-zero one, and the sibling test
    //     "refuses the reviewer-side figures when NO repository had an observable span" is what
    //     kills it. Recorded rather than hidden; a surviving guard with a stated reason is not the
    //     same thing as an untested one.
    const spans: Array<number | null> = [null, 0.000001, 30, 60];
    const threadShapes = [
      { settled: 0, acted: 0 },
      { settled: 20, acted: 0 },
      { settled: 20, acted: 20 },
      { settled: 20, acted: 4 },
    ];
    const metricShapes: Array<BotBenchmarkPlacementMetric | undefined> = [
      compared(0.2, 0.6, 30),
      compared(0.2, 0, 30), // a cohort median of zero
      uncompared(0.2),
      excluded('below_min_units'),
      undefined,
    ];
    const estates: RollupRepoFacts[][] = [];
    for (const span of spans) {
      for (const threads of threadShapes) {
        for (const metric of metricShapes) {
          for (const merged of [0, 10]) {
            for (const placement of [placedIn(6), unplaced('repo_window_incomplete')]) {
              const one = facts({
                repoId: 1,
                mergedPrsLast14d: merged,
                placement,
                spanDays: span,
                settled: threads.settled,
                acted: threads.acted,
                actedOnRateMetric: metric,
              });
              estates.push([one]);
              // …and the same shape beside an ordinary repository, so every sum has a second term.
              estates.push([one, facts({ repoId: 2, spanDays: 30, settled: 30, acted: 9 })]);
            }
          }
        }
      }
    }
    // ⚠ THE SHAPE COUNT IS ASSERTED so a loop that silently stops generating is caught. 4 spans ×
    // 4 thread shapes × 5 metrics × 2 merge counts × 2 placements × 2 estate sizes.
    expect(estates.length).toBe(640);

    let moneyChecked = 0;
    for (const price of [flat(0), flat(0.01), flat(120), flat(9_999_999), unstatable(), null]) {
      for (const truncated of [false, true]) {
        for (const estate of estates) {
          const rollup = build(estate, { price, truncated });
          expectAllFinite(rollup);
          const monthly = rollup.cost?.monthlyUsd ?? null;
          if (monthly == null) continue;
          // ⚠ BOTH MONEY FIGURES ARE `monthlyUsd` TIMES A QUANTITY IN [−1, 1] — a rate, and a
          // difference of two rates — so neither can exceed the monthly price, STRUCTURALLY rather
          // than by a clamp. The ratio form this replaced rendered −4.1 × the spend AS MONEY.
          for (const v of collectValues(rollup, 'unactedUsd')) {
            expect(typeof v).toBe('number');
            expect(Math.abs(v as number)).toBeLessThanOrEqual(monthly);
            expect(v as number).toBeGreaterThanOrEqual(0);
            moneyChecked += 1;
          }
          for (const v of collectValues(rollup, 'conversionGapUsd')) {
            if (v == null) continue;
            expect(Math.abs(v as number)).toBeLessThanOrEqual(monthly);
            moneyChecked += 1;
          }
        }
      }
    }
    // ⚠ THE BOUNDS LOOP MUST ACTUALLY HAVE RUN. A sweep whose inner assertion never executes is one
    // of the four artifacts this feature's plan doc names as looking like verification.
    expect(moneyChecked).toBeGreaterThan(1000);
  });

  it('bounds the gap at the extreme the ratio form got wrong: every thread acted on', () => {
    // ⚠ THE SHIPPED DEFECT, AT ESTATE GRAIN. `× (1 − yours ÷ cohort)` is bounded in [0,1] only while
    // the customer sits at or below the cohort median, and the corpus holds real fitted medians as
    // low as 0.242857 — so an estate acting on everything produced −4.1 × the spend as money.
    const rollup = build([
      facts({ repoId: 1, settled: 20, acted: 20, actedOnRateMetric: compared(1, 0.242857, 99) }),
      facts({ repoId: 2, settled: 30, acted: 30, spanDays: 30, actedOnRateMetric: compared(1, 0.242857, 98) }),
    ]);
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.yoursRateOnFitted).toBe(1);
    expect(rollup.expectation.expectedRate).toBe(0.242857);
    expect(rollup.expectation.conversionGapUsd).toBe(-90.85716); // 120 × (0.242857 − 1)
    expect(Math.abs(rollup.expectation.conversionGapUsd ?? 0)).toBeLessThanOrEqual(120);
    // …and nothing is unacted at a rate of 1, which the ratio version could not express either.
    if (rollup.cost?.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.unacted.unactedUsd).toBe(0);
  });
});

describe('the card’s identity and its constants', () => {
  it('keys on the WORKSPACE vendor key, so unbranded reviewers do not collapse onto one card', () => {
    // ⚠ THE PER-REPOSITORY CARD'S REACT KEY IS `repoId:vendor`, which a rollup has n repositories
    // for; and `vendor` is `null` for most reviewers a real workspace runs, so n unbranded vendors
    // would collapse onto one `null` card. The workspace's own automation key is the identity.
    const sonar = build(HOUSE(), { key: 'sonarqube', vendor: null });
    const ghas = build(HOUSE(), { key: 'github-advanced-security', vendor: null });
    expect(sonar.key).not.toBe(ghas.key);
    expect(sonar.vendor).toBe(ghas.vendor); // …both null, which is why it cannot be the key
    // The reviewers ride as an ARRAY: two logins the workspace calls one vendor are ONE card.
    const two = build(HOUSE(), {
      reviewers: [
        { userId: 1, login: 'coderabbitai[bot]', label: 'CodeRabbit' },
        { userId: 2, login: 'coderabbit-staging[bot]', label: null },
      ],
    });
    expect(two.reviewers).toHaveLength(2);
  });

  it('states the estate’s size on the card, both halves', () => {
    const rollup = build([...HOUSE(), silent({ repoId: 3 })], { reposConsidered: 11 });
    expect(rollup.liveInRepos).toBe(2);
    // ⚠ `reposConsidered` IS WHAT THE REQUEST FOLDED, not what the vendor touched — "live in 2 of
    // 11" is a sentence rather than an inference, and it is the SAME number on every card in a
    // response so two cards cannot disagree about how big the Workspace is.
    expect(rollup.reposConsidered).toBe(11);
    expect(rollup.cost!.windowDays).toBe(WINDOW_DAYS);
    expect(DAYS_PER_MONTH).toBe(30.44);
  });
});

describe('A COHORT MEDIAN OF ZERO IS NO MEDIAN — the gate `cost.ts` already applies, one grain up', () => {
  // ⚠ THIS IS NOT A HYPOTHETICAL EDGE CASE. In the SHIPPED corpus (`data/benchmark/benchmark-fit.json`,
  // fit v2) all THREE of `qodo`'s activity bands publish an `acted_on_rate` p50 of exactly 0 — there
  // is no Qodo band with a usable median at all — so every Qodo repository in every Workspace lands
  // here. `benchmark-artifact.test.ts` guards the artifact; this guards what the fold does with it.
  //
  // ⚠ AND THE TWO GRAINS MUST AGREE ABOUT WHETHER A NUMBER EXISTS. `cost.ts`'s `cohortActedOnRate`
  // refuses `cohort_rate_zero` on `p50 <= 0` ("nobody acts on this reviewer anywhere in this band").
  // The rollup once accepted the same cell as a median OF zero, so the repository card said "no
  // comparison" while the estate card asserted a peer expectation — over the same reviewer, on two
  // tabs, from one corpus cell.
  const zeroMedian = (percentile = 30) => compared(0.2, 0, percentile);

  it('EXCLUDES a zero-median cell from the fitted subset rather than diluting the expectation', () => {
    // One usable cohort (60 %) and one degenerate one. The excluded repository's own COUNTS still
    // pool into the headline — rule 3 — it is only the COMPARISON it may not join.
    const rollup = build([
      facts({ repoId: 1, actedOnRateMetric: compared(0.2, 0.6, 30), settled: 20, acted: 4 }),
      facts({ repoId: 2, actedOnRateMetric: zeroMedian(), settled: 20, acted: 4 }),
    ]);
    if (rollup.expectation.status !== 'value') throw new Error('unreachable');
    expect(rollup.expectation.fittedRepos).toBe(1);
    expect(rollup.expectation.excludedRepos).toBe(1);
    // ⚠ THE WRONG ANSWER, NAMED: admitting the degenerate cell halves the peer expectation to 0.3
    // and reports a conversion gap of US$12 where the honest figure is US$48 — understated
    // FOURFOLD, and in the direction that flatters the customer.
    expect(rollup.expectation.expectedRate).toBe(0.6);
    expect(rollup.expectation.expectedRate).not.toBe(0.3);
    expect(rollup.expectation.conversionGapUsd).toBe(48);
    expect(rollup.expectation.conversionGapUsd).not.toBe(12);
    // The pooled headline is untouched: both repositories' threads still count.
    if (rollup.cost?.unacted.status !== 'value') throw new Error('unreachable');
    expect(rollup.cost.unacted.settledThreads).toBe(40);
    expect(rollup.cost.coveredRepos).toBe(2);
  });

  it('refuses the whole comparison — in the COMPARISON vocabulary — when every cell is degenerate', () => {
    // The all-Qodo estate. ⚠ THE REGRESSION THIS KILLS IS A FALSE SENTENCE, not a wrong digit:
    // admitting the cells drove `actedPerMonthAtPeer` to zero, which the span guard then reported as
    // `span_unobserved` — "this reviewer left no measurable stretch of time on the pull requests
    // read here" — about repositories whose spans were observed perfectly well (60 days each here).
    const rollup = build([
      facts({ repoId: 1, actedOnRateMetric: zeroMedian(), spanDays: 60 }),
      facts({ repoId: 2, actedOnRateMetric: zeroMedian(40), spanDays: 60 }),
    ]);
    expect(rollup.expectation.status).toBe('refused');
    if (rollup.expectation.status !== 'refused') throw new Error('unreachable');
    expect(rollup.expectation.reason).toBe('no_fitted_cohort_rate');
    expect(rollup.expectation.reason).not.toBe('span_unobserved');
    expect(rollup.expectation.message).toBe(ROLLUP_REFUSAL_MESSAGE.no_fitted_cohort_rate);
    // ⚠ THE SENTENCE MUST NAME THE ZERO CAUSE. "We have no figure" is false of a cell that
    // published one and it happened to be zero, and a reader who checks would find the number. The
    // wording is now plain English ("the ones we have act on none of it") rather than the literal
    // word "zero", so this pins the CAUSE being named — both causes, distinguishably — not a token.
    expect(rollup.expectation.message).toMatch(/act on none of it/i);
    expect(rollup.expectation.message).toMatch(/too few teams/i);
    // Everything that owes the corpus nothing still renders.
    expect(rollup.liveInRepos).toBe(2);
    expect(rollup.cost?.perMergedPr.status).toBe('value');
    expect(rollup.contributions).toHaveLength(2);
  });

  it('keeps a zero-median repository in the SPREAD, which is a rank and not a rate', () => {
    // ⚠ THE TWO SECTIONS HAVE DIFFERENT POPULATIONS ON PURPOSE. A percentile is this repository's
    // rank inside its own band and stays true however degenerate the band's median is; only the
    // COUNTERFACTUAL needs a rate to put in place of yours. Collapsing both onto one gate would
    // delete a real placement to protect an unrelated figure.
    const rollup = build([
      facts({ repoId: 1, actedOnRateMetric: zeroMedian(80) }),
      facts({ repoId: 2, actedOnRateMetric: zeroMedian(20) }),
    ]);
    expect(rollup.spread).toEqual({ status: 'value', placed: 2, below: 1, at: 0, above: 1 });
    expect(rollup.expectation.status).toBe('refused');
  });
});
