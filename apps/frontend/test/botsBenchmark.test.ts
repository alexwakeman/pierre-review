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
  BotBenchmarkPlacementMetric,
  BotBenchmarkPlacementRefusalReason,
  BotBenchmarkPlacementUnit,
  BotBenchmarkUnavailableReason,
  BotBenchmarkUnitExclusionReason,
} from '@pierre-review/shared';
import {
  ANOMALY_HEADLINE,
  ANOMALY_KIND_ORDER,
  DERIVATION_LABEL,
  EXCLUSION_HEADLINE,
  FINDINGS_EMPTY_HEADLINE,
  PLACEMENT_REFUSAL_HEADLINE,
  UNAVAILABLE_HEADLINE,
  absentMetricRows,
  anomalyRows,
  bandFitNote,
  benchmarkBodyFor,
  collapsedExclusion,
  effectiveBotsTab,
  findingsEmptyState,
  formatMetricValue,
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
