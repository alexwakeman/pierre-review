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
// ⚠ TWO OF THESE ARE SOURCE GUARDS, AND THAT IS A HARNESS LIMIT, NOT A PREFERENCE. This suite runs
// under `vitest --root apps/frontend` with NO DOM (`vitest.config.ts` includes `test/**/*.test.ts`
// only, the React plugin is not applied, and neither jsdom nor a React renderer is installed
// anywhere in the monorepo). A hook's `enabled` cannot be observed without mounting it, so the one
// thing that stops an unentitled SPA polling a 402 is asserted against the module's source. Both
// guards were mutation-tested: deleting the `enabled` line and swapping the lock's testid each
// turn this file red.
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
  BotBenchmarkUnavailableReason,
  BotBenchmarkUnitExclusionReason,
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
  UNAVAILABLE_HEADLINE,
  absentMetricRows,
  anomalyRows,
  bandFitNote,
  benchmarkBodyFor,
  collapsedCostRefusal,
  collapsedExclusion,
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
  orderedUnits,
  percentileSentence,
  placementTally,
  reviewerLabel,
  stripGeometry,
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

describe('the cost block renders only what it may claim', () => {
  it('is ABSENT for a reviewer with no price — not empty, not zero, not a prompt', () => {
    // ⚠ THE RULE THE WHOLE FEATURE TURNS ON, on the render side. The panel branches on the field's
    // presence and there is nothing else to branch on: a "set a price" placeholder or an empty card
    // would both be a surface making a claim the data cannot support.
    expect(unit().cost).toBeUndefined();
    const panel = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/BenchmarkPanel.tsx', import.meta.url)),
      'utf8',
    );
    // ⚠ SOURCE GUARD — see the file header. With no renderer in this suite, this line is the only
    // thing between an unpriced reviewer and a US$0.00 on screen. Mutation-tested: dropping the
    // guard turns this red.
    expect(panel).toMatch(/\{unit\.cost != null && <CostBlock cost=\{unit\.cost\} \/>\}/);
  });

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
    expect(costWindowLabel(14)).toBe('per 14 days');
    const line = costPriceLine(costBlock());
    expect(line).toContain('US$120.00 a month');
    expect(line).toContain('US$55.19 per 14 days');

    // ⚠ THE DEFECT: the two RATIO rows shipped suffixed with the same label, so "Per merged PR"
    // read "US$5.52 per 14 days" and "Per acted-on thread" read "US$27.60 per 14 days". Those are
    // dollars per pull request and dollars per thread — neither scales with the window, because
    // both halves of the fraction scale together, so the suffix invites a reader to double a figure
    // that is exactly the same at any window length. SOURCE GUARD, since this suite has no
    // renderer: the figure prop of both value rows must be a bare `formatUsd(...)`.
    const panel = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/BenchmarkPanel.tsx', import.meta.url)),
      'utf8',
    );
    expect(panel).toMatch(/figure=\{formatUsd\(cost\.perMergedPr\.value\)\}/);
    expect(panel).toMatch(/figure=\{formatUsd\(cost\.yours\.perActedOnUsd\)\}/);
    expect(panel).toMatch(/figure=\{formatUsd\(cost\.atPeerEngagement\.perActedOnUsd\)\}/);
    // …and nothing on this card interpolates the window label into a `figure` at all.
    expect(panel).not.toMatch(/figure=\{`\$\{formatUsd\([^)]*\)\} \$\{window\}`\}/);
    // ⚠ AND EACH PER-THREAD ROW NAMES THE PACE IT DIVIDED BY, which is what makes a rate at the
    // current price checkable on screen: "2 of 20 threads acted on, over 9 days — about 6.8 a
    // month". Without it the row is a dollar figure over a raw count and a span, and the reader has
    // to know `30.44` to see where it came from. SOURCE GUARD, same reason as above.
    expect(panel).toMatch(/formatThreadCount\(cost\.yours\.actedPerMonth\)\} a month/);
    expect(panel).toMatch(/formatThreadCount\(cost\.atPeerEngagement\.actedPerMonthAtPeer\)\} a month/);
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

  it('ALWAYS says the price is per WORKSPACE, and counts the cards when there is more than one', () => {
    // ⚠ THE RULE IS UNCONDITIONAL AND THE COUNT IS THE BONUS. `sharedWithUnits` counts the cards in
    // THIS RESPONSE, and the per-repository Bots tab narrows to one repository — so a caveat gated
    // on `> 1` would be invisible on exactly the screen where a reader is most likely to read a
    // Workspace-wide subscription as this repository's bill. That shipped; this pins the fix.
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
    // ⚠ SOURCE GUARD, since this suite has no renderer: the "this is the Workspace price" caveat
    // points at a figure, so it must not render when there is none.
    const panel = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/BenchmarkPanel.tsx', import.meta.url)),
      'utf8',
    );
    expect(panel).toMatch(/\{cost\.monthlyUsd != null && \(\s*<p[\s\S]{0,300}benchmark-cost-shared/);
  });

  it('gives the nine cost refusals nine DIFFERENT sentences, and every union member one', () => {
    // ⚠ THE SAME PAIRWISE RULE THE OTHER THREE VOCABULARIES KEEP. A renderer that collapsed two of
    // these tells a customer their reviewer costs nothing when in fact nobody merged anything.
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
    ];
    expect(Object.keys(COST_REFUSAL_HEADLINE).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect(COST_REFUSAL_HEADLINE[reason], reason).toBeTruthy();
      expect(COST_REFUSAL_HEADLINE[reason], reason).not.toMatch(/undefined/);
    }
    expect(new Set(Object.values(COST_REFUSAL_HEADLINE)).size).toBe(reasons.length);
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
    const panel = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/BenchmarkPanel.tsx', import.meta.url)),
      'utf8',
    );
    // SOURCE GUARD: the counterfactual row is the one that must carry `fitted`, and the two
    // customer-side rows must not.
    expect(panel).toMatch(/testId="benchmark-cost-counterfactual"[\s\S]{0,900}basis="fitted"/);
    expect(panel).toMatch(/testId="benchmark-cost-per-merged-pr"[\s\S]{0,600}basis="counted"/);
  });

  it('draws the coin as an icon component, never as a "$" glyph doing duty as one', () => {
    // The SPA ships no icon library and no icon glyphs; the currency symbol belongs in the FIGURE,
    // where it is part of the number's meaning.
    const icons = readFileSync(
      fileURLToPath(new URL('../src/components/Icons.tsx', import.meta.url)),
      'utf8',
    );
    expect(icons).toContain('export function CoinIcon');
    const panel = readFileSync(
      fileURLToPath(new URL('../src/components/Activity/BenchmarkPanel.tsx', import.meta.url)),
      'utf8',
    );
    expect(panel).toContain('<CoinIcon');
  });
});
