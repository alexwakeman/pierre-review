// Bots → Benchmark: the peer-cohort placement panel.
//
// WHAT THIS PINS, and why each half is worth a test rather than a comment:
//
//   1. THE GATE, IN BOTH DIRECTIONS. `botDepth` decides what is SEEN (`benchmarkBodyFor`) and,
//      separately, what is ASKED FOR (`useBotBenchmarkPlacement`'s own `enabled`). A client gate is
//      not a monetisation gate — the route 402s — and an unentitled pane that kept polling would
//      hammer a 402 on its own cadence. The two are one decision written twice and they must not
//      drift.
//
//   2. THE DERIVED-TAB RULE. `botsInnerTab` is ONE scalar shared by the cross-repo rail and the
//      per-repo console, so the visible tab is DERIVED per render and never written back. A
//      corrective `setBotsInnerTab()` permanently forgets the reader's choice — and correcting
//      `'benchmark'` away for an unentitled reader would land a bookmarked `?botsTab=benchmark`
//      somewhere else with nothing on screen explaining why.
//
//   3. EVERY REFUSAL IS ITS OWN SENTENCE — FOURTEEN OF THEM. "We have never measured this bot"
//      (DeepSource is real), "we have too little of it", "this is not a product", "this stratum is
//      empty", "your repository is too new", "this build ships no corpus" and the six per-metric
//      exclusions are all different facts with different remedies. A renderer that collapses two of
//      them tells a customer their biggest reviewer scored zero. The distinctness is asserted
//      pairwise, and every union member is asserted to HAVE a sentence, so a new member added to
//      the wire fails here rather than rendering `undefined` on screen.
//
//      ⚠ The fourteenth was found by RUNNING the panel: a reviewer can be PLACED and still have
//      every metric withheld, and "nothing stands out" over zero comparisons is a clean bill of
//      health issued after measuring nothing.
//
//   4. THE BAND COUNT AND THE COHORT n RIDE EVERY PERCENTILE. "Upper fifth of Greptile
//      repositories" is honest at 5 bands and a misrepresentation at 10, and the seven fitted
//      vendors carry 10/10/9/7/4/3/2 bands.
//
//   5. THE STRIP REFUSES TO DRAW A PARTIAL DISTRIBUTION, and always contains the customer's own
//      value — a dot clipped off the axis reads as "nothing there".
//
//   6. THE GRAIN SPLIT, AND THE FACT THAT MONEY LIVES ON EXACTLY ONE SIDE OF IT. One route serves
//      two screens: the cross-repo Bots RAIL (`repoId == null`) draws one ROLLUP CARD PER VENDOR
//      over the whole Workspace, and a repository's own Bots tab draws that repository's
//      placements. A price is bought per WORKSPACE, so a whole subscription measured against ONE
//      repository's work is an upper bound that several cards carried at once and that nothing
//      could legitimately add up. The grain moved rather than the caveat getting louder: every
//      money figure is now a rollup figure, `BotBenchmarkPlacementUnit.cost` is gone from the wire,
//      and the server sends no money at all on a repo-narrowed request. §12 pins that on the render
//      side — the per-unit `CostBlock` is DELETED, and no `formatUsd` call is reachable from the
//      per-repository branch.
//
//   7. THE TWO RATES ON A ROLLUP CARD ARE OVER TWO POPULATIONS AND MUST NEVER SHARE A ROW.
//      `cost.unacted.actedOnRate` is pooled over every live repository; `expectation
//      .yoursRateOnFitted` is over the subset whose cohort published a median. They routinely
//      differ by several points. This is the defect docs/PERIOD-REPORTING.md names "ONE ROW MUST
//      NEVER MIX THE HEADLINE AND SUBSET POPULATIONS", shipped three times in that feature before
//      it was believed; §10 asserts each sentence names its own denominator and carries neither of
//      the other's figures.
//
// ⚠ SEVERAL OF THESE ARE SOURCE GUARDS, AND THAT IS A HARNESS LIMIT, NOT A PREFERENCE. This suite
// runs under `vitest --root apps/frontend` with NO DOM (`vitest.config.ts` includes
// `test/**/*.test.ts` only, the React plugin is not applied, and neither jsdom nor a React renderer
// is installed anywhere in the monorepo). A hook's `enabled` cannot be observed without mounting it,
// so the one thing that stops an unentitled SPA polling a 402 is asserted against the module's
// source. Every guard here was mutation-tested: deleting the `enabled` line, swapping the lock's
// testid, re-adding a per-unit cost block and relaxing `showCost` back to `botDepth` each turn this
// file red.
//
// ⚠ A SOURCE GUARD MUST PIN A CLAIM, NOT A COINCIDENCE. Each one below is anchored on the thing
// that would be WRONG if it changed — a presence check, a testid whose claim changed grain, a basis
// chip on the one row that is fitted rather than counted — and never on formatting that a
// reformatter could move without making the screen say anything different.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  BotBenchmarkCostRefusalReason,
  BotBenchmarkPlacementCost,
  BotBenchmarkPlacementMetric,
  BotBenchmarkPlacementRefusalReason,
  BotBenchmarkPlacementUnit,
  BotBenchmarkRollupContribution,
  BotBenchmarkRollupExpectation,
  BotBenchmarkRollupRefusalReason,
  BotBenchmarkRollupSpread,
  BotBenchmarkUnavailableReason,
  BotBenchmarkUnitExclusionReason,
  BotBenchmarkWorkspaceCost,
  BotBenchmarkWorkspaceRollup,
} from '@pierre-review/shared';
import {
  ANOMALY_HEADLINE,
  ANOMALY_KIND_ORDER,
  COST_BASIS_LABEL,
  COST_REFUSAL_HEADLINE,
  DERIVATION_LABEL,
  EXCLUSION_HEADLINE,
  FINDINGS_EMPTY_HEADLINE,
  PLACEMENT_REFUSAL_HEADLINE,
  ROLLUP_REFUSAL_HEADLINE,
  UNAVAILABLE_HEADLINE,
  absentMetricRows,
  anomalyRows,
  bandFitNote,
  benchmarkBodyFor,
  collapsedCostRefusal,
  collapsedExclusion,
  collapsedWorkspaceCostRefusal,
  contributionRows,
  costHeadline,
  costPriceLine,
  costPricedReviewersNote,
  costSeatUnresolvedNote,
  costSeatZeroNote,
  costSharedNote,
  costWindowLabel,
  effectiveBotsTab,
  findingsEmptyState,
  formatMetricValue,
  formatSpanDays,
  formatThreadCount,
  formatUsd,
  metricRows,
  orderedRollups,
  orderedUnits,
  percentileSentence,
  placementTally,
  reviewerLabel,
  rollupCoverageLabel,
  rollupExpectationSentence,
  rollupRows,
  rollupSpreadSentence,
  sharedComparisonRefusal,
  rollupTitle,
  stripGeometry,
  workspaceCostActedOnDetail,
  workspaceCostActedOnLabel,
  workspaceCostCoverageNote,
  workspaceCostHeadline,
  workspaceCostPartialWindowNote,
  workspaceCostPriceLine,
  workspaceCostSpanUnobservedNote,
  workspaceCostWindowIncompleteNote,
} from '../src/components/Activity/benchmarkModel.js';
import { botBenchmarkPlacementQueryKey } from '../src/hooks/useBotBenchmark.js';
import { BOTS_INNER_TABS } from '../src/store/filters.js';

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Fixtures — shaped exactly like the wire, including its discriminated unions
   ───────────────────────────────────────────────────────────────────────────────────────── */

function compared(
  value: number,
  percentile: number,
  over: Partial<BotBenchmarkPlacementMetric & { status: 'compared' }> = {},
): BotBenchmarkPlacementMetric {
  return {
    status: 'compared',
    value,
    units: 34,
    percentile,
    cohort: {
      nRepos: 41,
      quantiles: { p10: 0.2, p25: 0.3, p50: 0.4, p75: 0.55, p90: 0.7 },
      ciMedian95: [0.35, 0.46],
      direction: 'higher_is_better',
      minUnits: 5,
      unit: 'rate',
    },
    ...over,
  } as BotBenchmarkPlacementMetric;
}

function unit(over: Partial<BotBenchmarkPlacementUnit> = {}): BotBenchmarkPlacementUnit {
  return {
    repoId: 1,
    repoOwner: 'acme',
    repoName: 'api',
    reviewers: [{ userId: 9, login: 'coderabbitai[bot]', label: 'CodeRabbit' }],
    vendor: 'coderabbit',
    botKind: 'coderabbit',
    activity: { mergedPrsLast14d: 22, walkBudget: 141, prsConsidered: 141, repoHeldDays: 90 },
    placement: {
      status: 'placed',
      activityBand: 5,
      nBands: 10,
      bandLabel: '6 of 10',
      bandRange: [18, 26],
      cohortRepos: 37,
      aboveTopBandBy: null,
    },
    counters: { volume: {}, outcome: {}, overdueEligible: {}, overdueUntouched: {}, repository: {} },
    metrics: { acted_on_rate: compared(0.31, 8) },
    anomalies: [],
    ...over,
  };
}

/** Read a component's source. ⚠ EVERY SOURCE GUARD IN THIS FILE GOES THROUGH ONE OF THESE, so a
 *  renamed or moved file fails ONCE, loudly, rather than silently passing a `not.toContain` in
 *  eleven places against an empty string. */
function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');
}
const panelSource = (): string => sourceOf('components/Activity/BenchmarkPanel.tsx');

/* ── The Workspace rollup: one card per vendor, over the whole estate ──────────────────────────

   ⚠ THE HOUSE ESTATE IS DELIBERATELY LOPSIDED, and every number below is chosen so the two
   populations DISAGREE. The vendor is live in 4 of 8 repositories; it settled 100 threads of which
   26 were acted on, so the POOLED rate is 26%. Only 3 of those 4 repositories carry a fitted cohort
   median, and over that subset the customer acts on 41% against a peer expectation of 58%. 26 ≠ 41
   is the whole point: a test whose two populations happen to agree cannot catch a renderer that
   quotes one where it means the other, which is precisely the defect this shape exists to keep out.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

function workspaceCost(over: Partial<BotBenchmarkWorkspaceCost> = {}): BotBenchmarkWorkspaceCost {
  return {
    monthlyUsd: 120,
    costModel: 'flat',
    unitMonthlyUsd: null,
    seats: null,
    pricedReviewers: 1,
    seatPriceUnresolved: 0,
    seatCountZero: 0,
    windowDays: 14,
    windowUsd: 55.190539,
    coveredRepos: 4,
    spanUnobservedRepos: 0,
    partialWindowRepos: 0,
    perMergedPr: { status: 'value', value: 0.919842, mergedPrs: 60 },
    unacted: {
      status: 'value',
      // ⚠ THE POOLED RATE, over all four live repositories.
      actedOnRate: 0.26,
      actedThreads: 26,
      settledThreads: 100,
      unactedUsd: 88.8, // 120 × 0.74, a month
    },
    // ⚠ THE COST WINDOW, SERVED. Two windows live on this block and neither may be read for the
    // other's figure: `windowDays` is the cohort's fortnight (`perMergedPr`'s basis alone).
    costWindowDays: 30.44,
    costWindowIncompleteRepos: 0,
    yours: {
      status: 'value',
      // ⚠ THE WINDOW'S OWN PAIR — a SUBSET of `unacted`'s slice-wide 26 of 100, and different
      // numbers under the same field names, which is why every sentence names its population.
      actedThreads: 20,
      settledThreads: 80,
      actedOnRate: 0.25,
      // ⚠ THE WINDOW IS A CALENDAR MONTH, so a count inside it already IS a monthly pace.
      actedPerMonth: 20,
      perActedOnUsd: 6, // 120 ÷ 20, a division the card prints both halves of
    },
    basisNote:
      'US$120.00 a month divided by the 20 threads acted on in the last 30 days, summed across ' +
      'the 4 repositories this reviewer is live in. Both halves cover the same month.',
    ...over,
  };
}

function expectation(
  over: Partial<Extract<BotBenchmarkRollupExpectation, { status: 'value' }>> = {},
): BotBenchmarkRollupExpectation {
  return {
    status: 'value',
    // ⚠ THE FITTED-SUBSET RATE, and NOT 0.26. See the section header.
    yoursRateOnFitted: 0.41,
    expectedRate: 0.58,
    fittedRepos: 3,
    excludedRepos: 1,
    actedAtPeer: 43.5,
    actedPerMonthAtPeer: 6.9,
    perActedOnUsd: 17.391304, // 120 ÷ 6.9
    conversionGapUsd: 20.4, // 120 × (0.58 − 0.41), a month
    moneyRefusal: null,
    ...over,
  };
}

function spread(
  over: Partial<Extract<BotBenchmarkRollupSpread, { status: 'value' }>> = {},
): BotBenchmarkRollupSpread {
  return { status: 'value', placed: 3, below: 2, at: 0, above: 1, ...over };
}

function contribution(
  over: Partial<BotBenchmarkRollupContribution> = {},
): BotBenchmarkRollupContribution {
  return {
    repoId: 1,
    repoOwner: 'acme',
    repoName: 'api',
    mergedPrsLast14d: 22,
    band: { activityBand: 5, nBands: 10, bandLabel: '6 of 10' },
    placementRefusal: null,
    actedOnRate: 0.31,
    percentile: 8,
    settledThreads: 40,
    actedThreads: 12,
    spanDays: 60,
    ...over,
  };
}

function rollup(over: Partial<BotBenchmarkWorkspaceRollup> = {}): BotBenchmarkWorkspaceRollup {
  return {
    key: 'coderabbit',
    vendor: 'coderabbit',
    botKind: 'coderabbit',
    reviewers: [{ userId: 9, login: 'coderabbitai[bot]', label: 'CodeRabbit' }],
    liveInRepos: 4,
    reposConsidered: 8,
    counters: { volume: {}, outcome: {}, overdueEligible: {}, overdueUntouched: {}, repository: {} },
    contributions: [contribution()],
    spread: spread(),
    expectation: expectation(),
    cost: workspaceCost(),
    ...over,
  };
}

const rollupRefused = (reason: BotBenchmarkRollupRefusalReason) =>
  ({ status: 'refused', reason, message: 'because.' }) as const;

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   1. The gate, in both directions
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('the botDepth gate', () => {
  it('shows the panel only when entitled, and NOTHING while /api/me is unresolved', () => {
    expect(benchmarkBodyFor('entitled')).toBe('panel');
    expect(benchmarkBodyFor('locked')).toBe('locked');
    // ⚠ The blank beat is the point: `useProCapabilities()` is all-false until /api/me lands, so a
    // two-way branch paints "See what Pro includes" for one frame AT AN ACCOUNT THAT PAYS.
    expect(benchmarkBodyFor('pending')).toBe('blank');
    // …and it is never the panel, which would be the mirror-image lie — showing a reader data we
    // are about to tell them they cannot see.
    expect(benchmarkBodyFor('pending')).not.toBe('panel');
  });

  // ⚠ SOURCE GUARD — see the file header. There is no renderer in this suite, and this line is the
  // only thing between an unentitled mount and a 402 on a timer.
  it('ANDs the capability into the placement query’s own enabled', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/hooks/useBotBenchmark.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/enabled:\s*botDepth\s*,/);
    // The click-gated definitions read is gated on the capability AND on being opened — it must
    // not fetch 16 KB of prose on mount.
    expect(src).toMatch(/enabled:\s*botDepth\s*&&\s*open\s*,/);
  });

  // ⚠ SOURCE GUARD — the locked body must not answer to the entitled body's test id, or a
  // misconfigured screenshot run photographs the lock and ships it as a marketing shot.
  it('gives the locked pane a testid distinct from the entitled panel’s', () => {
    const view = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/BotsView.tsx', import.meta.url)),
      'utf8',
    );
    const panel = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/BenchmarkPanel.tsx', import.meta.url)),
      'utf8',
    );
    expect(view).toContain('testId="benchmark-locked"');
    expect(panel).toContain('data-testid="benchmark-panel"');
    expect(view).not.toContain('testId="benchmark-panel"');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   2. The derived-tab rule
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('the visible Bots sub-tab is DERIVED, never written back', () => {
  it('keeps `benchmark` selected on every tier — it is visible-but-locked, not absent', () => {
    // A capability is not even an input here. That is the assertion: the body locks, the TAB never
    // moves, so a bookmarked `?botsTab=benchmark` lands where it says it will.
    expect(effectiveBotsTab('benchmark', { showAdvisor: false })).toBe('benchmark');
    expect(effectiveBotsTab('benchmark', { showAdvisor: true })).toBe('benchmark');
  });

  // ⚠ AND THE MOUNT IS NOT AN INPUT EITHER — which matters MORE since the grain split, not less.
  // `benchmark` now renders on BOTH mounts with DIFFERENT BODIES: the rail draws per-vendor rollups
  // and a repository's Bots tab draws that repository's placements. That is exactly the shape that
  // invites a "this mount has nothing to show, send them to `roi`" correction — and a correction is
  // a `setBotsInnerTab()`, which permanently forgets the reader's choice for the OTHER mount. The
  // rule is that WHICH BODY IS DRAWN is decided inside the pane, and the TAB never moves.
  it('takes no repoId, and cannot be made to degrade `benchmark` on the per-repo mount', () => {
    // Behavioural: an opts object that smuggles a mount in changes nothing, on either mount.
    const withRepo = { showAdvisor: false, repoId: 7 } as { showAdvisor: boolean };
    expect(effectiveBotsTab('benchmark', withRepo)).toBe('benchmark');
    expect(effectiveBotsTab('benchmark', { showAdvisor: false })).toBe('benchmark');
    // Structural: two parameters, and the second's shape is the capability alone. A mount-aware
    // signature would have to arrive here first.
    expect(effectiveBotsTab).toHaveLength(2);
    expect(sourceOf('components/Activity/benchmarkModel.ts')).toMatch(
      /export function effectiveBotsTab\(\s*raw: BotsInnerTab,\s*opts: \{ showAdvisor: boolean \},?\s*\)/,
    );
  });

  it('keeps `roi` selected too — the same posture, older', () => {
    expect(effectiveBotsTab('roi', { showAdvisor: false })).toBe('roi');
  });

  it('degrades ONLY `advisor`, which is not listed without its capability', () => {
    expect(effectiveBotsTab('advisor', { showAdvisor: false })).toBe('roi');
    expect(effectiveBotsTab('advisor', { showAdvisor: true })).toBe('advisor');
  });

  it('leaves every other member alone', () => {
    for (const tab of BOTS_INNER_TABS) {
      if (tab === 'advisor') continue;
      expect(effectiveBotsTab(tab, { showAdvisor: false })).toBe(tab);
    }
  });

  it('is URL-parsed on every tier, so a bookmark can reach the locked tab', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/hooks/useUrlState.ts', import.meta.url)),
      'utf8',
    );
    // Parsed from the union itself — a member added to the store cannot be forgotten here.
    expect(src).toMatch(/BOTS_INNER_TABS as readonly string\[\]\)\.includes\(botsTab/);
    expect(BOTS_INNER_TABS).toContain('benchmark');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   3. Every refusal is its own sentence
   ───────────────────────────────────────────────────────────────────────────────────────── */

const PLACEMENT_REASONS: readonly BotBenchmarkPlacementRefusalReason[] = [
  'vendor_not_in_corpus_vocabulary',
  'vendor_unfittable',
  'vendor_unstratifiable',
  'cell_not_in_corpus',
  // The TWO customer-side refusals, and they are different facts: an INCOMPLETE window (not held
  // long enough to count the merges) against a COMPLETE window the repository did not use.
  'repo_window_incomplete',
  'repo_inactive_in_window',
];
const UNAVAILABLE_REASONS: readonly BotBenchmarkUnavailableReason[] = [
  'artifact_missing',
  'artifact_unreadable',
  'fit_version_unsupported',
];
const EXCLUSION_REASONS: readonly BotBenchmarkUnitExclusionReason[] = [
  'repo_not_walked',
  'vendor_silent',
  'vendor_absent_from_population',
  'denominator_empty',
  'below_min_units',
  'body_unobserved',
  // ⚠ OUTRANKS `vendor_silent`. Zero merges in the window ⇒ zero pull requests read ⇒ every counter
  // is 0, which the fold would otherwise report as the reviewer having said nothing. Observed:
  // twenty real findings on pull requests merged 40 days ago, rendered as silence.
  'no_prs_in_window',
];

describe('refusal shapes', () => {
  it('has a sentence for every member of every refusal union', () => {
    for (const r of PLACEMENT_REASONS) expect(PLACEMENT_REFUSAL_HEADLINE[r]).toBeTruthy();
    for (const r of UNAVAILABLE_REASONS) expect(UNAVAILABLE_HEADLINE[r]).toBeTruthy();
    for (const r of EXCLUSION_REASONS) expect(EXCLUSION_HEADLINE[r]).toBeTruthy();
    // And no MORE than the union — a stale key here is a sentence for a state the wire retired.
    expect(Object.keys(PLACEMENT_REFUSAL_HEADLINE).sort()).toEqual([...PLACEMENT_REASONS].sort());
    expect(Object.keys(UNAVAILABLE_HEADLINE).sort()).toEqual([...UNAVAILABLE_REASONS].sort());
    expect(Object.keys(EXCLUSION_HEADLINE).sort()).toEqual([...EXCLUSION_REASONS].sort());
  });

  it('says something DIFFERENT for each one — collapsing two is the defect', () => {
    // ⚠ ONE POOL. "We have never measured this bot" and "this build ships no corpus" are not
    // merely different within their own family: a reader meets them on the same screen, and two
    // identical sentences from different causes is exactly how a missing corpus reads as a bot
    // that scored zero.
    const all = [
      ...PLACEMENT_REASONS.map((r) => PLACEMENT_REFUSAL_HEADLINE[r]),
      ...UNAVAILABLE_REASONS.map((r) => UNAVAILABLE_HEADLINE[r]),
      ...EXCLUSION_REASONS.map((r) => EXCLUSION_HEADLINE[r]),
      // The fourteenth: a placed reviewer whose every metric was withheld. It renders in the
      // refusal grammar, so it joins the pool.
      FINDINGS_EMPTY_HEADLINE.nothing_comparable,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('names the DeepSource case as "never measured", not as a zero', () => {
    // A customer's biggest reviewer can be entirely absent from the corpus. The sentence has to
    // say we never measured it — never that it measured nothing.
    const s = PLACEMENT_REFUSAL_HEADLINE.vendor_not_in_corpus_vocabulary.toLowerCase();
    expect(s).toContain('never measured');
    expect(s).not.toContain('0');
    // …and the reviewer is still NAMED, even with no corpus vendor to place it against.
    expect(reviewerLabel('coderabbit')).toBe('CodeRabbit');
    // ⚠ An unbranded CI account is a real and common state: the generic pill, never nothing (which
    // would read as a person) and never the corpus's own vendor vocabulary.
    expect(reviewerLabel(null)).toBe('Bot');
    expect(reviewerLabel('a-vendor-this-build-does-not-know')).toBe('Bot');
  });

  it('keeps a refused unit on screen, ordered after the placed ones', () => {
    const refused = unit({
      repoId: 2,
      repoName: 'aaa-alphabetically-first',
      placement: {
        status: 'refused',
        reason: 'vendor_not_in_corpus_vocabulary',
        message: 'never seen',
      },
    });
    const ordered = orderedUnits([refused, unit()]);
    // Placed first — but the refusal is STILL THERE. A refusal that is not on screen is
    // indistinguishable from a bot we never saw.
    expect(ordered.map((u) => u.repoName)).toEqual(['api', 'aaa-alphabetically-first']);
    expect(ordered).toHaveLength(2);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   4. Percentiles carry their denominator
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('every percentile carries its cohort n and its band count', () => {
  it('renders the rank, the repository count and the band denominator', () => {
    const s = percentileSentence({ percentile: 73, nRepos: 41, bandLabel: '6 of 10' });
    expect(s).toContain('73rd');
    expect(s).toContain('41');
    // ⚠ "6 of 10", not "6": "upper fifth" is honest at 5 bands and a misrepresentation at 10.
    expect(s).toContain('6 of 10');
  });

  it('drops the band clause when there is no band, rather than printing an empty one', () => {
    expect(percentileSentence({ percentile: 50, nRepos: 30, bandLabel: '' })).not.toContain('band');
  });

  it('ordinalises the awkward ranks', () => {
    expect(percentileSentence({ percentile: 1, nRepos: 30, bandLabel: '' })).toContain('1st');
    expect(percentileSentence({ percentile: 11, nRepos: 30, bandLabel: '' })).toContain('11th');
    expect(percentileSentence({ percentile: 22, nRepos: 30, bandLabel: '' })).toContain('22nd');
    expect(percentileSentence({ percentile: 93, nRepos: 30, bandLabel: '' })).toContain('93rd');
  });

  it('ranks an anomaly within the METRIC’s repositories, not the band-support count', () => {
    // ⚠ TWO DIFFERENT NUMBERS. `anomaly.cohortRepos` is how many repositories DEFINED the band
    // cut; the rank is a rank within the metric's own fitted distribution. Printing the former as
    // "of N" beside a percentile puts a rank in a population it was not ranked within.
    const u = unit({
      metrics: { acted_on_rate: compared(0.05, 4, { units: 40 }) },
      anomalies: [
        {
          kind: 'engagement',
          metric: 'acted_on_rate',
          action: 'Decide whether this reviewer earns its seat.',
          share: { percentile: 4, threshold: 10, direction: 'higher_is_better' },
          magnitude: { value: 0.05, cohortMedian: 0.4, gap: 0.35, threshold: 0.15, unit: 'rate' },
          units: 40,
          cohortRepos: 37,
          bandLabel: '6 of 10',
        },
      ],
    });
    const rows = anomalyRows([u]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rankRepos).toBe(41);
    expect(rows[0]?.rankRepos).not.toBe(37);
    expect(rows[0]?.headline).toBe(ANOMALY_HEADLINE.engagement);
  });

  it('groups findings by kind in the plugin’s reporting order', () => {
    const mk = (kind: (typeof ANOMALY_KIND_ORDER)[number], metric: string) => ({
      kind,
      metric,
      action: 'do a thing',
      share: { percentile: 95, threshold: 90, direction: 'neutral' as const },
      magnitude: { value: 2, cohortMedian: 1, gap: 1, threshold: 1, unit: 'rate' },
      units: 10,
      cohortRepos: 30,
      bandLabel: '2 of 4',
    });
    const u = unit({
      anomalies: [mk('overlap', 'cross_bot_overlap_rate'), mk('volume', 'findings_per_merged_pr')],
    });
    expect(anomalyRows([u]).map((r) => r.anomaly.kind)).toEqual(['volume', 'overlap']);
  });

  it('reports nothing when nothing fired — and the tally says how much was checked', () => {
    // ⚠ THE `compared` COUNT IS THE SAMPLE THE ANOMALY RULES ACTUALLY RAN OVER, so it must count
    // ONLY the arm that produced a percentile. A unit here carries all three arms: one compared,
    // one the cohort refused (a real value, no rank) and one withheld on the customer's side.
    // Counting the middle one would tell a reader we checked something we could not rank.
    const mixed = unit({
      repoId: 2,
      placement: { status: 'refused', reason: 'repo_window_incomplete', message: 'too new' },
      metrics: {
        acted_on_rate: compared(0.4, 50),
        thread_resolved_rate: {
          status: 'uncompared',
          value: 0.5,
          units: 12,
          reason: 'cohort_metric_refused',
          cohortRefusal: { rule: 'cell_floor', message: 'not enough peers' },
        },
        human_reply_rate: { status: 'excluded', reason: 'vendor_silent', message: 'silent' },
      },
    });
    expect(anomalyRows([unit()])).toEqual([]);
    // "Nothing stands out" has to read as CHECKED, not as NOT RUN, so the empty state is written
    // from these numbers.
    expect(placementTally([unit(), mixed])).toEqual({
      units: 2,
      placed: 1,
      refused: 1,
      compared: 2,
      anomalies: 0,
    });
  });

  // ⚠ FOUND BY RUNNING IT, NOT BY READING IT. Every unit on the first live call against real data
  // was PLACED (vendor known, band resolved, cohort present) with all thirteen metrics withheld —
  // a quiet repository is `below_min_units` thirteen times over. "Nothing stands out" over ZERO
  // comparisons is a clean bill of health issued after measuring nothing.
  it('says "nothing could be compared" when the comparison count is zero, not "nothing stands out"', () => {
    const allWithheld = unit({
      metrics: {
        acted_on_rate: { status: 'excluded', reason: 'below_min_units', message: 'too few' },
        thread_resolved_rate: {
          status: 'excluded',
          reason: 'vendor_absent_from_population',
          message: 'nothing in this population',
        },
      },
    });
    expect(findingsEmptyState(placementTally([allWithheld]))).toBe('nothing_comparable');
    expect(findingsEmptyState(placementTally([unit()]))).toBe('nothing_stands_out');
    // The two sentences are different sentences, and the refusal is in the refusal pool below.
    expect(FINDINGS_EMPTY_HEADLINE.nothing_comparable).not.toBe(
      FINDINGS_EMPTY_HEADLINE.nothing_stands_out,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   5. The distribution strip
   ───────────────────────────────────────────────────────────────────────────────────────── */

const Q = { p10: 0.2, p25: 0.3, p50: 0.4, p75: 0.55, p90: 0.7 };

describe('stripGeometry', () => {
  it('refuses to draw a partial grid rather than drawing a distribution nobody fitted', () => {
    expect(stripGeometry({ p10: 0.2, p50: 0.4, p90: 0.7 }, 0.3, null)).toBeNull();
    expect(stripGeometry({ ...Q, p25: Number.NaN }, 0.3, null)).toBeNull();
    expect(stripGeometry(Q, Number.NaN, null)).toBeNull();
  });

  it('keeps the marks in ascending order across the axis', () => {
    const g = stripGeometry(Q, 0.45, [0.35, 0.46]);
    expect(g).not.toBeNull();
    const marks = [g!.p10, g!.p25, g!.p50, g!.p75, g!.p90];
    expect(marks).toEqual([...marks].sort((a, b) => a - b));
    for (const m of marks) {
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });

  it('always contains the customer’s own value, however far outside the cohort it sits', () => {
    // ⚠ A dot clipped off the axis reads as "nothing there", which is the one claim this panel
    // must never make by accident.
    const below = stripGeometry(Q, 0.0, null);
    expect(below!.value).toBeGreaterThan(0);
    expect(below!.value).toBeLessThan(below!.p10);
    const above = stripGeometry(Q, 5, null);
    expect(above!.value).toBeLessThan(1);
    expect(above!.value).toBeGreaterThan(above!.p90);
  });

  it('collapses to the centre when the cohort has no spread at all', () => {
    const flat = stripGeometry({ p10: 1, p25: 1, p50: 1, p75: 1, p90: 1 }, 1, null);
    expect(flat).toEqual({
      domain: [1, 1],
      p10: 0.5,
      p25: 0.5,
      p50: 0.5,
      p75: 0.5,
      p90: 0.5,
      value: 0.5,
      ci: null,
    });
  });

  it('positions the median’s 95% CI on the same axis, and omits it when the cohort sent none', () => {
    const withCi = stripGeometry(Q, 0.4, [0.35, 0.46]);
    expect(withCi!.ci).not.toBeNull();
    expect(withCi!.ci![0]).toBeLessThan(withCi!.p50);
    expect(withCi!.ci![1]).toBeGreaterThan(withCi!.p50);
    expect(stripGeometry(Q, 0.4, null)?.ci).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   6. Metric rows, formatting, and the structurally-absent half
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('metric rows', () => {
  it('renders every metric the wire carries, including one this build has no label for', () => {
    // ⚠ A corpus refit that adds a metric must make it VISIBLE (ugly, under its raw key) rather
    // than silently invisible behind a stale display table.
    const u = unit({
      metrics: {
        acted_on_rate: compared(0.31, 8),
        thread_resolved_rate: compared(0.5, 50),
        a_brand_new_metric: compared(1, 60),
      },
    });
    const names = metricRows(u).map((r) => r.name);
    expect(names).toEqual(['acted_on_rate', 'thread_resolved_rate', 'a_brand_new_metric']);
    expect(metricRows(u).map((r) => r.label)).toContain('Acted on');
    // The unknown one falls back to its raw key rather than to a blank cell.
    expect(metricRows(u).at(-1)?.label).toBe('a_brand_new_metric');
  });

  it('keeps the three arms apart — excluded carries no value, uncompared carries no rank', () => {
    const u = unit({
      metrics: {
        acted_on_rate: {
          status: 'excluded',
          reason: 'vendor_silent',
          message: 'left no comment anywhere',
        },
        thread_resolved_rate: {
          status: 'uncompared',
          value: 0.5,
          units: 12,
          reason: 'cohort_metric_refused',
          cohortRefusal: { rule: 'cell_floor', message: 'not enough peers' },
        },
      },
    });
    const rows = metricRows(u);
    const excluded = rows.find((r) => r.name === 'acted_on_rate')?.metric;
    const uncompared = rows.find((r) => r.name === 'thread_resolved_rate')?.metric;
    expect(excluded?.status).toBe('excluded');
    expect(excluded).not.toHaveProperty('value');
    expect(uncompared?.status).toBe('uncompared');
    // ⚠ NEVER 0 AND NEVER A PLAUSIBLE SMALL NUMBER: there is no distribution to rank within.
    expect(uncompared).not.toHaveProperty('percentile');
    // A `compared` metric is what an anomaly needs, so neither of these can produce a finding.
    expect(anomalyRows([u])).toEqual([]);
  });

  it('formats a value in the unit the cohort served', () => {
    expect(formatMetricValue(0.314, 'rate')).toBe('31%');
    expect(formatMetricValue(0.043, 'rate')).toBe('4.3%');
    expect(formatMetricValue(1.5, 'count_per_pr')).toBe('1.5');
    expect(formatMetricValue(2, 'count_per_pr')).toBe('2');
    // ⚠ A trailing-zero trim that is not anchored to a decimal point turns 100% into 1%.
    expect(formatMetricValue(1, 'rate')).toBe('100%');
    expect(formatMetricValue(0.2, 'rate')).toBe('20%');
    expect(formatMetricValue(0.5, 'hours')).toBe('30m');
    expect(formatMetricValue(6, 'hours')).toBe('6h');
    expect(formatMetricValue(72, 'hours')).toBe('3d');
  });
});

describe('the model-derived half is STRUCTURALLY ABSENT', () => {
  it('carries the absent metrics through with their precondition, never as a zero', () => {
    const rows = absentMetricRows([
      {
        name: 'high_severity_share',
        definition: 'share of findings the model calls high severity',
        derivation: 'model',
        direction: 'neutral',
        unit: 'rate',
        reason: 'not_scored',
        note: 'Arrives when the corpus is scored.',
        requires: { scoring_state: 'scored' },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Share flagged high severity');
    // ⚠ LABELLED APART from every code-derived figure on the same screen.
    expect(rows[0]?.derivation).toBe('model');
    expect(DERIVATION_LABEL.model).not.toBe(DERIVATION_LABEL.code);
    // There is no value key to render — the panel says when it arrives instead of showing nothing.
    expect(rows[0]).not.toHaveProperty('value');
    expect(rows[0]?.requires).toEqual({ scoring_state: 'scored' });
  });

  it('renders nothing at all when the wire sends none', () => {
    expect(absentMetricRows(undefined)).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   7. Two things running it against real data taught the panel
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('a placed repository can sit outside its own band’s range', () => {
  // ⚠ OBSERVED ON REAL DATA: "Activity band 1 of 10 (2–3 merged PRs a fortnight)" rendered beside
  // "You: 0 merged in 14 days". That is correct — `bandRange` is the SUPPORT interval, the
  // placement rule reads HIGH edges only, and the outermost bands are open in the direction they
  // face — but on screen it reads as a contradiction unless it is said out loud.
  it('says so when the value is below the band’s support range', () => {
    const note = bandFitNote({ activity: 0, bandRange: [2, 3], aboveTopBandBy: null });
    expect(note).toContain('0');
    expect(note).toContain('2');
    expect(note).toMatch(/open at the bottom/);
  });

  it('says nothing when the value really is inside the range', () => {
    expect(bandFitNote({ activity: 22, bandRange: [18, 26], aboveTopBandBy: null })).toBeNull();
    // Inclusive at both edges — an exact edge is inside, not outside.
    expect(bandFitNote({ activity: 18, bandRange: [18, 26], aboveTopBandBy: null })).toBeNull();
    expect(bandFitNote({ activity: 26, bandRange: [18, 26], aboveTopBandBy: null })).toBeNull();
  });

  it('defers to the top-band caveat rather than doubling up', () => {
    // `aboveTopBandBy` already has its own dedicated line; two sentences about one fact is worse
    // than one.
    expect(bandFitNote({ activity: 400, bandRange: [18, 258], aboveTopBandBy: 142 })).toBeNull();
  });
});

describe('thirteen identical refusals are ONE refusal', () => {
  const excluded = (reason: BotBenchmarkUnitExclusionReason) =>
    ({ status: 'excluded', reason, message: 'because' }) as const;

  it('collapses when every metric was withheld under the same reason', () => {
    // ⚠ OBSERVED ON REAL DATA: a reviewer that said nothing in a repository produced thirteen
    // consecutive "Said nothing here" rows, which reads as thirteen measurements that each came
    // back empty rather than as one fact about the reviewer.
    const u = unit({
      metrics: {
        acted_on_rate: excluded('vendor_silent'),
        thread_resolved_rate: excluded('vendor_silent'),
        human_reply_rate: excluded('vendor_silent'),
      },
    });
    expect(collapsedExclusion(metricRows(u))).toBe('vendor_silent');
  });

  it('does NOT collapse a mix — the reasons say different things about the blind spot', () => {
    // This is the real jupyter/notebook shape: below_min_units, denominator_empty and
    // vendor_absent_from_population in one unit. `vendor_silent` and `below_min_units` mean
    // opposite things about whether the reviewer is even installed.
    const u = unit({
      metrics: {
        acted_on_rate: excluded('below_min_units'),
        thread_resolved_rate: excluded('denominator_empty'),
        human_reply_rate: excluded('vendor_absent_from_population'),
      },
    });
    expect(collapsedExclusion(metricRows(u))).toBeNull();
  });

  it('never collapses a unit that has a real value in it', () => {
    const u = unit({
      metrics: {
        acted_on_rate: excluded('vendor_silent'),
        thread_resolved_rate: compared(0.5, 50),
      },
    });
    expect(collapsedExclusion(metricRows(u))).toBeNull();
    expect(collapsedExclusion([])).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   8. Scope
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('the placement query key', () => {
  it('carries a ws: segment, and gives the repo narrowing its own slot', () => {
    // Two workspaces must never share a cache entry; nor must two narrowings of one workspace.
    expect(botBenchmarkPlacementQueryKey(5, null)).not.toEqual(
      botBenchmarkPlacementQueryKey(6, null),
    );
    expect(botBenchmarkPlacementQueryKey(5, [1])).not.toEqual(
      botBenchmarkPlacementQueryKey(5, [2]),
    );
    expect(botBenchmarkPlacementQueryKey(5, null)).not.toEqual(
      botBenchmarkPlacementQueryKey(5, [1]),
    );
    expect(botBenchmarkPlacementQueryKey(5, [2, 1])).toEqual(
      botBenchmarkPlacementQueryKey(5, [1, 2]),
    );
    expect(JSON.stringify(botBenchmarkPlacementQueryKey(5, null))).toContain('ws:5');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   9. Cost — the price, the counterfactual, and the four things that must not render
      ⚠ THE PER-REPOSITORY GRAIN, WHICH NO SCREEN RENDERS ANY MORE. `BotBenchmarkPlacementUnit.cost`
      is off the wire, the server sends no money on a repo-narrowed request, and `CostBlock` is
      deleted from the panel — so `costHeadline`, `collapsedCostRefusal`, `costSharedNote` and
      `formatSpanDays` are now reachable only from this file.

      THEY ARE KEPT, TESTED, UNTIL SOMEBODY DELETES THEM, and that is not a hedge. Every assertion
      below is the written record of a shipped defect — a counterfactual figure printed under a
      measured sentence, a ratio suffixed with a window, an unbounded branch that rendered −4.1 ×
      the spend as money, a caveat gated on a count that was always 1 on the one screen that needed
      it. The WORKSPACE grain in §10 inherits every one of those rules and is asserted against them
      independently; weakening these while the functions still compile would leave the record only
      in a commit message. When the functions go, these go with them in the same edit.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** The house fixture, mirroring `packages/pro/test/benchmark-cost.test.ts`'s: a US$120/month
 *  reviewer whose comments span SIXTY days here, twenty settled threads of which four were acted
 *  on, against a cohort median of 60 %.
 *
 *  ⚠ THE SPAN CARRIES NO MONEY. It held a `usd` of 236.53088 — today's price prorated across those
 *  sixty days — and every reviewer-side figure was a share of it, so the headline claimed a spend
 *  the app cannot evidence. The money is now a RATE at the monthly price (`unactedUsd` 96 rather
 *  than 189.224704, `conversionGapUsd` 48 rather than 94.612352) while the per-thread figures are
 *  the SAME numbers, because `spanUsd ÷ acted` == `monthlyUsd ÷ actedPerMonth`.
 *
 *  ⚠ The span is still deliberately NOT the 14-day window — it is the window the WORK was measured
 *  over, and `formatSpanDays` says so in weeks. */
function costBlock(over: Partial<BotBenchmarkPlacementCost> = {}): BotBenchmarkPlacementCost {
  return {
    monthlyUsd: 120,
    costModel: 'flat',
    unitMonthlyUsd: null,
    seats: null,
    pricedReviewers: 1,
    seatPriceUnresolved: 0,
    seatCountZero: 0,
    windowDays: 14,
    windowUsd: 55.190539,
    span: {
      days: 60,
      fromIso: '2026-06-02T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      comments: 20,
    },
    sharedWithUnits: 1,
    perMergedPr: { status: 'value', value: 5.519054, mergedPrs: 10 },
    unacted: {
      status: 'value',
      actedOnRate: 0.2,
      actedThreads: 4,
      settledThreads: 20,
      unactedUsd: 96, // 120 × 0.8, a month
    },
    yours: {
      status: 'value',
      actedThreads: 4,
      settledThreads: 20,
      actedOnRate: 0.2,
      actedPerMonth: 2.029333, // 4 × 30.44 ÷ 60
      perActedOnUsd: 59.13272, // 120 ÷ 2.029333 — unchanged by the change of basis
    },
    atPeerEngagement: {
      status: 'value',
      cohortActedOnRate: 0.6,
      actedThreadsAtPeer: 12,
      actedPerMonthAtPeer: 6.088, // 12 × 30.44 ÷ 60
      perActedOnUsd: 19.710907,
      perActedOnGapUsd: 39.421813,
      conversionGapUsd: 48, // 120 × (0.6 − 0.2), a month
    },
    spanNote: 'a rate at today’s price, over the window the work was measured in',
    ...over,
  };
}

const refused = (reason: BotBenchmarkCostRefusalReason) =>
  ({ status: 'refused', reason, message: 'because.' }) as const;

describe('the retired per-repository cost model', () => {
  it('renders currency unambiguously and never as a bare dollar sign', () => {
    // ⚠ `$412` is four currencies AND, read next to a monthly subscription, invites the reader to
    // assume a month. Both halves are fixed here: US$ and the window.
    expect(formatUsd(412)).toBe('US$412.00');
    expect(formatUsd(1234.5)).toBe('US$1,234.50');
    expect(formatUsd(0)).toBe('US$0.00');
    expect(formatUsd(-27.6)).toBe('-US$27.60');
    // ⚠ A NON-ZERO FIGURE NEVER PRINTS AS US$0.00. A high-volume reviewer can genuinely cost
    // fractions of a cent per thread, and rounding it to two places prints exactly the row of zeros
    // the zero-price refusal exists to avoid, arriving from the other direction.
    expect(formatUsd(0.004)).toBe('<US$0.01');
    expect(formatUsd(0.004)).not.toBe('US$0.00');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('states the window on the windowed TOTAL, and never on a ratio', () => {
    // ⚠ THE PURE HALF ONLY. The RENDER half of this rule — that no ratio row carries the window
    // label — moved to §12 with the figures it guards, because those figures are now on a rollup
    // card. `costPriceLine` is the one function on this retired surface that is still LIVE:
    // `workspaceCostPriceLine` delegates to it, deliberately, so a reader is never told about their
    // own subscription two different ways depending on which card they are standing on.
    expect(costWindowLabel(14)).toBe('per 14 days');
    const line = costPriceLine(costBlock());
    expect(line).toContain('US$120.00 a month');
    expect(line).toContain('US$55.19 per 14 days');
    // The delegation, asserted rather than assumed: one implementation, one wording.
    expect(workspaceCostPriceLine(workspaceCost())).toBe(costPriceLine(workspaceCost()));
  });

  it('states a span in units a reader holds in their head', () => {
    // "94.3 days" is a number nobody carries; the panel says months, weeks or days by size.
    expect(formatSpanDays(9)).toBe('9 days');
    expect(formatSpanDays(9.25)).toBe('9.3 days');
    expect(formatSpanDays(21)).toBe('3 weeks');
    expect(formatSpanDays(94.3)).toBe('3.1 months');
    // ⚠ A ZERO OR NEGATIVE SPAN NEVER REACHES A SENTENCE — the server sends `span: null` and every
    // span-anchored arm refuses — but a formatter that printed "0 days" beside a real figure would
    // be a contradiction on one line.
    expect(formatSpanDays(0)).toBe('—');
    expect(formatSpanDays(Number.NaN)).toBe('—');
  });

  it('shows both halves of a per-seat price, because "US$120" beside a stored 15 is unexplainable', () => {
    const line = costPriceLine(
      costBlock({ costModel: 'per_seat', unitMonthlyUsd: 15, seats: 8 }),
    );
    expect(line).toContain('US$15.00 per seat × 8 seats');
    expect(line).toContain('US$120.00 a month');
    // Singular seats read as English, not as "1 seats".
    expect(
      costPriceLine(costBlock({ costModel: 'per_seat', unitMonthlyUsd: 120, seats: 1 })),
    ).toContain('× 1 seat');
  });

  it('ALWAYS said the price is per WORKSPACE, and counted the cards when there was more than one', () => {
    // ⚠ THE CAVEAT WAS THE WEAK FIX AND THIS IS ITS HEADSTONE. `sharedWithUnits` counted the cards
    // in one response, and the per-repository Bots tab narrows to one repository — so a caveat
    // gated on `> 1` was invisible on exactly the screen where a reader was most likely to read a
    // Workspace-wide subscription as this repository's bill. Making it unconditional was the first
    // fix; MOVING THE GRAIN was the real one, and `workspaceCostCoverageNote` (§10) is what renders
    // now. Nothing calls this any more — §12 asserts the panel does not — and the sentence it
    // replaced is preserved verbatim in `workspaceCostCoverageNote`'s own docstring.
    const single = costSharedNote(costBlock({ sharedWithUnits: 1 }));
    expect(single).toMatch(/Workspace price/);
    expect(single).toMatch(/upper bound/i);
    expect(single).toMatch(/not shown here/);
    // One US$120 subscription over four repositories is four cards each carrying US$120.
    const many = costSharedNote(costBlock({ sharedWithUnits: 4 }));
    expect(many).toMatch(/4 cards/);
    expect(many).toMatch(/adding them together/i);
    expect(many).toMatch(/upper bounds/i);
    expect(many).not.toBe(single);
  });

  it('never prints a fractional thread count as a whole "0", and keeps a measured one whole', () => {
    // ⚠ THE COUNTERFACTUAL'S COUNT IS FRACTIONAL. "0 acted on" beside a real cost-per-thread figure
    // is a contradiction on one line — a price per unit of something the same row says there is
    // none of.
    expect(formatThreadCount(0.4)).toBe('0.4');
    expect(formatThreadCount(0.4)).not.toBe('0');
    expect(formatThreadCount(0.02)).toBe('<0.1');
    expect(formatThreadCount(9.25)).toBe('9.3');
    expect(formatThreadCount(142.6)).toBe('143');
    // …and the customer's own count is a REAL integer now, so it must not gain a decimal point.
    expect(formatThreadCount(3)).toBe('3');
    expect(formatThreadCount(4)).toBe('4');
  });

  it('discloses a summed price and BOTH unusable per-seat cases, and stays quiet otherwise', () => {
    expect(costPricedReviewersNote(costBlock())).toBeNull();
    expect(costPricedReviewersNote(costBlock({ pricedReviewers: 2 }))).toMatch(/2 priced accounts/);
    expect(costSeatUnresolvedNote(costBlock())).toBeNull();
    expect(costSeatZeroNote(costBlock())).toBeNull();
    // ⚠ A missing disclosure is the same defect as a wrong number, one line quieter: a per-seat
    // price left out of the figure must be visible or the total silently understates.
    expect(costSeatUnresolvedNote(costBlock({ seatPriceUnresolved: 1 }))).toMatch(
      /per-seat price is left out/,
    );
    // ⚠ AND A ZERO SEAT COUNT IS A DIFFERENT SENTENCE FROM AN UNREADABLE ONE. "This build cannot
    // read your seat count" and "your Workspace has no human authors this month" have different
    // remedies; collapsing them is the defect every vocabulary on this tab exists to prevent. The
    // conflation itself shipped one level down — a per-seat price times 0 seats rendered as
    // "Recorded as free" about a reviewer somebody priced.
    const zero = costSeatZeroNote(costBlock({ seatCountZero: 1 }));
    expect(zero).toMatch(/per-seat price is left out/);
    expect(zero).toMatch(/no human pull-request authors/);
    expect(zero).not.toBe(costSeatUnresolvedNote(costBlock({ seatPriceUnresolved: 1 })));
    // Plural reads as English on both.
    expect(costSeatZeroNote(costBlock({ seatCountZero: 2 }))).toMatch(/2 per-seat prices are/);
  });

  it('names the MEASURED figure in the sentence that claims it — not the counterfactual gap', () => {
    // ⚠ THE DEFECT THIS TEST EXISTS FOR. The headline printed `windowGapUsd` — the shortfall
    // RELATIVE TO PEER ENGAGEMENT — followed by the words "is buying feedback nobody acts on",
    // which name the ABSOLUTE unacted figure. The two differ by a factor of the cohort's rate.
    const head = costHeadline(costBlock());
    expect(head?.tone).toBe('behind');
    // Sentence one is the MEASURED figure, and it is the one the "nobody acts on" words sit on.
    expect(head?.spend).toContain('US$96.00');
    expect(head?.spend).toMatch(/is buying feedback nobody acts on/);
    // ⚠ A RATE AT THE MONTHLY PRICE, NEVER A SPEND OVER THE SPAN. The sentence shipped as
    // "US$189.22 of this reviewer's US$236.53 over the 8.6 weeks its comments span here bought
    // feedback nobody acted on" — a claim about money already spent, which today's price and a
    // recent throughput do not license. Both of those figures are named here so a revert is loud.
    expect(head?.spend).toContain('US$120.00');
    expect(head?.spend).toMatch(/monthly price/);
    expect(head?.spend).toMatch(/a month/);
    expect(head?.spend).not.toContain('US$189.22');
    expect(head?.spend).not.toContain('US$236.53');
    expect(head?.spend).not.toMatch(/bought feedback/);
    // ⚠ THE SPAN IS STILL DISCLOSED, AS THE WINDOW THE WORK WAS MEASURED IN. Sixty days of
    // observed output, said in weeks, and never "per 14 days".
    expect(head?.spend).toMatch(/measured over the 8\.6 weeks its comments span here/);
    expect(head?.spend).not.toMatch(/14 days/);
    expect(head?.spend).toMatch(/20 threads/);
    // ⚠ AND THE COUNTERFACTUAL'S NUMBER IS NOWHERE NEAR THOSE WORDS.
    expect(head?.spend).not.toContain('US$48.00');
    expect(head?.spend).not.toMatch(/cohort/i);
  });

  it('puts the counterfactual in a SECOND sentence, worded as one, never as what a peer pays', () => {
    const head = costHeadline(costBlock());
    expect(head?.comparison).toContain('US$48.00');
    expect(head?.comparison).toMatch(/cohort's median acted-on rate of 60%/);
    // ⚠ PRESENT TENSE AND PER MONTH. "would have been acted on" is a claim about a period that has
    // already happened, which is the same history the spend sentence stopped making.
    expect(head?.comparison).toMatch(/a month more of that same price would be acted on/);
    expect(head?.comparison).not.toMatch(/would have been/);
    expect(head?.comparison).toMatch(/your threads and your price, their engagement/);
    // ⚠ IT MUST NOT CLAIM TO BE A PEER'S BILL. "What a peer pays" would be a figure built from two
    // cohort quantiles — the median of a product is not the product of the medians.
    expect(head?.comparison).not.toMatch(/peers? pays?|peer cost|a peer would pay/i);
    // ⚠ AND THE TWO FIGURES ARE STRUCTURALLY UNMIXABLE: two fields, so a renderer cannot put the
    // second's number under the first's words by accident. Neither string carries the other's.
    expect(head?.comparison).not.toContain('US$96.00');
    expect(head?.spend).not.toContain('US$48.00');
  });

  it('does not word a NEGATIVE gap as waste — engaging more than the cohort is a good state', () => {
    const head = costHeadline(
      costBlock({
        unacted: {
          status: 'value',
          actedOnRate: 0.88,
          actedThreads: 17.6,
          settledThreads: 20,
          unactedUsd: 14.4, // 120 × 0.12, a month
        },
        atPeerEngagement: {
          status: 'value',
          cohortActedOnRate: 0.6,
          actedThreadsAtPeer: 12,
          actedPerMonthAtPeer: 6.088,
          perActedOnUsd: 19.71,
          perActedOnGapUsd: -3,
          conversionGapUsd: -33.6, // 120 × (0.6 − 0.88)
        },
      }),
    );
    expect(head?.tone).toBe('ahead');
    expect(head?.comparison).toMatch(/acts on more of this reviewer/);
    expect(head?.comparison).toContain('US$33.60');
    // ⚠ No minus sign in the sentence and no "wasted": "-US$33.60 is buying feedback nobody acts
    // on" is a sentence that means nothing.
    expect(head?.comparison).not.toContain('-US$');
    expect(head?.comparison).not.toMatch(/nobody acts on/);
    // …and the measured sentence still stands, saying what the price still buys unacted at that
    // better rate.
    expect(head?.spend).toContain('US$14.40');
  });

  it('never renders an AHEAD figure larger than the monthly price it is a share of', () => {
    // ⚠ THE UNBOUNDED-BRANCH DEFECT, AT THE RENDERER. `windowGapUsd` was
    // `spend × (1 − own ÷ cohort)`, bounded only while the customer sat at or below the median —
    // and the shipped corpus holds real fitted `acted_on_rate` medians as low as 0.242857, so a
    // repository acting on everything produced −4.1 × the spend and this branch printed
    // "US$172.06 more of the US$55.19 reaches something". The server's figure is a difference of
    // two rates times the MONTHLY PRICE, so `-gap` cannot exceed that price; this pins the
    // renderer's half.
    const monthly = 120;
    const head = costHeadline(
      costBlock({
        unacted: {
          status: 'value',
          actedOnRate: 1,
          actedThreads: 20,
          settledThreads: 20,
          unactedUsd: 0,
        },
        atPeerEngagement: {
          status: 'value',
          cohortActedOnRate: 0.242857,
          actedThreadsAtPeer: 4.857143,
          actedPerMonthAtPeer: 2.463813,
          perActedOnUsd: 48.698298,
          perActedOnGapUsd: -36.87,
          conversionGapUsd: -90.85716, // 120 × (0.242857 − 1)
        },
      }),
    );
    expect(head?.tone).toBe('ahead');
    expect(head?.comparison).toContain('US$90.86');
    expect(90.85716).toBeLessThanOrEqual(monthly);
    // ⚠ TWO OLD ANSWERS NAMED SO NEITHER REVERT IS SILENT. The RATIO formula gives
    // 120 × (1 − 1 ÷ 0.242857) = −374.12, three times the price it is a share of; the SPAN basis
    // gives 236.53088 × (0.242857 − 1) = −179.09, a share of a spend nobody can evidence.
    expect(head?.comparison).not.toContain('US$374.12');
    expect(head?.comparison).not.toContain('US$179.09');
  });

  it('keeps the MEASURED sentence when the counterfactual refused, and drops only the comparison', () => {
    // ⚠ A COHORT THAT PUBLISHED NO MEDIAN IS A FACT ABOUT THE CORPUS. It must not delete the
    // customer's own figure, which needs nothing but their data — the headline shipped returning
    // null here, which threw away the only sentence on this card that is purely measured.
    const head = costHeadline(costBlock({ atPeerEngagement: refused('cohort_rate_unfitted') }));
    expect(head?.tone).toBe('measured');
    expect(head?.spend).toContain('US$96.00');
    expect(head?.comparison).toBeNull();
    // …and with the MEASURED arm refused there is no headline at all: sentence one is the
    // precondition, not the comparison.
    expect(costHeadline(costBlock({ unacted: refused('own_rate_withheld') }))).toBeNull();
    // ⚠ A SPAN THE SERVER COULD NOT OBSERVE TAKES THE WHOLE HEADLINE WITH IT, even though neither
    // figure divides by it any more: both sentences assert a CURRENT pace, and the span is the only
    // evidence that the counts describe one. The server refuses all three arms for the same reason,
    // so this is belt-and-braces on a shape that should never arrive.
    expect(costHeadline(costBlock({ span: null }))).toBeNull();
    // …and so does a price that could not be stated: there is no monthly figure to state a rate at.
    expect(costHeadline(costBlock({ monthlyUsd: null, windowUsd: null }))).toBeNull();
  });

  it('says the monthly figure is MISSING, never US$0.00, when a per-seat price could not be read', () => {
    // ⚠ THE THIRD PRICE STATE, ON THE RENDER SIDE. `monthlyUsd: null` is a price somebody ENTERED
    // whose per-seat unit could not be multiplied out — not "no price" (which is the absence of the
    // whole block) and not a stored 0 (which is "recorded as free"). Running it through `formatUsd`
    // prints "US$0.00 a month", which is the exact false claim the seat-count drop exists to
    // prevent, arriving one line up from the refusal that was supposed to prevent it.
    const line = costPriceLine(costBlock({ monthlyUsd: null, windowUsd: null }));
    expect(line).not.toContain('US$0.00');
    expect(line).toMatch(/No monthly figure/);
    expect(line).toMatch(/per seat/);
    // …and its refusal headline is its own sentence, never the zero-price one.
    expect(COST_REFUSAL_HEADLINE.price_unresolved).not.toBe(COST_REFUSAL_HEADLINE.price_is_zero);
    expect(COST_REFUSAL_HEADLINE.price_unresolved).not.toMatch(/free/i);
    // ⚠ AND IT IS THE SAME SENTENCE AT THE WORKSPACE GRAIN, because it is the same three price
    // states. The render-side guard for it moved to §12 with the block it guards.
    const wsLine = workspaceCostPriceLine(workspaceCost({ monthlyUsd: null, windowUsd: null }));
    expect(wsLine).not.toContain('US$0.00');
    expect(wsLine).toMatch(/No monthly figure/);
  });

  it('gives the TEN cost refusals ten DIFFERENT sentences, and every union member one', () => {
    // ⚠ THE SAME PAIRWISE RULE THE OTHER THREE VOCABULARIES KEEP. A renderer that collapsed two of
    // these tells a customer their reviewer costs nothing when in fact nobody merged anything.
    //
    // ⚠ THE TENTH ARRIVED WITH THE GRAIN CHANGE AND IS REACHABLE ONLY AT THE NEW GRAIN.
    // `workspace_truncated` says the estate was cut short by the per-request repository cap, which
    // is a fact a PER-REPOSITORY figure survives (its own repository is whole) and a WORKSPACE
    // figure does not — a whole subscription divided by part of the work is wrong in the inflating
    // direction. `buildUnitCost` can therefore never emit it, which is why the pro suite's
    // nine-refusal fold still reads nine and this list, which is over the UNION rather than over
    // one producer's outputs, must read ten.
    const reasons: BotBenchmarkCostRefusalReason[] = [
      'repo_window_incomplete',
      'no_merges_in_window',
      'span_unobserved',
      'own_rate_withheld',
      'nothing_acted_on',
      'price_is_zero',
      'price_unresolved',
      'cohort_rate_unfitted',
      'cohort_rate_zero',
      'workspace_truncated',
      // ⚠ THE ELEVENTH, AND IT IS ALSO ROLLUP-ONLY. `window_underpopulated` says the chosen calendar
      // month the money divides by holds too few acted-on threads to divide a price by — a claim
      // about a WINDOW, which the per-repository block (a price over an observed span) cannot make.
      'window_underpopulated',
    ];
    expect(reasons).toHaveLength(11);
    expect(Object.keys(COST_REFUSAL_HEADLINE).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect(COST_REFUSAL_HEADLINE[reason], reason).toBeTruthy();
      expect(COST_REFUSAL_HEADLINE[reason], reason).not.toMatch(/undefined/);
    }
    expect(new Set(Object.values(COST_REFUSAL_HEADLINE)).size).toBe(reasons.length);
    // ⚠ AND THE TENTH NAMES THE REMEDY, because it is the one refusal a reader can act on: the
    // per-repository tab still places a repository on its own. A sentence that only says "too many
    // repositories" leaves them with nowhere to go.
    expect(COST_REFUSAL_HEADLINE.workspace_truncated.length).toBeGreaterThan(40);
    // ⚠ AND IT REUSES THE PLACEMENT'S OWN WORDS for the one cause both refuse. Two different
    // sentences for one fact on one card is how a reader stops believing either.
    expect(COST_REFUSAL_HEADLINE.no_merges_in_window).toBe(
      PLACEMENT_REFUSAL_HEADLINE.repo_inactive_in_window,
    );
    expect(COST_REFUSAL_HEADLINE.repo_window_incomplete).toBe(
      PLACEMENT_REFUSAL_HEADLINE.repo_window_incomplete,
    );
  });

  it('collapses four identical refusals into one, and keeps a mix in full', () => {
    // ⚠ A price of 0 refuses all four (every figure is exactly 0.00); a repository that merged
    // nothing refuses all four for the placement's reason. Four consecutive dimmed rows read as
    // four separate measurements that each came back empty.
    expect(
      collapsedCostRefusal(
        costBlock({
          perMergedPr: refused('price_is_zero'),
          unacted: refused('price_is_zero'),
          yours: refused('price_is_zero'),
          atPeerEngagement: refused('price_is_zero'),
        }),
      ),
    ).toBe('price_is_zero');
    // A MIX says different things about where the blind spot is and keeps its full list — here all
    // four refused, for four different reasons.
    //
    // ⚠ ALL FOUR ARMS MUST REFUSE FOR THIS ASSERTION TO REACH THE LOOP AT ALL. An earlier draft
    // left `perMergedPr` as a value, so the function returned null from its first guard and the
    // reason-equality check was never executed — the assertion passed against an implementation
    // that had DELETED that check. Mutation-tested after the fix: dropping
    // `|| arm.reason !== first.reason` turns this red.
    expect(
      collapsedCostRefusal(
        costBlock({
          perMergedPr: refused('no_merges_in_window'),
          unacted: refused('span_unobserved'),
          yours: refused('own_rate_withheld'),
          atPeerEngagement: refused('cohort_rate_unfitted'),
        }),
      ),
    ).toBeNull();
    // Three of four sharing a reason is still a mix.
    expect(
      collapsedCostRefusal(
        costBlock({
          perMergedPr: refused('price_is_zero'),
          unacted: refused('price_is_zero'),
          yours: refused('price_is_zero'),
          atPeerEngagement: refused('cohort_rate_unfitted'),
        }),
      ),
    ).toBeNull();
    // ⚠ `unacted` IS IN THE LIST EVEN THOUGH IT HAS NO ROW OF ITS OWN — it is the headline's first
    // sentence, and a collapse blind to it would fold three rows into one line while the headline
    // above them vanished for a fourth reason nobody was told about. Mutation-tested: dropping
    // `cost.unacted` from the arm list turns this line green when it must be red.
    expect(
      collapsedCostRefusal(
        costBlock({
          perMergedPr: refused('price_is_zero'),
          unacted: refused('span_unobserved'),
          yours: refused('price_is_zero'),
          atPeerEngagement: refused('price_is_zero'),
        }),
      ),
    ).toBeNull();
    // …and a block with any real figure in it never collapses, whichever arm holds it.
    expect(collapsedCostRefusal(costBlock())).toBeNull();
    expect(
      collapsedCostRefusal(
        costBlock({ yours: refused('nothing_acted_on'), atPeerEngagement: refused('nothing_acted_on') }),
      ),
    ).toBeNull();
  });

  it('labels the three sources apart — a typed price, counted rates, a fitted cohort median', () => {
    // ⚠ THE TAB'S OWN RULE, one block down: a model-derived figure and a code-derived one must be
    // labelled apart in a panel that mixes them. Here it is three, and the counterfactual's FITTED
    // median is the one that must never read as an invoice.
    expect(Object.keys(COST_BASIS_LABEL).sort()).toEqual(['counted', 'fitted', 'stored']);
    expect(new Set(Object.values(COST_BASIS_LABEL)).size).toBe(3);
    expect(COST_BASIS_LABEL.fitted).toMatch(/fitted/i);
    expect(COST_BASIS_LABEL.fitted).toMatch(/peer/i);
    expect(COST_BASIS_LABEL.counted).toMatch(/yours|your data/i);
    expect(COST_BASIS_LABEL.stored).toMatch(/you entered/i);
    // The render-side half of this rule — which ROW wears which chip — moved to §12, because the
    // rows moved to the rollup card. The vocabulary itself is shared by both grains and stays here.
  });

  it('draws the coin as an icon component, never as a "$" glyph doing duty as one', () => {
    // The SPA ships no icon library and no icon glyphs; the currency symbol belongs in the FIGURE,
    // where it is part of the number's meaning.
    expect(sourceOf('components/Icons.tsx')).toContain('export function CoinIcon');
    // ⚠ AND IT MOVED WITH THE MONEY. The coin now heads the WORKSPACE cost block; a `$` character
    // left behind as a heading would be unsizable, unthemeable and unhoverable, which is the rule
    // the whole icon catalogue exists for.
    expect(panelSource()).toContain('<CoinIcon');
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   10. Cost at the WORKSPACE grain — the live money surface
       One subscription, one card, one figure whose numerator and denominator describe the same
       repositories. Every rule the retired block carried is inherited here and asserted again
       independently, plus the one this grain adds: the card carries TWO acted-on rates over TWO
       populations, and they must never share a row.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('the Workspace cost block', () => {
  it('is ABSENT for a reviewer nobody priced — not empty, not zero, not a prompt', () => {
    // ⚠ THE RULE THE WHOLE FEATURE TURNS ON, and it survived the grain change unchanged. `cost` is
    // optional on the rollup and the card branches on its presence: a "set a price" placeholder or
    // a US$0.00 row would both be a surface making a claim the data cannot support. A stored 0 is a
    // DIFFERENT state — a real price somebody recorded as free — and it arrives with a cost block
    // whose arms refuse `price_is_zero`.
    const unpriced = rollup({ cost: undefined });
    expect(unpriced.cost).toBeUndefined();
    expect(rollup().cost).toBeDefined();
    expect(workspaceCost({ monthlyUsd: 0 }).monthlyUsd).toBe(0);
  });

  it('states what the figure IS, unconditionally, and keeps only the caveat that is still true', () => {
    // ⚠ THE SUCCESSOR TO `costSharedNote`, AND THE REASON IT COULD SHRINK. The price and the work
    // now describe the same repositories, so "do not add these up" has nothing left to warn about —
    // there is one card. What survives is the caveat this app genuinely cannot see past: the same
    // subscription may cover repositories OUTSIDE this Workspace, so in that one direction the
    // figure is still an upper bound. Dropping the sentence because the big error was fixed would
    // leave the small one unstated.
    const note = workspaceCostCoverageNote(workspaceCost());
    expect(note).toMatch(/outside this Workspace/);
    expect(note).toMatch(/upper bound/);
    // ⚠ AND IT NO LONGER COUNTS CARDS OR TELLS ANYBODY NOT TO SUM THEM — there is one card, so that
    // instruction would describe a screen that does not exist.
    expect(note).not.toMatch(/cards/);
    expect(note).not.toBe(costSharedNote(costBlock()));
    // ⚠⚠ AND ITS FIRST HALF WENT TOO, WHICH IS THE POINT OF THIS ASSERTION. It argued that the price
    // and the work describe the same repositories "so there is nothing here to add together" — a
    // rebuttal of `BotBenchmarkPlacementUnit.cost`, which was DELETED FROM THE WIRE before any of
    // this shipped. A caveat answering a figure no response carries teaches a reader that these
    // numbers were once worth distrusting and gives them nothing to do about it.
    expect(note).not.toMatch(/nothing here to add together/);
    expect(note).not.toMatch(/Workspace price/);
    // ⚠ AND IT NO LONGER QUOTES THE ESTATE'S SIZE, because the clause that needed it is gone. The
    // count still rides the wire and the figure rows still name it.
    expect(note).not.toContain('4 repositories');
    expect(workspaceCostCoverageNote(workspaceCost({ coveredRepos: 1 }))).toBe(note);
  });

  it('discloses the two dropped-row cases as two SENTENCES, and stays quiet otherwise', () => {
    // ⚠ A MISSING DISCLOSURE IS THE SAME DEFECT AS A WRONG NUMBER, ONE LINE QUIETER — the rule
    // `costSeatZeroNote` already carries, at a new grain with two new causes. A repository whose
    // span could not be read contributed NOTHING to the per-month pace, so the pace understates; a
    // repository the host has held for less than the window is left out of the per-merged-PR
    // denominator alone, so leaving it in would INFLATE that figure, silently and in the direction
    // that flatters the finding. Neither is optional chrome.
    expect(workspaceCostSpanUnobservedNote(workspaceCost())).toBeNull();
    expect(workspaceCostPartialWindowNote(workspaceCost())).toBeNull();

    const span = workspaceCostSpanUnobservedNote(workspaceCost({ spanUnobservedRepos: 1 }));
    expect(span).toContain('1 repository');
    // ⚠⚠ IT WAS REWORDED, NOT KEPT, AND THAT IS THIS ASSERTION'S WHOLE JOB. It used to say these
    // repositories "contributed nothing to the per-month pace" and that no sibling's span was
    // "borrowed" — TRUE while the pace divided by each repository's observed comment stretch, and
    // FALSE the moment the money moved to a chosen calendar month. A caveat that no longer describes
    // the arithmetic is worse than no caveat: it is a wrong account of how the number was made, in
    // the voice of a disclosure. What is left is the smaller claim about the column it explains.
    expect(span).not.toMatch(/per-month pace/);
    expect(span).not.toMatch(/borrowed/);
    expect(span).toMatch(/observation period/);
    expect(span).toMatch(/fixed window at both ends/);

    const partial = workspaceCostPartialWindowNote(workspaceCost({ partialWindowRepos: 1 }));
    expect(partial).toMatch(/cost per merged pull request/);
    expect(partial).toContain('14 days');
    // The exclusion is from ONE denominator, and the sentence says the rest of the card still counts
    // it — otherwise a reader reasonably concludes the whole repository was dropped.
    expect(partial).toMatch(/Everything else on this card still includes it/);

    // ⚠ TWO CAUSES, TWO REMEDIES, TWO SENTENCES. Collapsing them is the defect every vocabulary on
    // this tab exists to prevent.
    expect(partial).not.toBe(span);
    // Plurals read as English on both.
    expect(workspaceCostSpanUnobservedNote(workspaceCost({ spanUnobservedRepos: 2 }))).toContain(
      '2 repositories',
    );
    expect(workspaceCostPartialWindowNote(workspaceCost({ partialWindowRepos: 2 }))).toMatch(
      /held them for less than/,
    );
  });

  it('collapses three identical refusals into one, and keeps a mix in full', () => {
    // ⚠ THREE ARMS, NOT FOUR, AND THAT IS THE GRAIN CHANGE SHOWING THROUGH. `collapsedCostRefusal`
    // folded the counterfactual in because a refused counterfactual would otherwise delete the
    // headline's second sentence with nothing said; here the counterfactual is a SIBLING section
    // that states its own refusal in full, in the server's own words, a few elements below.
    const zero = refused('price_is_zero');
    expect(
      collapsedWorkspaceCostRefusal(
        workspaceCost({ perMergedPr: zero, unacted: zero, yours: zero }),
      ),
    ).toBe('price_is_zero');

    // ⚠ AND IT COLLAPSES WITHOUT LOOKING AT THE EXPECTATION AT ALL. A vendor the corpus has never
    // measured refuses its comparison for a reason that has nothing to do with the price, and that
    // must not stop three identical price refusals reading as one sentence.
    expect(
      collapsedWorkspaceCostRefusal(
        workspaceCost({ perMergedPr: zero, unacted: zero, yours: zero }),
      ),
    ).toBe('price_is_zero');

    // A MIX says different things about where the blind spot is and keeps its full list.
    expect(
      collapsedWorkspaceCostRefusal(
        workspaceCost({
          perMergedPr: refused('no_merges_in_window'),
          unacted: refused('span_unobserved'),
          yours: refused('own_rate_withheld'),
        }),
      ),
    ).toBeNull();
    // Two of three sharing a reason is still a mix.
    expect(
      collapsedWorkspaceCostRefusal(
        workspaceCost({ perMergedPr: zero, unacted: zero, yours: refused('own_rate_withheld') }),
      ),
    ).toBeNull();
    // ⚠ `unacted` IS IN THE LIST EVEN THOUGH IT HAS NO ROW OF ITS OWN — it is the headline's first
    // sentence, and a collapse blind to it would fold two rows into one line while the headline
    // above them vanished for a third reason nobody was told about. Mutation-tested: dropping
    // `cost.unacted` from the arm list turns this line green when it must be red.
    expect(
      collapsedWorkspaceCostRefusal(
        workspaceCost({ perMergedPr: zero, unacted: refused('span_unobserved'), yours: zero }),
      ),
    ).toBeNull();
    // …and a block with any real figure in it never collapses.
    expect(collapsedWorkspaceCostRefusal(workspaceCost())).toBeNull();
  });

  /* ── The headline: two sentences, three tones, TWO POPULATIONS ───────────────────────────── */

  it('names the POOLED population in the measured sentence and the FITTED subset in the comparison', () => {
    // ⚠⚠ THE RULE THIS WHOLE FEATURE IS MOST LIKELY TO BREAK, and the one docs/PERIOD-REPORTING.md
    // says shipped three times before it was believed. `unacted.actedOnRate` is Σ acted ÷ Σ settled
    // over EVERY live repository; `expectation.yoursRateOnFitted` is over the repositories whose
    // cohort published a median. Here they are 26% and 41% — different numbers about the same
    // reviewer — and each sentence must quote its own denominator and carry NEITHER of the other's
    // figures.
    const cost = workspaceCost();
    const exp = expectation();
    // The fixture is only a test of this rule while the two rates disagree. Pinned, so a later
    // "tidy" of the fixture cannot quietly make the assertions below vacuous.
    expect(cost.unacted.status === 'value' && cost.unacted.actedOnRate).toBe(0.26);
    expect(exp.status === 'value' && exp.yoursRateOnFitted).toBe(0.41);

    const head = workspaceCostHeadline(cost, exp);
    expect(head?.tone).toBe('behind');

    // Sentence one: the POOLED rate, its own repository count, its own thread count, its own money.
    expect(head?.spend).toContain('US$88.80');
    expect(head?.spend).toMatch(/is buying feedback nobody acts on/);
    expect(head?.spend).toContain('4 repositories');
    expect(head?.spend).toContain('26%');
    expect(head?.spend).toContain('100 threads');
    expect(head?.spend).not.toContain('41%');
    expect(head?.spend).not.toContain('58%');
    expect(head?.spend).not.toContain('US$20.40');

    // Sentence two: the FITTED subset, named BEFORE either rate is stated — that clause is the only
    // thing standing between the reader and reading 41% as the figure sentence one just quoted.
    const cmp = head?.comparison ?? '';
    expect(cmp).toContain('3 repositories with a fitted peer median');
    expect(cmp.indexOf('fitted peer median')).toBeLessThan(cmp.indexOf('41%'));
    expect(cmp).toContain('41%');
    expect(cmp).toContain('58%');
    expect(cmp).toContain('US$20.40');
    expect(cmp).not.toContain('26%');
    expect(cmp).not.toContain('US$88.80');
    expect(cmp).not.toContain('4 repositories');

    // ⚠ AND THE TWO RATES ARE NAMED SIDE BY SIDE, NEVER SUBTRACTED. "17 points behind" is a derived
    // finding this panel did not earn; the only licensed difference of two rates is the SERVER's
    // `conversionGapUsd`, which arrives already computed over ONE population.
    expect(cmp).not.toContain('17%');
    expect(cmp).not.toMatch(/points? (behind|ahead|below|above)/i);
    // ⚠ AND IT IS A COUNTERFACTUAL, NOT A PEER'S BILL — the median of a product is not the product
    // of the medians, so "what a peer pays" would be a figure nobody fitted.
    expect(cmp).toMatch(/your threads and your price, their engagement/);
    expect(cmp).not.toMatch(/peers? pays?|peer cost|a peer would pay/i);
  });

  it('does not word a NEGATIVE gap as waste, and cannot exceed the price it is a share of', () => {
    // ⚠ THE UNBOUNDED-BRANCH DEFECT, AT THE NEW GRAIN. The ratio form of this figure once rendered
    // −4.1 × the spend AS MONEY. The server's figure is a difference of two RATES times the monthly
    // price, so it is bounded in [−monthlyUsd, monthlyUsd] structurally rather than by a clamp; this
    // pins the renderer's half — no minus sign in the sentence, and no "wasted".
    const head = workspaceCostHeadline(
      workspaceCost(),
      expectation({ yoursRateOnFitted: 0.8, expectedRate: 0.2, conversionGapUsd: -72 }),
    );
    expect(head?.tone).toBe('ahead');
    expect(head?.comparison).toContain('US$72.00');
    expect(head?.comparison).not.toContain('-US$');
    expect(head?.comparison).not.toMatch(/nobody acts on/);
    expect(72).toBeLessThanOrEqual(120);
    // …and the measured sentence still stands, saying what the price still buys unacted.
    expect(head?.spend).toContain('US$88.80');
  });

  it('has a third tone for an estate sitting exactly at its cohorts’ medians', () => {
    // Neither waste nor a win: "0.00 more would be acted on" is a sentence that reads as a defect,
    // so the even case gets its own words.
    const head = workspaceCostHeadline(workspaceCost(), expectation({ conversionGapUsd: 0 }));
    expect(head?.tone).toBe('even');
    expect(head?.comparison).toMatch(/convert none of that price differently/);
    expect(head?.comparison).not.toContain('US$0.00');
  });

  it('keeps the MEASURED sentence when the comparison refused — including for a vendor the corpus has never seen', () => {
    // ⚠ THE POINT OF MAKING THE EXPECTATION A SIBLING RATHER THAN AN ARM. Sonar, GitHub Advanced
    // Security and `github-actions` are the multi-repo reviewers a real Workspace actually runs and
    // NONE of them is in the seven-vendor corpus — so this is the COMMON card, not the edge case. A
    // corpus that never measured a brand is a fact about the corpus and must not delete the
    // customer's own money figure, which needs nothing but their data.
    const head = workspaceCostHeadline(workspaceCost(), rollupRefused('vendor_not_in_corpus'));
    expect(head?.tone).toBe('measured');
    expect(head?.spend).toContain('US$88.80');
    expect(head?.comparison).toBeNull();

    // ⚠ AND THE SAME WHEN THE RATES SURVIVE BUT THE MONEY HALVES WENT QUIET — a truncated estate,
    // or a price that could not be stated. The rates are still on the card, in the expectation's own
    // sentence; what may not happen is a comparison whose money is missing rendering as a gap of
    // nothing.
    const noMoney = workspaceCostHeadline(
      workspaceCost(),
      expectation({
        conversionGapUsd: null,
        perActedOnUsd: null,
        moneyRefusal: refused('workspace_truncated'),
      }),
    );
    expect(noMoney?.tone).toBe('measured');
    expect(noMoney?.comparison).toBeNull();
    expect(noMoney?.spend).toContain('US$88.80');
  });

  it('has no headline at all when the MEASURED half itself cannot be written', () => {
    // Sentence one is the PRECONDITION, not the comparison: a comparison with no left-hand side is
    // not a headline.
    expect(workspaceCostHeadline(workspaceCost({ unacted: refused('own_rate_withheld') }), expectation()))
      .toBeNull();
    // ⚠ AND A PRICE THAT COULD NOT BE STATED TAKES IT TOO. `monthlyUsd: null` is a price somebody
    // ENTERED whose per-seat unit could not be multiplied out; running it through `formatUsd` would
    // print "US$0.00 monthly price", which is the exact false claim the seat-count drop exists to
    // prevent.
    expect(
      workspaceCostHeadline(workspaceCost({ monthlyUsd: null, windowUsd: null }), expectation()),
    ).toBeNull();
  });

  it('reuses the SAME seat disclosures at both grains, rather than wording them twice', () => {
    // ⚠ ONE SUBSCRIPTION, ONE EXPLANATION. A second copy of these would let "your per-seat price is
    // left out" and "your Workspace has no human authors" be worded two different ways depending on
    // which card the reader is standing on — and those two are already the pair this tab most needs
    // kept apart.
    expect(costPricedReviewersNote(workspaceCost())).toBeNull();
    expect(costPricedReviewersNote(workspaceCost({ pricedReviewers: 2 }))).toBe(
      costPricedReviewersNote(costBlock({ pricedReviewers: 2 })),
    );
    expect(costSeatUnresolvedNote(workspaceCost({ seatPriceUnresolved: 1 }))).toBe(
      costSeatUnresolvedNote(costBlock({ seatPriceUnresolved: 1 })),
    );
    expect(costSeatZeroNote(workspaceCost({ seatCountZero: 1 }))).toBe(
      costSeatZeroNote(costBlock({ seatCountZero: 1 })),
    );
    // …and the two per-seat cases are still different sentences at this grain.
    expect(costSeatZeroNote(workspaceCost({ seatCountZero: 1 }))).not.toBe(
      costSeatUnresolvedNote(workspaceCost({ seatPriceUnresolved: 1 })),
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   11. The rollup vocabulary — coverage, spread, expectation, evidence, order
   ───────────────────────────────────────────────────────────────────────────────────────── */

const ROLLUP_REASONS: readonly BotBenchmarkRollupRefusalReason[] = [
  'single_repo',
  'no_placed_repos',
  'no_fitted_cohort_rate',
  'no_settled_threads',
  'vendor_not_in_corpus',
];

describe('the rollup refusal vocabulary', () => {
  it('has a sentence for every member and no more, and says something DIFFERENT for each', () => {
    for (const r of ROLLUP_REASONS) expect(ROLLUP_REFUSAL_HEADLINE[r], r).toBeTruthy();
    expect(Object.keys(ROLLUP_REFUSAL_HEADLINE).sort()).toEqual([...ROLLUP_REASONS].sort());
    expect(new Set(Object.values(ROLLUP_REFUSAL_HEADLINE)).size).toBe(ROLLUP_REASONS.length);
  });

  it('reuses the placement’s OWN words for the one fact both refuse on, and only that one', () => {
    // ⚠ TWO SENTENCES FOR ONE CAUSE ON ONE SCREEN IS HOW A READER STOPS BELIEVING EITHER — the rule
    // `COST_REFUSAL_HEADLINE` already keeps for `no_merges_in_window`. "We have never measured this
    // reviewer" is the same fact whether it is refusing a band or refusing a spread.
    expect(ROLLUP_REFUSAL_HEADLINE.vendor_not_in_corpus).toBe(
      PLACEMENT_REFUSAL_HEADLINE.vendor_not_in_corpus_vocabulary,
    );
    // ⚠ AND THE OTHER FOUR JOIN THE ONE POOL. A reader meets a rollup refusal on the same screen as
    // a placement refusal, an exclusion and the empty-findings sentence, so a collision between any
    // two of them is the same defect wherever it comes from. `vendor_not_in_corpus` is the ONE
    // deliberate collision, excluded here and asserted above instead.
    const pool = [
      ...PLACEMENT_REASONS.map((r) => PLACEMENT_REFUSAL_HEADLINE[r]),
      ...UNAVAILABLE_REASONS.map((r) => UNAVAILABLE_HEADLINE[r]),
      ...EXCLUSION_REASONS.map((r) => EXCLUSION_HEADLINE[r]),
      FINDINGS_EMPTY_HEADLINE.nothing_comparable,
      ...ROLLUP_REASONS.filter((r) => r !== 'vendor_not_in_corpus').map(
        (r) => ROLLUP_REFUSAL_HEADLINE[r],
      ),
    ];
    expect(new Set(pool).size).toBe(pool.length);
  });

  it('never words a refusal as a zero or a failure — these are the COMMON cards', () => {
    // Sonar, GHAS and `github-actions` are all `vendor_not_in_corpus`, and their cards still carry
    // counters, an evidence table and a price. A sentence implying the reviewer scored badly, or
    // that the card broke, would be a false claim about most of a real estate.
    for (const r of ROLLUP_REASONS) {
      expect(ROLLUP_REFUSAL_HEADLINE[r], r).not.toMatch(/\b0\b|failed|error/i);
    }
  });
});

describe('how much of the estate a card speaks for', () => {
  it('always names BOTH numbers, and agrees with itself between the label and the title', () => {
    // ⚠ `liveInRepos` ALONE IS AN UNANCHORED COUNT — "live in 4" of what? — and `reposConsidered`
    // alone hides that the reviewer runs on half the estate. The pair is the denominator a reader
    // checks the evidence table against.
    expect(rollupCoverageLabel(rollup())).toBe('live in 4 of 8 repositories');
    expect(rollupTitle(rollup())).toBe('CodeRabbit — live in 4 of 8 repositories');
    expect(rollupTitle(rollup())).toContain(rollupCoverageLabel(rollup()));
    // Singular reads as English.
    expect(rollupCoverageLabel(rollup({ liveInRepos: 1, reposConsidered: 1 }))).toBe(
      'live in 1 of 1 repository',
    );
    // ⚠ AND THE REVIEWER IS NAMED EVEN WHEN THE CORPUS HAS NEVER SEEN IT. An unbranded reviewer is
    // still this Workspace's biggest, and "Bot" is the honest label — never nothing, which would
    // read as a person.
    expect(rollupTitle(rollup({ botKind: null, vendor: null }))).toContain('Bot —');
  });
});

describe('the spread sentence', () => {
  it('says nothing at all when there is nothing placed', () => {
    // ⚠ THE SERVER REFUSES `no_placed_repos` HERE, so this is belt-and-braces on a shape that should
    // not arrive — but "sits below it in 0" over an empty subset is the exact reading this whole
    // panel refuses to produce.
    expect(rollupSpreadSentence(spread({ placed: 0, below: 0, at: 0, above: 0 }))).toBeNull();
    expect(rollupSpreadSentence(rollupRefused('no_placed_repos'))).toBeNull();
    // A refusal renders its own headline and the server's message instead — never a zeroed spread.
    expect(rollupSpreadSentence(rollupRefused('single_repo'))).toBeNull();
  });

  it('reads as English at one placed repository', () => {
    const s = rollupSpreadSentence(spread({ placed: 1, below: 1, at: 0, above: 0 }));
    expect(s).toContain('1 repository placed');
    expect(s).not.toContain('1 repositories');
    expect(s).toContain('below it in 1');
  });

  it('names EVERY non-zero side, not just the largest', () => {
    // ⚠ "BELOW THE MEDIAN IN 5 OF 6" READS AS A CLEAN STORY AND HIDES THE ONE ABOVE IT. The counts
    // are the finding; a summary that drops the minority side is a summary that chose an answer.
    const s = rollupSpreadSentence(spread({ placed: 6, below: 5, at: 0, above: 1 })) ?? '';
    expect(s).toContain('below it in 5');
    expect(s).toContain('above it in 1');
    const three = rollupSpreadSentence(spread({ placed: 6, below: 3, at: 1, above: 2 })) ?? '';
    expect(three).toContain('below it in 3');
    expect(three).toContain('level with it in 1');
    expect(three).toContain('above it in 2');
  });

  it('quotes the PLACED subset as its denominator, never the card’s coverage', () => {
    // ⚠ ONLY A REPOSITORY THAT WAS PLACED **AND** WHOSE ACTED-ON RATE COMPARED HOLDS A PERCENTILE,
    // so `placed` is routinely smaller than `liveInRepos`. Quoting the wrong one turns a partial
    // comparison into a claim about the whole estate — the same mixing rule as the two rates, in a
    // different sentence.
    const card = rollup({ liveInRepos: 9, spread: spread({ placed: 3, below: 2, at: 0, above: 1 }) });
    const s = rollupSpreadSentence(card.spread) ?? '';
    expect(s).toContain('3 repositories placed with a comparable acted-on rate');
    expect(s).not.toContain('9');
  });
});

describe('the expectation sentence', () => {
  it('names its subset and BOTH rates, and never subtracts them', () => {
    const s = rollupExpectationSentence(expectation()) ?? '';
    expect(s).toContain('3 repositories with a fitted peer median');
    expect(s.indexOf('fitted peer median')).toBeLessThan(s.indexOf('41%'));
    expect(s).toContain('41%');
    expect(s).toContain('58%');
    // ⚠ SIDE BY SIDE, NEVER A DIFFERENCE. 58 − 41 = 17 is a finding this panel did not earn.
    expect(s).not.toContain('17%');
    expect(s).not.toMatch(/points? (behind|ahead|below|above)/i);
    // ⚠ AND IT IS A COUNTERFACTUAL, NOT A PEER'S BILL.
    expect(s).toMatch(/an estate of this shape at its cohorts' medians/);
    expect(s).not.toMatch(/peers? pays?|a peer would pay/i);
  });

  it('says which repositories are OUTSIDE both figures, and that the pooled rate is a different number', () => {
    // ⚠ THE ONE SENTENCE THAT CAN BE READ AS COVERING THE WHOLE CARD, so it closes by saying it does
    // not. `excludedRepos` is published rather than left to `liveInRepos − fittedRepos` precisely so
    // this clause can exist.
    const one = rollupExpectationSentence(expectation({ excludedRepos: 1 })) ?? '';
    expect(one).toContain('The other 1 repository');
    expect(one).toContain('carries no fitted median and is');
    expect(one).toMatch(/pooled rate above covers every one of them and is a different number/);
    // Plural agreement — "the other 2 repository … carries" is the kind of line that makes a reader
    // stop trusting the arithmetic beside it.
    const two = rollupExpectationSentence(expectation({ excludedRepos: 2 })) ?? '';
    expect(two).toContain('The other 2 repositories');
    expect(two).toContain('carry no fitted median and are');
    // …and when nothing is excluded there is no clause at all, rather than "the other 0".
    const none = rollupExpectationSentence(expectation({ excludedRepos: 0 })) ?? '';
    expect(none).not.toContain('The other');
    expect(none).not.toContain('0 repositories');
  });

  it('renders nothing on a refusal, leaving the server’s own words to say why', () => {
    for (const r of ROLLUP_REASONS) {
      expect(rollupExpectationSentence(rollupRefused(r)), r).toBeNull();
    }
  });
});

describe('the evidence table', () => {
  it('renders a withheld rate as a dash, NEVER as a zero', () => {
    // ⚠ 0% AND "0th" ARE BOTH REAL READINGS, which is what makes them dangerous here: a repository
    // whose own metric was gated (`below_min_units` and friends) has no printable rate, and a
    // repository that was not compared has no rank. The COUNTS behind them still pool into the
    // card's headline, because pooling is the remedy for a thin sample — which is why the gate
    // applies to the ROW and not to the fold.
    const rows = contributionRows([contribution({ actedOnRate: null, percentile: null })]);
    expect(rows[0]?.actedOn).toBe('—');
    expect(rows[0]?.percentile).toBe('—');
    expect(rows[0]?.actedOn).not.toBe('0%');
    expect(rows[0]?.percentile).not.toBe('0th');
    // A real zero is still printed as a zero — the dash means WITHHELD, and that only works while
    // a measured 0 is visibly different.
    const zero = contributionRows([contribution({ actedOnRate: 0, percentile: 0 })]);
    expect(zero[0]?.actedOn).toBe('0%');
    expect(zero[0]?.percentile).toBe('0th');
  });

  it('keeps a refused placement’s row, naming its reason where the band would be', () => {
    // ⚠ THE REPOSITORY IS LIVE, IT CONTRIBUTED COUNTS, AND IT IS PART OF THE ESTATE THE MONEY IS
    // DIVIDED BY. Dropping it would make the table disagree with the card's own "live in 4 of 8" —
    // which is exactly the disagreement a reader is meant to be able to catch here.
    const rows = contributionRows([
      contribution({ band: null, placementRefusal: 'repo_window_incomplete' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bandRefused).toBe(true);
    expect(rows[0]?.band).toBe(PLACEMENT_REFUSAL_HEADLINE.repo_window_incomplete);
    // …and a placed row carries its band WITH its denominator: "band 6" is honest at 10 bands and a
    // misrepresentation at 3.
    const placed = contributionRows([contribution()]);
    expect(placed[0]?.bandRefused).toBe(false);
    expect(placed[0]?.band).toBe('Band 6 of 10');
  });

  it('keeps the fold’s own order and keys on the repository, never on a figure', () => {
    // ⚠ A TABLE ORDERED BY ACTED-ON RATE IS A RANKING OF REPOSITORIES NOBODY ASKED FOR, and it would
    // move rows between refetches — the same rule `orderedRollups` keeps for the cards themselves.
    const rows = contributionRows([
      contribution({ repoId: 3, repoName: 'zeta', actedOnRate: 0.9 }),
      contribution({ repoId: 1, repoName: 'alpha', actedOnRate: 0.1 }),
      contribution({ repoId: 2, repoName: 'mid', actedOnRate: 0.5 }),
    ]);
    expect(rows.map((r) => r.repo)).toEqual(['acme/zeta', 'acme/alpha', 'acme/mid']);
    expect(rows.map((r) => r.key)).toEqual(['3', '1', '2']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    expect(rows[0]?.mergedPrs).toBe('22');
  });
});

describe('one cause, one paragraph', () => {
  // ⚠ WHY THIS EXISTS. On a real two-repository GHAS card the string "We have never measured this
  // reviewer" appeared FOUR times: once refusing the spread, once refusing the expectation — two
  // identical three-line paragraphs, one directly under the other — and once in each evidence row's
  // band cell. It is the commonest card in a real estate, because most reviewers a workspace runs
  // are not in the corpus. A refusal that looks like a rendering bug spends the credibility the
  // refusal is entirely made of.
  const refusedSpread = (
    reason: BotBenchmarkRollupRefusalReason,
  ): BotBenchmarkRollupSpread => ({ status: 'refused', reason, message: `spread: ${reason}` });
  const refusedExpectation = (
    reason: BotBenchmarkRollupRefusalReason,
  ): BotBenchmarkRollupExpectation => ({
    status: 'refused',
    reason,
    message: `expectation: ${reason}`,
  });

  it('collapses to ONE note when the same reason disqualifies both comparisons', () => {
    const shared = sharedComparisonRefusal(
      refusedSpread('vendor_not_in_corpus'),
      refusedExpectation('vendor_not_in_corpus'),
    );
    expect(shared).not.toBeNull();
    expect(shared?.reason).toBe('vendor_not_in_corpus');
    // The message is the spread's — they are the same sentence by construction, and picking one
    // deliberately beats concatenating two.
    expect(shared?.message).toBe('spread: vendor_not_in_corpus');
  });

  it('keeps BOTH notes when the two refuse for DIFFERENT reasons — two facts, two remedies', () => {
    // ⚠ THE CASE THE COLLAPSE MUST NOT SWALLOW. "Nothing was placed" and "no cohort published a
    // median" have different causes and different things a reader could do about them; merging
    // them would delete one of the two.
    expect(
      sharedComparisonRefusal(
        refusedSpread('no_placed_repos'),
        refusedExpectation('no_fitted_cohort_rate'),
      ),
    ).toBeNull();
  });

  it('never collapses when either side actually has a value', () => {
    expect(sharedComparisonRefusal(spread(), refusedExpectation('vendor_not_in_corpus'))).toBeNull();
    expect(sharedComparisonRefusal(refusedSpread('vendor_not_in_corpus'), expectation())).toBeNull();
    expect(sharedComparisonRefusal(spread(), expectation())).toBeNull();
  });

  it('classifies a row’s refusal as vendor-wide ONLY when the card note already covers it', () => {
    // ⚠ THE TWO ENUMS ARE NOT THE SAME ENUM. `vendor_not_in_corpus` (rollup) and
    // `vendor_not_in_corpus_vocabulary` (placement) are one fact under two names, so the row can
    // never be silenced by comparing the two reasons for equality — hence a classification.
    const vendorWide = contributionRows([
      contribution({ band: null, placementRefusal: 'vendor_not_in_corpus_vocabulary' }),
    ]);
    expect(vendorWide[0]?.refusalIsVendorWide).toBe(true);

    // ⚠ AND A REPOSITORY-LEVEL REFUSAL KEEPS ITS ROW'S WORDS. "This repository is too new to place"
    // is true of ONE repository; nothing else on the card says it, so silencing it would delete the
    // only statement of a real fact — the opposite defect to the one being fixed.
    for (const reason of ['repo_window_incomplete', 'repo_inactive_in_window', 'cell_not_in_corpus'] as const) {
      const rows = contributionRows([contribution({ band: null, placementRefusal: reason })]);
      expect(rows[0]?.refusalIsVendorWide, reason).toBe(false);
    }
    // A PLACED row is not a refusal at all.
    expect(contributionRows([contribution()])[0]?.refusalIsVendorWide).toBe(false);
  });

  it('silences the band cell only under BOTH conditions, and the panel says so in one place', () => {
    // A source guard, because this suite has no renderer: the cell must test the card-level note
    // AND the row's own classification. Either alone is a bug — `statedRefusal` alone would blank a
    // repository-level reason nothing else states, and `refusalIsVendorWide` alone would blank a
    // reason on a card whose two comparisons refused separately and therefore never printed it.
    const panel = panelSource();
    expect(panel).toMatch(/statedRefusal != null && row\.refusalIsVendorWide/);
    expect(panel).toMatch(/statedRefusal=\{shared\?\.reason \?\? null\}/);
  });
});

describe('the card leads with its answer, not with its workings', () => {
  it('orders the card cost → comparisons → evidence → counters', () => {
    // ⚠ TWENTY-FIVE RAW FITTER COUNTERS WERE THE FIRST THING ON EVERY CARD, above the price and
    // above both comparisons, so the card opened with its arithmetic and buried what it was for.
    // They are still published in full — the additivity invariant is only checkable against a
    // complete list — but last, and folded.
    const panel = panelSource();
    const at = (needle: string) => {
      const i = panel.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const card = panel.slice(at('function RollupCard'));
    const order = ['<WorkspaceCostBlock', 'benchmark-rollup-spread', 'benchmark-rollup-expectation', '<EvidenceTable', '<PooledCounters'];
    const positions = order.map((n) => {
      const i = card.indexOf(n);
      expect(i, n).toBeGreaterThan(-1);
      return i;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('folds the counters shut by default — demoted, never hidden', () => {
    // ⚠ FOLDED, NOT DROPPED. An audit trail one click away is still an audit trail; a curated
    // shortlist would make the card's own sums uncheckable against the evidence table.
    const panel = panelSource();
    const block = panel.slice(panel.indexOf('function PooledCounters'));
    expect(block).toMatch(/useState\(false\)/);
    expect(block).toContain('data-testid="benchmark-rollup-counters-toggle"');
    expect(block).toMatch(/COUNTER_GROUPS\.map/);
  });

  it('names each counter group’s POPULATION, because two of them share a key and disagree', () => {
    // ⚠ `volume.commentsObserved` AND `outcome.commentsObserved` ARE DIFFERENT NUMBERS — 22 and 53
    // on one real reviewer — because volume is merged PRs only and outcome is merged or not. Under
    // bare headings that reads as a contradiction, and so does "Threads 18" beside "Threads settled
    // 38". A reader who spots an apparent contradiction stops believing the rest of the card.
    const panel = panelSource();
    expect(panel).toMatch(/volume: \{ label: 'Volume', population: 'merged PRs only' \}/);
    expect(panel).toMatch(/outcome: \{ label: 'Thread outcomes', population: 'merged or not' \}/);
    expect(panel).toMatch(/\{meta\.population\}/);
  });
});

describe('the card order is stable and is NOT a league table', () => {
  it('puts cards with a spread first, whatever their labels sort to', () => {
    // A card with a comparison is the one a reader came for; a card whose cohort refused has nothing
    // to compare and reads as a footnote.
    const withSpread = rollup({ key: 'zzz', botKind: 'coderabbit' });
    const noSpread = rollup({ key: 'aaa', botKind: null, spread: rollupRefused('no_placed_repos') });
    expect(orderedRollups([noSpread, withSpread]).map((r) => r.key)).toEqual(['zzz', 'aaa']);
  });

  it('then by reviewer label, then by key — so two unbranded bots never swap places', () => {
    const cr = rollup({ key: 'k-cr', botKind: 'coderabbit' });
    const gr = rollup({ key: 'k-gr', botKind: 'greptile' });
    expect(orderedRollups([gr, cr]).map((r) => r.key)).toEqual(['k-cr', 'k-gr']);

    // ⚠ TWO UNBRANDED REVIEWERS BOTH LABEL AS "Bot", so the key is the only thing left to break the
    // tie — and without it their order would depend on the server's fold order, which changes when a
    // repository goes quiet.
    const sonar = rollup({ key: 'sonar', botKind: null, vendor: null });
    const ghas = rollup({ key: 'ghas', botKind: null, vendor: null });
    expect(orderedRollups([sonar, ghas]).map((r) => r.key)).toEqual(['ghas', 'sonar']);
    expect(orderedRollups([ghas, sonar]).map((r) => r.key)).toEqual(['ghas', 'sonar']);
  });

  it('never orders by a figure, however lopsided the money is', () => {
    // ⚠ ORDERING BY SPEND, BY ACTED-ON RATE OR BY CONVERSION GAP WOULD PUBLISH A LEAGUE TABLE OF THE
    // CUSTOMER'S VENDORS THAT NOTHING IN THE DATA SUPPORTS: the cards' cohorts are different and
    // their prices are typed in by hand. `orderedUnits` refuses the same temptation one grain down.
    const cheapBad = rollup({
      key: 'k-cr',
      botKind: 'coderabbit',
      cost: workspaceCost({ monthlyUsd: 5 }),
      expectation: expectation({ conversionGapUsd: 1 }),
    });
    const dearGood = rollup({
      key: 'k-gr',
      botKind: 'greptile',
      cost: workspaceCost({ monthlyUsd: 5000 }),
      expectation: expectation({ conversionGapUsd: 4000 }),
    });
    expect(orderedRollups([dearGood, cheapBad]).map((r) => r.key)).toEqual(['k-cr', 'k-gr']);
  });

  it('resolves each card’s identity ONCE, and keys on the Workspace vendor key', () => {
    // ⚠ THE LANDMINE THIS FUNCTION EXISTS FOR. `unitTitle` is `owner/name` and is the unit card's
    // key; a rollup card has n repositories and would collide with itself on that. And it cannot key
    // on `vendor` either, which is `null` for every brand the corpus has never seen — most of the
    // reviewers a real Workspace runs — so n unbranded reviewers would collapse onto ONE card.
    const sonar = rollup({ key: 'sonar', botKind: null, vendor: null });
    const ghas = rollup({ key: 'ghas', botKind: null, vendor: null });
    const rows = rollupRows([sonar, ghas]);
    expect(rows.map((r) => r.key)).toEqual(['ghas', 'sonar']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows.every((r) => r.label === 'Bot')).toBe(true);
    // The identity is resolved here so no renderer re-derives a label or invents a key.
    const one = rollupRows([rollup()])[0];
    expect(one?.key).toBe('coderabbit');
    expect(one?.title).toBe('CodeRabbit — live in 4 of 8 repositories');
    expect(one?.coverage).toBe('live in 4 of 8 repositories');
    expect(one?.color).not.toBeNull();
    // …and it is exactly `orderedRollups` with identity attached, so the two cannot drift.
    expect(rollupRows([ghas, sonar]).map((r) => r.rollup)).toEqual(orderedRollups([ghas, sonar]));
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   12. SOURCE GUARDS — the grain split, on the render side
       There is no DOM in this suite (see the file header), so these read the components' source.
       Each one is anchored on the thing that would be WRONG if it changed, never on formatting.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe('money lives on exactly one side of the grain split', () => {
  it('decides the grain from the PROP, not from the payload', () => {
    // ⚠ BRANCHING ON `data.rollup != null` WOULD LET A VERSION SKEW SILENTLY CHANGE WHICH SCREEN THE
    // READER IS LOOKING AT — an older plugin serving no rollup would quietly turn the rail into a
    // list of per-repository cards, which is the screen this whole change removed.
    const panel = panelSource();
    expect(panel).toMatch(/isRail=\{repoId == null\}/);
    expect(panel).toMatch(/isRail: boolean;/);
    expect(panel).not.toMatch(/isRail=\{data[.?]/);
    // The rail draws rollups; anything else draws that repository's own placements. One of each.
    expect(panel.match(/<RollupCard/g)).toHaveLength(1);
    expect(panel.match(/<UnitCard/g)).toHaveLength(1);
    expect(panel.indexOf('{isRail ? (')).toBeGreaterThan(0);
    expect(panel.indexOf('<RollupCard')).toBeGreaterThan(panel.indexOf('{isRail ? ('));
    expect(panel.indexOf('<UnitCard')).toBeGreaterThan(panel.indexOf('<RollupCard'));
    // ⚠ AND THE RAIL SAYS SOMETHING when an older plugin serves units with no rollup, rather than
    // falling back to per-repository cards (which would reinstate the removed screen) or to a blank
    // (which is indistinguishable from a pane that never ran).
    expect(panel).toContain('testId="benchmark-no-rollup"');
  });

  it('tells an ABSENT rollup apart from an EMPTY one, in two different sentences', () => {
    // ⚠⚠ THE SERVER IS DELIBERATE ABOUT THIS DISTINCTION AND THE PANEL MUST NOT THROW IT AWAY. A
    // MISSING `rollup` key says the fold did not run (an older plugin); `rollup: []` says it ran and
    // dropped every card because no reviewer was live anywhere. `benchmark-placement.test.ts` pins
    // both server-side — one asserts `hasOwnProperty('rollup') === false`, another asserts
    // `toEqual([])` on a real estate that merged nothing.
    //
    // A single `rollups.length > 0 ? … : <older-build sentence>` collapsed them, so a reader whose
    // bots simply had not commented yet was told their BUILD was deficient and sent to chase a
    // deployment problem that does not exist. That is the ordinary state immediately after somebody
    // classifies a reviewer in Bots → Settings, which is exactly when this tab gets opened.
    const panel = panelSource();
    expect(panel).toContain('testId="benchmark-no-live-reviewers"');
    // The branch is on the RAW wire field, because `rollupRows(data?.rollup ?? [])` has already
    // erased the difference by the time it is a row array.
    expect(panel).toMatch(/data\.rollup == null \?/);
    // Two distinct claims, and neither may be reachable from the other's cause.
    const older = panel.indexOf('testId="benchmark-no-rollup"');
    const empty = panel.indexOf('testId="benchmark-no-live-reviewers"');
    expect(older).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(older);
    const emptyBranch = panel.slice(empty, empty + 900);
    // ⚠ THE EMPTY SENTENCE MAY NOT BLAME THE BUILD — that is the false claim this test exists for.
    expect(emptyBranch).not.toMatch(/This build/);
    expect(emptyBranch).toMatch(/has commented/);
  });

  it('has DELETED the per-unit cost block rather than merely unmounting it', () => {
    // ⚠ AN UNMOUNTED COMPONENT IS AN INVITATION. `BotBenchmarkPlacementUnit.cost` is off the wire
    // and the server sends no money at all on a repo-narrowed request, so a `CostBlock` left in the
    // file would be a ready-made way to put a Workspace price back on a repository's card — which is
    // the defect this change exists to remove, and which type-checks perfectly against an optional
    // field that is simply never populated.
    const panel = panelSource();
    expect(panel).not.toContain('function CostBlock(');
    expect(panel).not.toContain('<CostBlock');
    expect(panel).not.toContain('unit.cost');
    // The retired model functions are not imported here either — `costSharedNote`'s "upper bound"
    // sentence describes a screen that no longer exists.
    expect(panel).not.toMatch(/\bcostSharedNote\b/);
    expect(panel).not.toMatch(/\bcostHeadline\b/);
    expect(panel).not.toMatch(/\bcollapsedCostRefusal\b/);
  });

  it('mounts the Workspace cost block behind a presence check, and nothing else', () => {
    // ⚠ THE SUCCESSOR TO THE `{unit.cost != null && <CostBlock …>}` GUARD, and the same claim: with
    // no renderer in this suite, this line is the only thing between an unpriced reviewer and a
    // US$0.00 on screen. Mutation-tested: dropping the presence check turns this red.
    const panel = panelSource();
    expect(panel).toMatch(/\{rollup\.cost != null && \(/);
    expect(panel).toMatch(
      /<WorkspaceCostBlock cost=\{rollup\.cost\} expectation=\{rollup\.expectation\} \/>/,
    );
    expect(panel.match(/<WorkspaceCostBlock/g)).toHaveLength(1);
    // ⚠ AND THE COUNTERFACTUAL IS PASSED IN SEPARATELY, which is what lets a vendor the corpus has
    // never measured keep its money while only its comparison refuses.
    expect(panel).toMatch(/expectation: BotBenchmarkRollupExpectation;/);
  });

  it('has no formatUsd call reachable from the per-repository branch', () => {
    // ⚠ THE STRUCTURAL VERSION OF "NO MONEY ON A REPOSITORY'S CARD". Every currency call in this
    // file must sit inside the two WORKSPACE-grain components, which only `RollupCard` mounts and
    // only the rail renders. A `formatUsd` appearing anywhere else is a money figure on a screen
    // whose payload carries none — it would render `undefined` at best and a Workspace price
    // measured against one repository at worst.
    const panel = panelSource();
    const start = panel.indexOf('function WorkspaceCostBlock(');
    const end = panel.indexOf('const COUNTER_GROUPS');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // ⚠ NON-VACUITY FIRST. A loop over zero matches passes silently, so a rename of `formatUsd` —
    // or a delete of the whole cost block — would turn the assertion below into a no-op that reads
    // green. There are three currency calls on this card and there must be at least one.
    expect((panel.match(/formatUsd\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    for (const m of panel.matchAll(/formatUsd\(/g)) {
      expect(m.index, `formatUsd at ${m.index} is outside the Workspace cost components`)
        .toBeGreaterThan(start);
      expect(m.index).toBeLessThan(end);
    }
    // …and `UnitCard`, the per-repository card itself, holds no currency call at all. Sliced to the
    // Workspace block's DOCBLOCK rather than to its `function` keyword, because that docblock is
    // prose ABOUT money and would otherwise land inside the region this asserts is money-free.
    const cardStart = panel.indexOf('function UnitCard(');
    const cardEnd = panel.indexOf('WHAT THIS VENDOR COSTS PER UNIT OF WORK');
    // Both anchors asserted before they are used: a missing one silently makes `slice` measure the
    // wrong region, and this guard's whole value is the region it measures.
    expect(cardStart).toBeGreaterThan(0);
    expect(cardEnd).toBeGreaterThan(cardStart);
    const unitCard = panel.slice(cardStart, cardEnd);
    expect(unitCard.length).toBeGreaterThan(1000);
    expect(unitCard).not.toContain('formatUsd(');
    expect(unitCard).not.toContain('CostValueRow');
  });

  it('keeps the window label off both ratio rows, and names the pace each one divided by', () => {
    // ⚠ THE DEFECT: the two RATIO rows shipped suffixed with the window, so "Per merged PR" read
    // "US$5.52 per 14 days". Dollars per pull request and dollars per thread do not scale with the
    // window — both halves of the fraction scale together — so the suffix invites a reader to double
    // a figure that is identical at any window length. The figure prop of every value row is a bare
    // `formatUsd(...)`.
    const panel = panelSource();
    expect(panel).toMatch(/figure=\{formatUsd\(cost\.perMergedPr\.value\)\}/);
    expect(panel).toMatch(/figure=\{formatUsd\(cost\.yours\.perActedOnUsd\)\}/);
    // ⚠ THE COUNTERFACTUAL'S FIGURE NOW COMES OFF THE EXPECTATION, NOT OFF THE COST. That is the
    // sibling split: the comparison refuses on its own, so its money is its own field.
    expect(panel).toMatch(/figure=\{formatUsd\(expectation\.perActedOnUsd\)\}/);
    expect(panel).not.toMatch(/figure=\{`\$\{formatUsd\([^)]*\)\} \$\{window\}`\}/);
    // ⚠ AND THE MEASURED ROW'S DETAIL COMES FROM THE MODEL, so the sentence a reader divides can be
    // asserted without a renderer. It used to be built inline and ended "— about 32.7 a month",
    // where the 32.7 came from a 237-day observed span that appeared NOWHERE on the card; the row
    // now prints the two numbers the figure actually divides.
    expect(panel).toMatch(/detail=\{workspaceCostActedOnDetail\(cost, cost\.yours\)\}/);
    expect(panel).toMatch(/label=\{workspaceCostActedOnLabel\(cost\)\}/);
    expect(panel).not.toMatch(/formatThreadCount\(cost\.yours\.actedPerMonth\)\} a month/);
    // The counterfactual still names the counterfactual pace it divided by — its count is a swapped
    // factor rather than a measured one, so it cannot be read off the row above it.
    expect(panel).toMatch(/formatThreadCount\(expectation\.actedPerMonthAtPeer\)\} a month/);
  });

  it('makes the per-acted-on division CHECKABLE from the row a reader is looking at', () => {
    // ⚠ THE PROPERTY THE FIGURE THIS REPLACED DID NOT HAVE, and the reason the defect survived. The
    // card printed "US$783.00 a month", "255 of 544 threads acted on" and "US$23.94", and no
    // arithmetic over those three is consistent: the divisor was a 237-day comment span that no
    // component rendered. `783 ÷ 243 = 3.22` is now a sum a reader can do on the row.
    const cost = workspaceCost({ monthlyUsd: 783, coveredRepos: 1 });
    const yours = {
      status: 'value' as const,
      actedThreads: 243,
      settledThreads: 479,
      actedOnRate: 0.507307,
      actedPerMonth: 243,
      perActedOnUsd: 3.222222,
    };
    expect(workspaceCostActedOnDetail(cost, yours)).toBe(
      '243 of 479 threads acted on · US$783.00 a month',
    );
    // ⚠ "across 1 repository" IS DROPPED — that clause exists to make a POOLED figure legible and is
    // noise on a single-repository Workspace, where it invites the reader to wonder what the other
    // repositories were.
    expect(workspaceCostActedOnDetail(cost, yours)).not.toContain('repository');
    expect(workspaceCostActedOnDetail(workspaceCost({ monthlyUsd: 783 }), yours)).toContain(
      'across 4 repositories',
    );
    // ⚠ THE WINDOW IS SERVED, NEVER INLINED. A hard-coded "30" would go on printing 30 the day the
    // server's constant moves, on the one card whose claim is that both halves cover one month.
    expect(workspaceCostActedOnLabel(cost)).toBe('Per acted-on thread (last 30 days)');
    expect(
      workspaceCostActedOnLabel({ ...cost, costWindowDays: undefined }),
    ).toBe('Per acted-on thread');
  });

  it('gives the thin-month refusal its own words, not `nothing_acted_on`’s', () => {
    // ⚠ TWO FACTS, TWO REMEDIES. A whole and EMPTY month is a dormant reviewer; a whole month with
    // nine acted-on threads in it is a sample too thin to divide a price by, and the remedy is time.
    // Collapsing them would tell a team whose bot went quiet that they merely need a bigger sample.
    expect(COST_REFUSAL_HEADLINE.window_underpopulated).not.toBe(
      COST_REFUSAL_HEADLINE.nothing_acted_on,
    );
    expect(COST_REFUSAL_HEADLINE.window_underpopulated).toMatch(/month/);
  });

  it('discloses a repository younger than the cost window, and explains a WITHHELD figure', () => {
    // ⚠ THE THIRD DISCLOSURE, WITH THE THIRD CAUSE. A repository the host has held for less than the
    // cost window contributes a PARTIAL month of work against a WHOLE price, so the per-thread
    // figure would read too high — and excluding the repository would push it higher still, since
    // the price does not shrink with it. So the figure refuses and this says why.
    expect(workspaceCostWindowIncompleteNote(workspaceCost())).toBeNull();
    const note = workspaceCostWindowIncompleteNote(
      workspaceCost({ costWindowIncompleteRepos: 1 }),
    );
    expect(note).toContain('1 repository has been tracked');
    expect(note).toContain('30 days'); // rendered from the SERVER's `costWindowDays`, rounded
    expect(note).toMatch(/withheld rather than reported too high/);
    // ⚠ AND IT IS NOT THE FOURTEEN-DAY ONE. Two thresholds, two figures, two sentences: that note is
    // about a term LEFT OUT of `$ per merged PR`, this one about a figure that does not render.
    expect(note).not.toBe(workspaceCostPartialWindowNote(workspaceCost({ partialWindowRepos: 1 })));
    // ⚠ ASSERT THE VERB, NOT JUST THE NOUN. `countNoun` pluralises the noun; the verb beside it was
    // hard-coded singular, so this rendered "2 repositories has been tracked" and the old
    // assertion — `toContain('2 repositories')` — was GREEN over the broken sentence. A copy test
    // that stops at the interpolated value cannot see the words around it.
    expect(
      workspaceCostWindowIncompleteNote(workspaceCost({ costWindowIncompleteRepos: 2 })),
    ).toContain('2 repositories have been tracked');
  });

  it('puts the `fitted` chip on the counterfactual row and `counted` on the customer’s own', () => {
    // ⚠ THE TAB'S OWN RULE: a cohort-derived figure and a code-derived one must be labelled apart in
    // a panel that mixes them. The fitted median is the one that must never read as an invoice.
    // ⚠ THE TESTIDS MOVED WITH THE GRAIN ON PURPOSE — `benchmark-cost-*` became
    // `benchmark-workspace-cost-*` for every id whose CLAIM changed. Reusing the old names would
    // have let a test written against the per-repository grain stay green while asserting the old
    // claim about a new number.
    const panel = panelSource();
    expect(panel).toMatch(/testId="benchmark-workspace-cost-counterfactual"[\s\S]{0,900}basis="fitted"/);
    expect(panel).toMatch(/testId="benchmark-workspace-cost-per-merged-pr"[\s\S]{0,600}basis="counted"/);
    expect(panel).toMatch(/testId="benchmark-workspace-cost-per-acted-on"[\s\S]{0,1600}basis="counted"/);
    expect(panel).not.toContain('testId="benchmark-cost-counterfactual"');
    expect(panel).not.toContain('testId="benchmark-cost-per-merged-pr"');
  });

  it('gates the coverage caveat on there being a figure to point at, and renders both disclosures', () => {
    // ⚠ THE CAVEAT POINTS AT A FIGURE, so it must not render when the price could not be stated.
    const panel = panelSource();
    expect(panel).toMatch(
      /\{cost\.monthlyUsd != null && \(\s*<p[\s\S]{0,300}benchmark-workspace-cost-coverage/,
    );
    // ⚠ AND THE TWO DROPPED-ROW DISCLOSURES ARE ACTUALLY MOUNTED. The model computes them, but a
    // disclosure that is computed and never rendered is the same defect as a wrong number, one line
    // quieter — and this feature has a written record of exactly that (the caveat gated on a count
    // that was always 1 on the screen that needed it).
    expect(panel).toContain('data-testid="benchmark-workspace-cost-span-unobserved"');
    expect(panel).toContain('data-testid="benchmark-workspace-cost-partial-window"');
    expect(panel).toContain('workspaceCostSpanUnobservedNote(cost)');
    expect(panel).toContain('workspaceCostPartialWindowNote(cost)');
    // ⚠ THE SERVER-AUTHORED BASIS SENTENCE IS RENDERED VERBATIM, and it rides the MONEY rather than a
    // span: its predecessor was gated on whether a span-anchored figure was on screen, and there are
    // none left. The sentence a reader uses to check the arithmetic must be there whenever the
    // arithmetic is.
    expect(panel).toContain('{cost.basisNote}');
    expect(panel).not.toContain('{cost.spanNote}');
    expect(panel).not.toMatch(/const showsSpan/);
  });

  it('discloses what a truncated estate costs, and only where the remedy is one', () => {
    // ⚠ "OPEN A REPOSITORY'S OWN BOTS TAB" IS ADVICE ON THE RAIL AND A NO-OP ON THAT VERY TAB, where
    // it shipped unconditionally. On the rail it also has to say what truncation costs, which is the
    // MONEY: a whole subscription over a partial estate is wrong in the inflating direction, so the
    // cards withhold it while their counters and spreads — honest sums over a stated subset — still
    // render.
    const panel = panelSource();
    expect(panel).toMatch(/testId="benchmark-truncated"[\s\S]{0,900}isRail/);
  });
});

describe('the ROI table’s money is Workspace-grained too', () => {
  it('gates the $/acted-on column on the RAIL mount, not merely on the capability', () => {
    // ⚠ THE SAME FACT, ONE PANEL OVER. `costPerActedOnUsd` divides a WORKSPACE price by the work
    // measured in whatever scope the request asked for, so on a repository's Bots tab it is a whole
    // subscription over one repository's threads — the identical upper bound the benchmark rollup
    // exists to retire. The column is HIDDEN there rather than disabled or dashed, because a
    // disabled control still asserts that a figure exists.
    //
    // ⚠ AND `showCost` MUST NOT BE "SIMPLIFIED" BACK TO `botDepth`. Its second conjunct is live —
    // every per-repo Bots tab reaches the `false` branch — which is exactly the shape a later reader
    // mistakes for a redundant gate.
    const roi = sourceOf('components/Activity/BotRoiPanel.tsx');
    expect(roi).toMatch(/const showCost = botDepth && repoId == null;/);
    expect(roi).not.toMatch(/showCost=\{botDepth\}/);
    expect(roi).toMatch(/showCost=\{showCost\}/);
    // ⚠ AND THE PROSE THAT DESCRIBES THE COLUMN RIDES THE SAME PREDICATE. A footer still telling a
    // reader to "set a price to see $/acted-on" on a tab that will never show it is a bug report
    // waiting to be filed; the per-repo mount says where the figure actually lives instead.
    expect(roi.match(/showCost/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
