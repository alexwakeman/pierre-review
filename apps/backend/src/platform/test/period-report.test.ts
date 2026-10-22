// Period-report unit tests: the cadence grid (which windows exist and which key names which
// window), the payload hash's PURITY, the significance rule, and the movement ranking.
//
// No database and no model — `buildPeriod` takes the host seams as functions, so a fake
// `ProContext` with three stubs exercises the whole computation deterministically. That is the
// point: the parts most likely to be wrong here are an off-by-one in the period grid and a clock
// value leaking into the cache key, and neither needs a fixture DB to catch.
//
// This file imports PERIOD_METRIC_KEYS as a VALUE from @pierre-review/shared. Production code in
// this package cannot (the shared package is types-only and unshipped; `build-release.mjs` fails
// on a real import of it), which is exactly why `PERIOD_METRIC_META` is a hand-kept mirror — and
// why a test that CAN import the original is where the two get compared.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { PERIOD_METRIC_KEYS } from '@pierre-review/shared';
import type { PeriodMetricDelta, PeriodMetricKey, PeriodMetricValue } from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import type { SettingsRow, SprintCadence } from '../settings/store.js';
import * as periodSchema from '../insights/period-schema.sqlite.js';
import {
  buildForecasts,
  buildPeriod,
  completedWindows,
  generatePeriodReport,
  listPeriods,
  loadStoredReport,
  narrationPayload,
  periodGrid,
  periodKeyFor,
  rankMovements,
  windowForKey,
  PERIOD_METRIC_META,
} from '../insights/period-report.js';
import { buildSuggestedQuestions, formatPeriodRange } from '../insights/period-questions.js';

/** Every `workspace_period_reports` migration, in filename order — the same order the host's
 *  runPluginMigrations applies them in. Discovered from disk so a new one is picked up without
 *  anyone remembering to add it here. */
function periodMigrationSql(): string[] {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => /^002[5-9]_|^00[3-9]\d_/.test(f) && f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(dir + f, 'utf8'));
}

// ⚠ THE STUBS BELOW MUST CARRY EVERY COLUMN THE REPLAYED MIGRATIONS TOUCH, not just the ones this
// suite reads. These harnesses exec the WHOLE plugin migration folder from 0025 on, and TWO of
// FOUR of those migrations read `pro_settings` and JOIN core `workspaces`: 0030 (the per-workspace
// Slack digest) SELECTs the `slack_*` columns and joins on `is_default`, 0031 (the per-workspace
// issue tracker) SELECTs the `issue_*` columns and joins EVERY workspace of the account, 0032 (the
// per-workspace comparison mode) SELECTs `comparison_mode` and joins every workspace too, and 0033
// (the per-delivery bot block) SELECTs `bot_slack_digest`. A narrower stub makes the migration blob
// throw and every test in the file fail on setup — which is the correct signal, and this is the fix
// for it.
const PRO_SETTINGS_STUB =
  'CREATE TABLE pro_settings (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
  'slack_webhook_url text, slack_cadence text, slack_hour1 integer, slack_hour2 integer, ' +
  'slack_timezone text, slack_last_sent_at integer, slack_last_sent_slot text, ' +
  'issue_provider text, issue_base_url text, issue_project_keys text, ' +
  'comparison_mode text, bot_slack_digest integer)';
const WORKSPACES_STUB =
  'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text, ' +
  // auto_review_*: core 0074's columns, which plugin 0037 copies the retired switch into.
  'is_default integer NOT NULL DEFAULT 0, auto_review_enabled integer, auto_review_enabled_at integer);' +
  'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const CADENCE = 14;
const CADENCE_MS = CADENCE * DAY;
// Mid-way through period 5, so periods 0-4 are complete and 5 is in progress.
const NOW = START + 5 * CADENCE_MS + 3 * DAY;

// ⚠ THE ONLY LIVE FIELD ON THIS ROW IS `reportModel`. `sprintCadenceDays` / `sprintStartAt` went
// per-workspace in plugin 0031 and `comparisonMode` in plugin 0032, and none of them is declared on
// `SettingsRow` any more — they are kept in this literal purely so a stale value in the dormant
// columns would be VISIBLE if anything ever read one again.
const settings = (over: Partial<SettingsRow> = {}): SettingsRow =>
  ({
    accountId: 1,
    sprintCadenceDays: CADENCE,
    sprintStartAt: new Date(START),
    comparisonMode: 'sprint',
    reportModel: null,
    ...over,
  }) as unknown as SettingsRow;

/** The RESOLVED cadence `periodGrid` now takes. It is a per-WORKSPACE fact
 *  (`resolveSprintCadence`), so the grid can no longer be built from a settings row — a change
 *  that is the point: two workspaces on one account legitimately sit on two different grids. */
const cadence = (days: number = CADENCE, startMs: number = START): SprintCadence => ({
  cadenceDays: days,
  startAtMs: startMs,
});

const gridOrThrow = (c: SprintCadence = cadence()) => {
  const g = periodGrid(c, NOW);
  if (g == null) throw new Error('expected a configured cadence');
  return g;
};

/** All twelve metrics, in contract order; anything not named is `null` with sampleSize 0 — the
 *  same "no data, NOT zero" shape core emits. */
const vec = (
  over: Partial<Record<PeriodMetricKey, [number | null, number]>>,
): PeriodMetricValue[] =>
  PERIOD_METRIC_KEYS.map((key) => {
    const cell = over[key];
    return { key, value: cell ? cell[0] : null, sampleSize: cell ? cell[1] : 0 };
  });

interface FakeOpts {
  metrics: (scope: BotScopeWire, window: { fromMs: number; toMs: number }) => PeriodMetricValue[];
  tracked: (repoIds: number[], atMs: number) => number[];
}

function fakeCtx(opts: FakeOpts): ProContext {
  return {
    queries: {
      getPeriodMetrics: async (
        _accountId: number,
        scope: BotScopeWire,
        window: { fromMs: number; toMs: number },
      ) => {
        const metrics = opts.metrics(scope, window);
        return {
          metrics,
          // Over the RAW COUNTS plus the exact scope and window, like the real one — and nothing
          // clock-derived, or every stored report would read `stale` forever. Folding the values
          // in is what makes it a staleness probe at all rather than a scope label.
          fingerprint: `fp:${scope.repoIds.join(',')}:${window.fromMs}:${metrics
            .map((m) => `${m.key}=${m.value ?? '~'}/${m.sampleSize}`)
            .join(',')}`,
        };
      },
      getPeriodCoverage: async (_accountId: number, repoIds: number[], atMs: number) => ({
        trackedRepoIds: opts.tracked(repoIds, atMs),
      }),
      computePeriodForecast: async () => ({ refused: 'insufficient_history' as const }),
      // The effort-vs-automation breakdown. Stubbed with a fixed shape: buildPeriod only carries
      // it through, and the CLASSIFICATION it rests on is tested in core's actor-lanes.test.ts.
      getPeriodLanes: async () => ({
        lanes: [
          { lane: 'human', mergedPrs: 12, openedPrs: 14, medianPrSizeLines: 142, medianLeadTimeHours: 5.5, comments: 40, approvals: 20 },
          { lane: 'ai_review', mergedPrs: 0, openedPrs: 0, medianPrSizeLines: null, medianLeadTimeHours: null, comments: 0, approvals: 0 },
          { lane: 'quality_gate', mergedPrs: 0, openedPrs: 0, medianPrSizeLines: null, medianLeadTimeHours: null, comments: 140, approvals: 84 },
          { lane: 'dependency', mergedPrs: 8, openedPrs: 9, medianPrSizeLines: 14, medianLeadTimeHours: 3.9, comments: 17, approvals: 0 },
        ],
        automationMergeSharePct: 40,
        medianTimeToFirstHumanReviewHours: 21,
        silentAutomation: [],
      }),
    },
  } as unknown as ProContext;
}

const SCOPE: BotScopeWire = { workspaceId: 7, repoIds: [1, 2, 3] };

describe('the cadence grid', () => {
  it('places `now` in the period that contains it and excludes it from the completed list', () => {
    const grid = gridOrThrow();
    expect(grid.currentIndex).toBe(5);
    const done = completedWindows(grid, 3);
    expect(done.map((w) => w.index)).toEqual([4, 3, 2]); // newest first
    // The in-progress period must never be listed: its numbers move under the reader, so every
    // free GET would recompute a different fingerprint and flag the stored row stale forever.
    expect(done.every((w) => w.toMs <= NOW)).toBe(true);
  });

  // ⚠ THE SPRINT START IS A PHASE ANCHOR, NOT THE START OF HISTORY.
  //
  // This used to assert `[4,3,2,1,0]` — the grid stopping dead at the configured start date. That
  // treated a date the team typed when they set their cadence as the beginning of recorded time:
  // a workspace with two years of PRs and a cadence configured six weeks ago got three reportable
  // periods and could never reach the four a forecast needs, with all the data sitting right there.
  //
  // The anchor says only WHERE the fortnightly boundaries fall. Periods before it are the same
  // fortnights the team would have called sprints, just ones they had not written down yet — so
  // indices go negative, bounded by the look-back horizon rather than by the anchor.
  it('extrapolates BACKWARD past the anchor, on the same phase', () => {
    const grid = gridOrThrow();
    const idx = completedWindows(grid, 99).map((w) => w.index);
    expect(idx.slice(0, 6)).toEqual([4, 3, 2, 1, 0, -1]);
    // Bounded by the horizon (26 periods back from the in-progress one), never unbounded.
    expect(idx).toHaveLength(26);
    expect(idx[idx.length - 1]).toBe(grid.currentIndex - 26);
  });

  it('keeps every boundary on the anchor’s phase when it goes negative', () => {
    const grid = gridOrThrow();
    const before = completedWindows(grid, 99).find((w) => w.index === -1)!;
    // Exactly one cadence before the anchor — not a re-based grid, not a calendar month.
    expect(before.fromMs).toBe(START - CADENCE_MS);
    expect(before.toMs).toBe(START);
    expect(before.cadenceDays).toBe(CADENCE);
  });

  it('round-trips a key through the grid', () => {
    const grid = gridOrThrow();
    const win = windowForKey(grid, periodKeyFor(START + 2 * CADENCE_MS));
    expect(win?.index).toBe(2);
    expect(win?.key).toBe('sprint-2026-01-29');
    expect(win?.cadenceDays).toBe(CADENCE);
  });

  it('refuses a key that is off the cadence grid rather than snapping it to a neighbour', () => {
    const grid = gridOrThrow();
    // Half a period out — this key came from a DIFFERENT cadence, and answering about the nearest
    // window would silently report on dates nobody asked about.
    expect(windowForKey(grid, periodKeyFor(START + CADENCE_MS + 7 * DAY))).toBeNull();
  });

  it('refuses the in-progress period, the future, and anything past the look-back horizon', () => {
    const grid = gridOrThrow();
    expect(windowForKey(grid, periodKeyFor(START + 5 * CADENCE_MS))).toBeNull(); // in progress
    expect(windowForKey(grid, periodKeyFor(START + 9 * CADENCE_MS))).toBeNull(); // future
    expect(windowForKey(grid, 'sprint-not-a-date')).toBeNull();
    expect(windowForKey(grid, '2026-01-01')).toBeNull();
    // Beyond the 26-period horizon — a hand-typed key from before the product existed is refused
    // rather than scanned.
    expect(windowForKey(grid, periodKeyFor(START - 40 * CADENCE_MS))).toBeNull();
  });

  // The other half of the same change: a key BEFORE the anchor now resolves, because the anchor
  // is a phase, not a boundary. Previously this returned null and the period was unreachable even
  // though its data was present.
  it('resolves a key from before the anchor', () => {
    const grid = gridOrThrow();
    const win = windowForKey(grid, periodKeyFor(START - CADENCE_MS));
    expect(win?.index).toBe(-1);
    expect(win?.fromMs).toBe(START - CADENCE_MS);
  });

  it('has NO grid at all when the cadence is unconfigured — the one hard refusal (§6.1)', () => {
    // The unconfigured state is now the RESOLVED cadence's, not a null settings row: a workspace
    // with no row of its own falls back to the account default, and only when THAT is also unset
    // does the surface refuse. `resolveSprintCadence` never returns null, so a null-shaped grid
    // input cannot arise — an incomplete pair is the whole refusal.
    expect(periodGrid({ cadenceDays: null, startAtMs: null }, NOW)).toBeNull();
    expect(periodGrid({ cadenceDays: null, startAtMs: START }, NOW)).toBeNull();
    expect(periodGrid({ cadenceDays: CADENCE, startAtMs: null }, NOW)).toBeNull();
  });

  // ⚠ TWO WORKSPACES ON ONE ACCOUNT MAY SIT ON TWO DIFFERENT GRIDS. That is the whole point of the
  // per-workspace cadence, and it is what every guard further down this file protects: a period
  // key names a START DAY, which the same day can begin at two different cadences.
  it('grids a 7-day workspace on 7-day boundaries from the same anchor', () => {
    const weekly = gridOrThrow(cadence(7, START));
    expect((weekly as { cadenceDays?: number }).cadenceDays).toBe(7);
    // NOW is 5·14 + 3 days after START = 73 days in ⇒ index 10 of a 7-day grid.
    expect(weekly.currentIndex).toBe(10);
    const done = completedWindows(weekly, 2).map((w) => w.fromMs);
    expect(done).toEqual([START + 9 * 7 * DAY, START + 8 * 7 * DAY]);
  });
});

describe('formatPeriodRange', () => {
  it('names the period by its explicit UTC date range', () => {
    expect(formatPeriodRange(Date.parse('2026-08-18T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z')))
      .toBe('18 Aug – 1 Sep');
  });

  it('never says "month"', () => {
    // A 14-day cadence gives ~2.17 periods per calendar month, so any month wording on a document
    // someone forwards would be a false label.
    const label = formatPeriodRange(START, START + CADENCE_MS).toLowerCase();
    expect(label).not.toContain('month');
  });
});

describe('rankMovements', () => {
  const delta = (over: Partial<PeriodMetricDelta> & { key: PeriodMetricKey }): PeriodMetricDelta => ({
    value: 0,
    prior: 0,
    absoluteChange: 0,
    percentChange: 0,
    significant: true,
    direction: 'neutral',
    ...over,
  });

  it('ranks by |percentChange| and drops insignificant deltas entirely', () => {
    const out = rankMovements([
      delta({ key: 'merged_prs', absoluteChange: 10, percentChange: 20, direction: 'up_good' }),
      delta({ key: 'opened_prs', absoluteChange: 4, percentChange: 80 }),
      // Significant: false — a percentage off a tiny base is noise, and a pill inviting a
      // drill-down into it is the same mistake in a different costume.
      delta({ key: 'human_review_comments', absoluteChange: 200, percentChange: 900, significant: false }),
    ]);
    expect(out.map((m) => m.key)).toEqual(['opened_prs', 'merged_prs']);
    expect(out.map((m) => m.rank)).toEqual([0, 1]);
  });

  it('breaks a percentage tie on the absolute change', () => {
    const out = rankMovements([
      delta({ key: 'merged_prs', absoluteChange: 5, percentChange: 50 }),
      delta({ key: 'opened_prs', absoluteChange: 40, percentChange: 50 }),
    ]);
    expect(out.map((m) => m.key)).toEqual(['opened_prs', 'merged_prs']);
  });

  it('reads `favourable` off the metric direction — and NEVER calls a neutral metric favourable', () => {
    const out = rankMovements([
      delta({ key: 'merged_prs', absoluteChange: 5, percentChange: 10, direction: 'up_good' }),
      delta({ key: 'median_lead_time_hours', absoluteChange: -5, percentChange: -10, direction: 'down_good' }),
      delta({ key: 'median_pr_size_lines', absoluteChange: 50, percentChange: 10, direction: 'down_good' }),
      delta({ key: 'opened_prs', absoluteChange: 9, percentChange: 10, direction: 'neutral' }),
    ]);
    const fav = new Map(out.map((m) => [m.key, m.favourable]));
    expect(fav.get('merged_prs')).toBe(true);
    expect(fav.get('median_lead_time_hours')).toBe(true);
    expect(fav.get('median_pr_size_lines')).toBe(false);
    // A neutral metric has no good direction, so `false` here means "not favourable", NOT "bad" —
    // a renderer must read `direction` alongside it (see the note on rankMovements).
    expect(fav.get('opened_prs')).toBe(false);
  });
});

describe('the metric-meta mirror', () => {
  it('covers exactly the shared key list, in the contract order', () => {
    // The floors and directions live in CORE's db/period-metrics.ts; this package keeps a hand
    // copy because it is the side that computes the deltas. Drift in the KEY SET is at least
    // catchable here — drift in a floor VALUE is not, so core wins by convention.
    expect(Object.keys(PERIOD_METRIC_META)).toEqual(PERIOD_METRIC_KEYS);
  });
});

describe('buildPeriod', () => {
  const grid = gridOrThrow();
  const target = windowForKey(grid, periodKeyFor(START + 4 * CADENCE_MS))!;

  // A two-period story that exercises all three significance conditions at once:
  //   merged_prs                 20 vs 10 — clears both floors, the one real mover
  //   opened_prs                 12 vs 11 — |1| is under the absolute floor of 3
  //   review_threads_opened       8 vs 20 — big change, but THIS period's sample (8) is under 10
  //   bot_review_comments        20 vs  8 — big change, but the PRIOR sample (8) is under 10
  const ctxAllTracked = fakeCtx({
    metrics: (_scope, window) =>
      window.fromMs === target.fromMs
        ? vec({
            merged_prs: [20, 20],
            opened_prs: [12, 12],
            review_threads_opened: [8, 8],
            bot_review_comments: [20, 20],
          })
        : vec({
            merged_prs: [10, 10],
            opened_prs: [11, 11],
            review_threads_opened: [20, 20],
            bot_review_comments: [8, 8],
          }),
    tracked: (repoIds) => repoIds,
  });

  it('carries a delta but flags it insignificant below the absolute floor', async () => {
    const built = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    const byKey = new Map(built.report.comparison.deltas.map((d) => [d.key, d]));
    const merged = byKey.get('merged_prs')!;
    expect(merged.absoluteChange).toBe(10);
    expect(merged.percentChange).toBe(100);
    expect(merged.significant).toBe(true);

    const opened = byKey.get('opened_prs')!;
    // The raw figures are real and are always carried; only the CLAIM that it changed is withheld.
    expect(opened.absoluteChange).toBe(1);
    expect(opened.significant).toBe(false);
    expect(built.report.movements.map((m) => m.key)).toEqual(['merged_prs']);
  });

  it('needs the sample floor cleared on BOTH sides, not just one', async () => {
    const built = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    const byKey = new Map(built.report.comparison.deltas.map((d) => [d.key, d]));
    // A big swing measured over 8 threads is not a trend — whichever side is thin.
    const thisSideThin = byKey.get('review_threads_opened')!;
    expect(thisSideThin.absoluteChange).toBe(-12);
    expect(thisSideThin.significant).toBe(false);
    const priorSideThin = byKey.get('bot_review_comments')!;
    expect(priorSideThin.absoluteChange).toBe(12);
    expect(priorSideThin.significant).toBe(false);
  });

  it('discloses the coverage-stable subset it compared over', async () => {
    const built = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    expect(built.report.coverage).toEqual({ trackedRepos: 3, totalRepos: 3, complete: true });
    expect(built.report.comparison.subsetRepoIds).toEqual([1, 2, 3]);
    expect(built.report.comparison.subsetDisclosure).toContain('3 of 3 repos');
    expect(built.report.comparison.refusal).toBeNull();
  });

  it('refuses the comparison when the two periods share no tracked repo', async () => {
    // Every repo was onboarded AFTER the prior period began: the intersection is empty, so there
    // is no like-for-like comparison to draw and a raw subtraction would be measuring onboarding.
    const ctx = fakeCtx({
      metrics: () => vec({ merged_prs: [20, 20] }),
      tracked: (repoIds, atMs) => (atMs >= target.fromMs ? repoIds : []),
    });
    const built = await buildPeriod(ctx, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    expect(built.report.comparison.refusal).toBe('partial_coverage');
    expect(built.report.comparison.deltas).toEqual([]);
    expect(built.report.movements).toEqual([]);
  });

  // ⚠ THE FLOOR IS THE LOOK-BACK HORIZON, NOT INDEX 0 — a deliberate behaviour CHANGE, and this
  // test was rewritten from pinning the old rule to pinning the new one.
  //
  // `no_prior_period` used to fire on `window.index === 0`, treating the configured sprint start
  // as the beginning of recorded history. It is not: it is a PHASE ANCHOR, and `completedWindows`
  // and `backfillHistory` both already extend to NEGATIVE indices. So index 0 refused a comparison
  // against index −1 — a period this surface lists, stores, and can measure with exactly the same
  // scan every other prior period gets.
  it('COMPARES the period at index 0 against index −1 — the sprint start is a phase anchor', async () => {
    const first = windowForKey(grid, periodKeyFor(START))!;
    expect(first.index).toBe(0);
    const built = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, first, 'claude-haiku-5-5', [], []);
    expect(built.report.comparison.refusal).toBeNull();
    expect(built.report.comparison.priorPeriodKey).toBe(periodKeyFor(START - CADENCE_MS));
  });

  it('refuses only below the LOOK-BACK HORIZON, where there is genuinely nothing before', async () => {
    // The oldest window the grid will name at all. Its predecessor is off the horizon, so we
    // decline to scan it — and declining to scan is what makes "no prior period" true here.
    const oldest = completedWindows(grid, 999).at(-1)!;
    const built = await buildPeriod(
      ctxAllTracked,
      1,
      SCOPE,
      grid,
      oldest,
      'claude-haiku-5-5',
      [],
      [],
    );
    expect(built.report.comparison.refusal).toBe('no_prior_period');
    expect(built.report.comparison.priorPeriodKey).toBeNull();
  });

  // ⚠ THE LOAD-BEARING TEST. A `Date.now()`-derived value in the payload hash makes a dormant
  // workspace re-bill on every click, because the cache can never hit. `generatedAt` moves
  // between the two builds below and the hash must not.
  it('computes a payload hash that is PURE — the clock moves, the hash does not', async () => {
    const a = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    await new Promise((r) => setTimeout(r, 5));
    const b = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    expect(b.report.generatedAt).not.toBe(a.report.generatedAt);
    expect(b.payloadHash).toBe(a.payloadHash);
    expect(b.dataFingerprint).toBe(a.dataFingerprint);
  });

  // ⚠ THE OTHER HALF OF THE MODEL RULE. Model OUT of the hash ⇒ a model switch hits the previous
  // model's cache and looks broken. (Model out of the ROW KEY is the twin failure — one model's
  // row overwriting another's — pinned by the unique index in test/isolation.test.ts.)
  //
  // Sonnet is no longer SELECTABLE (REPORT_MODELS is Haiku-only), which makes this property MORE
  // load-bearing, not less: the retirement flipped the default from Sonnet to Haiku, and it is
  // this fold that makes that flip a deliberate one-off cache miss — each period re-narrates once
  // under the new model instead of silently serving the Sonnet write-up as if Haiku had produced
  // it. The literal below is still a valid `ReportModel` because the pricing table keeps its row.
  it('folds the model into the payload hash', async () => {
    const haiku = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    const sonnet = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-sonnet-5', [], []);
    expect(sonnet.payloadHash).not.toBe(haiku.payloadHash);
  });

  it('folds the repo set into the hash, so membership drift is a real change (§6.4)', async () => {
    const wide = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    const narrow = await buildPeriod(
      ctxAllTracked,
      1,
      { workspaceId: 7, repoIds: [1, 2] },
      grid,
      target,
      'claude-haiku-5-5',
      [],
      [],
    );
    expect(narrow.payloadHash).not.toBe(wide.payloadHash);
  });

  it('binds every suggested question to the exact window and repo set it was computed from', async () => {
    const built = await buildPeriod(ctxAllTracked, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    expect(built.report.suggested.length).toBeGreaterThan(0);
    for (const q of built.report.suggested) {
      expect(q.scope.fromMs).toBe(target.fromMs);
      expect(q.scope.toMs).toBe(target.toMs);
      expect(q.scope.repoIds).toEqual([1, 2, 3]);
      expect(q.id.startsWith(target.key)).toBe(true);
    }
  });
});

// ── The grounding payload: the TWO POPULATIONS must never wear the same field name ───────────
//
// The bug this pins, measured end-to-end against the real dev corpus before it was fixed: the
// headline vector and the coverage-stable comparison both spelled their current figure `value`,
// under the same metric key, in one JSON object. Haiku read them as a time series and wrote
// "Merged PRs: 117 (was 113, −22.6%)" — 117 the full-workspace headline, 113 this period over the
// subset, and the TRUE prior of 146 absent from the sentence — and the chat turn compounded it into
// "146 → 113 → 117 over the three tracked periods". Every number in both was real, which is why
// nothing about the output looked wrong.
//
// A "period report" whose headline arithmetic is wrong is worse than no report, because it is
// forwarded. These assertions are about the payload's SHAPE rather than any model's output, since
// the shape is the only half that is deterministic.
describe('the narration payload', () => {
  const grid = gridOrThrow();
  const target = windowForKey(grid, periodKeyFor(START + 4 * CADENCE_MS))!;

  // Headline 20 merged (all 3 repos) against a subset that saw 17 vs a prior 10 — i.e. the
  // headline and the comparison's current figure DISAGREE, which is the normal case whenever any
  // repo was onboarded mid-history and is exactly the case that produced the bad sentence.
  const ctxDrifting = fakeCtx({
    metrics: (scope, window) => {
      const subset = scope.repoIds.length < 3;
      if (window.fromMs !== target.fromMs) return vec({ merged_prs: [10, 10] });
      return vec({ merged_prs: subset ? [17, 17] : [20, 20] });
    },
    // Repo 3 was not tracked when the prior period began, so the stable subset is [1, 2].
    tracked: (repoIds, atMs) =>
      atMs < target.fromMs ? repoIds.filter((id) => id !== 3) : repoIds,
  });

  it('never gives the headline figure and the subset figure the same field name', async () => {
    const built = await buildPeriod(ctxDrifting, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    const payload = narrationPayload(built.report) as {
      metrics: { key: string; value: number | null }[];
      comparison: { deltas: Record<string, unknown>[] };
    };
    // The premise: the two populations really do disagree here.
    expect(payload.metrics.find((m) => m.key === 'merged_prs')?.value).toBe(20);

    const delta = payload.comparison.deltas.find((d) => d.key === 'merged_prs')!;
    expect(delta.thisPeriod).toBe(17);
    expect(delta.priorPeriod).toBe(10);
    // THE ASSERTION THAT MATTERS. `value`/`prior` are what `PeriodMetricDelta` calls them on the
    // wire; inside the prompt they must NOT be, or they collide with `metrics[].value`.
    expect(delta).not.toHaveProperty('value');
    expect(delta).not.toHaveProperty('prior');
  });

  it('gives each movement a self-contained pair, so a bullet never reaches into another object', async () => {
    const built = await buildPeriod(ctxDrifting, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    const payload = narrationPayload(built.report) as {
      movements: { key: string; thisPeriod: number; priorPeriod: number; phrase: string }[];
    };
    const moved = payload.movements.find((m) => m.key === 'merged_prs')!;
    expect(moved.thisPeriod).toBe(17);
    expect(moved.priorPeriod).toBe(10);
    // Pre-rendered, so the model copies rather than choosing which number goes where. BOTH sides
    // come from the same delta — the headline 20 must appear nowhere in it. Both figures carry
    // the metric's UNIT: a bare "50" for a percentage metric was read as a count of PRs (see
    // period-metric-units.test.ts), and the trailing +70% is the RELATIVE change, not a unit.
    expect(moved.phrase).toBe('17 PRs (was 10 PRs, +70%)');
    expect(moved.phrase).not.toContain('20');
  });

  it('names both populations in words, beside the figures they describe', async () => {
    const built = await buildPeriod(ctxDrifting, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    const payload = narrationPayload(built.report) as {
      metricsBasis: string;
      comparison: { basis: string };
    };
    expect(payload.metricsBasis).toContain('HEADLINE');
    expect(payload.comparison.basis).toContain('2 repos tracked in BOTH periods');
  });
});

describe('buildSuggestedQuestions', () => {
  const scope = { periodKey: 'sprint-2026-08-18', fromMs: START, toMs: START + CADENCE_MS, repoIds: [4] };

  it('leads with the biggest movers and caps the list', () => {
    const out = buildSuggestedQuestions(
      [
        { key: 'median_lead_time_hours', absoluteChange: -4, percentChange: -40, rank: 0, favourable: true },
        { key: 'merged_prs', absoluteChange: 6, percentChange: 30, rank: 1, favourable: true },
      ],
      scope,
      2,
    );
    expect(out.map((q) => q.scope.metric)).toEqual(['median_lead_time_hours', 'merged_prs']);
  });

  it('never renders an empty rail — a quiet period still has questions worth asking', () => {
    const out = buildSuggestedQuestions([], scope);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((q) => q.text.length > 0)).toBe(true);
  });
});

// ── The WRITE path, against a real SQLite and the REAL migration ─────────────────────────────
//
// ⚠ THIS EXISTS FOR ONE LANDMINE: a stale `onConflictDoUpdate` target TYPE-CHECKS PERFECTLY and
// raises "no unique or exclusion constraint matching the ON CONFLICT specification" at RUNTIME,
// in both dialects, ONLY when a row is actually written — so every test above, which never
// touches a database, would stay green while generation 500'd on the first click. The table's
// unique index is FOUR columns and has already been re-keyed twice elsewhere in this codebase
// (0042, 0045), which is exactly how this bug ships.
//
// Migration 0025 is exec'd VERBATIM rather than re-declared here, so the index the upsert targets
// is the one production creates. Its trailing `ALTER TABLE pro_settings` needs that table to
// exist, hence the two-column stub.
describe('generatePeriodReport — persistence', () => {
  const grid = gridOrThrow();
  const target = windowForKey(grid, periodKeyFor(START + 4 * CADENCE_MS))!;
  // ⚠ EVERY period migration, discovered rather than pinned. A hand-listed single file is how the
  // sibling settings fixture ended up failing on a column it had never created: the list silently
  // goes stale the moment a migration adds one the code under test selects by name.
  const MIGRATIONS = periodMigrationSql();

  let sqlite: Database.Database;
  let ctx: ProContext;
  let llmCalls: number;
  let mergedThisPeriod: number;

  const llm: LlmClient = {
    async complete() {
      llmCalls += 1;
      return { text: '**Sprint report.**', inputTokens: 3000, outputTokens: 400, costUsd: 0.005 };
    },
  };

  const rowCount = (): number =>
    (sqlite.prepare('SELECT count(*) AS n FROM workspace_period_reports').get() as { n: number }).n;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(PRO_SETTINGS_STUB);
    sqlite.exec(WORKSPACES_STUB);
    for (const sql of MIGRATIONS) sqlite.exec(sql);
    llmCalls = 0;
    mergedThisPeriod = 20;
    const db = drizzle(sqlite, { schema: { ...periodSchema } });
    const seams = fakeCtx({
      metrics: (_scope, window) =>
        window.fromMs === target.fromMs
          ? vec({ merged_prs: [mergedThisPeriod, mergedThisPeriod] })
          : vec({ merged_prs: [10, 10] }),
      tracked: (repoIds) => repoIds,
    });
    ctx = {
      ...seams,
      db,
      isPg: false,
      recordAiUsage: async () => {},
    } as unknown as ProContext;
  });

  const run = () =>
    generatePeriodReport(ctx, llm, 1, SCOPE, grid, target, 'claude-haiku-5-5');

  it('writes the narrated row plus the bounded metrics-only backfill', async () => {
    const out = await run();
    expect(out.generated).toBe(true);
    expect(out.report?.narrative).toBe('**Sprint report.**');
    expect(out.report?.model).toBe('claude-haiku-5-5');
    expect(out.spend?.credits).toBeGreaterThan(0);
    // Target period 4 ⇒ backfill covers 3, 2, 1, 0, −1, −2, −3, −4: the full BACKFILL_PERIODS,
    // bounded by the CAP rather than by the anchor.
    //
    // It used to stop at index 0 and write 5 rows, because the configured sprint start was treated
    // as the start of history. That is the change: the anchor sets the PHASE of the grid, so the
    // backfill reaches its full depth on any workspace with the data, instead of being clipped by
    // whenever the team happened to configure their cadence.
    const rows = sqlite
      .prepare('SELECT period_key, model, narrative_md FROM workspace_period_reports ORDER BY period_key')
      .all() as { period_key: string; model: string; narrative_md: string | null }[];
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.model === '')).toHaveLength(8);
    // ⚠ '' and never NULL: NULL does not collide in a unique index, so a NULL-modelled backfill
    // would insert a fresh set of rows on every run, forever.
    expect(rows.every((r) => r.model != null)).toBe(true);
    expect(rows.filter((r) => r.narrative_md != null)).toHaveLength(1);
    expect(llmCalls).toBe(1); // ONE metered call per user-visible turn.
  });

  it('is $0 and row-stable on an unchanged re-run (the payload-hash cache)', async () => {
    await run();
    const before = rowCount();
    const second = await run();
    expect(second.generated).toBe(false);
    expect(second.report?.narrative).toBe('**Sprint report.**');
    expect(llmCalls).toBe(1); // no second billing
    expect(rowCount()).toBe(before);
  });

  it('UPDATES the same row when the data moves — the ON CONFLICT target must be the real index', async () => {
    await run();
    const before = rowCount();
    mergedThisPeriod = 31; // the period's numbers changed ⇒ a new payload hash ⇒ a real re-run
    const second = await run();
    expect(second.generated).toBe(true);
    expect(llmCalls).toBe(2);
    // The row is REPLACED, not duplicated. A wrong conflict target would either throw here or
    // (with a target that happens to be unique on fewer columns) leave two rows for one period.
    expect(rowCount()).toBe(before);
    const stored = sqlite
      .prepare("SELECT metrics_json FROM workspace_period_reports WHERE model = 'claude-haiku-5-5'")
      .all() as { metrics_json: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.metrics_json).toContain('31');
  });

  // Still worth pinning after Sonnet's retirement as a CHOICE: this is the mechanism that keeps a
  // historical narration readable. Accounts carry stored Sonnet rows, and the Haiku regeneration
  // that follows the default flip must sit BESIDE them, not on top — a period's old write-up stays
  // fetchable rather than being silently rewritten by a model that never saw it.
  it('keeps a Sonnet run beside the Haiku one rather than overwriting it', async () => {
    await run();
    const sonnet = await generatePeriodReport(ctx, llm, 1, SCOPE, grid, target, 'claude-sonnet-5');
    expect(sonnet.generated).toBe(true);
    const models = (
      sqlite
        .prepare('SELECT model FROM workspace_period_reports WHERE period_key = ?')
        .all(target.key) as { model: string }[]
    ).map((r) => r.model);
    expect(models.sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5']);
  });

  // ── Schema currency beats the model preference (the BNG bug) ───────────────────────────────
  //
  // A schema bump leaves pre-bump rows beside their regenerated twins (the unique key spans
  // model, and the bump adds another axis). The pick used to be `exact ?? narrated ?? newest`
  // over ALL of a period's rows — so with the account's narration model set to Sonnet, `exact`
  // model-matched a stale v1 Sonnet row over its fresh v2 Haiku twin and served v1's renamed
  // metric key (`median_time_to_first_review_hours`) to the SPA, whose meta table no longer
  // holds it. Every pick now runs inside schemaCurrentPool: the model preference is prose, the
  // schema is the contract.
  it('serves the CURRENT-schema row even when the preferred model matches only an older one', async () => {
    await run();
    // The pre-bump sibling: same period, the preferred model, NEWER, narrated — and carrying the
    // old vocabulary. Every axis of the old pick order would have chosen it.
    sqlite
      .prepare(
        `INSERT INTO workspace_period_reports
           (account_id, workspace_id, period_key, period_start, period_end, grain, cadence_days,
            repo_ids_json, coverage_json, metrics_json, metrics_schema_version, comparison_json,
            forecast_json, movements_json, suggested_json, narrative_md, model, payload_hash,
            data_fingerprint, generated_at)
         SELECT account_id, workspace_id, period_key, period_start, period_end, grain,
            cadence_days, repo_ids_json, coverage_json,
            '[{"key":"median_time_to_first_review_hours","value":0,"sampleSize":115,"lowSample":false}]',
            1, NULL,
            '[{"available":false,"key":"median_time_to_first_review_hours","reason":"too_volatile"}]',
            '[]', NULL, '**Old sprint prose.**', 'claude-sonnet-5', payload_hash || ':v1',
            data_fingerprint, generated_at + 3600
         FROM workspace_period_reports WHERE period_key = ? AND model = 'claude-haiku-5-5'`,
      )
      .run(target.key);

    const served = await loadStoredReport(ctx, 1, SCOPE, target, 'claude-sonnet-5');
    expect(served?.metricsSchemaVersion).toBe(2);
    expect(served?.model).toBe('claude-haiku-5-5'); // currency beat both `exact` and recency
    expect(
      served?.metrics.some((m) => (m.key as string) === 'median_time_to_first_review_hours'),
    ).toBe(false);

    // The list's metadata reads from the same pool: the period's narrated model is the v2 row's.
    const { periods: items } = await listPeriods(ctx, 1, SCOPE, grid);
    expect(items.find((i) => i.periodKey === target.key)?.model).toBe('claude-haiku-5-5');
  });

  it('serves the stored report on the free GET and only FLAGS staleness — never regenerates', async () => {
    await run();
    const fresh = await loadStoredReport(ctx, 1, SCOPE, target, 'claude-haiku-5-5');
    expect(fresh?.stale).toBe(false);
    expect(fresh?.narrative).toBe('**Sprint report.**');

    // The past moved underneath a report someone may already have forwarded.
    mergedThisPeriod = 44;
    const stale = await loadStoredReport(ctx, 1, SCOPE, target, 'claude-haiku-5-5');
    expect(stale?.stale).toBe(true);
    // ...and the stored numbers are UNTOUCHED: a stale badge, not a silent rewrite.
    expect(stale?.metrics.find((m) => m.key === 'merged_prs')?.value).toBe(20);
    expect(llmCalls).toBe(1);
  });

  it('lists the stored periods newest-first, marking which one carries prose', async () => {
    await run();
    const { periods: items } = await listPeriods(ctx, 1, SCOPE, grid);
    expect(items.map((i) => i.periodKey)).toEqual([...items.map((i) => i.periodKey)].sort().reverse());
    const targetItem = items.find((i) => i.periodKey === target.key);
    expect(targetItem?.hasNarrative).toBe(true);
    expect(targetItem?.model).toBe('claude-haiku-5-5');
    expect(items.filter((i) => i.hasNarrative)).toHaveLength(1);
  });
});

// ── The forecast series and workspace membership ─────────────────────────────────────────────
//
// ⚠ THE BUG THIS BLOCK EXISTS FOR: `coverage.complete` alone is NOT a comparability test, and
// using it as one let a repo onboarding be forecast as team growth — the exact artifact the whole
// coverage rule was written to refuse, arriving through a different door.
//
// A stored report is immutable (§6.3), so its `coverage` records the membership it was written
// UNDER. `{trackedRepos: 2, totalRepos: 2, complete: true}` and
// `{trackedRepos: 3, totalRepos: 3, complete: true}` both read "complete" and are two different
// workspaces' worth of repos. Seven quiet 2-repo sprints followed by one 3-repo sprint therefore
// produced a series with NO nulls and no refusal.
//
// The comparable test is the repo SET, which is what `repo_ids_json` is on the row for (§6.4) —
// it was being written and read nowhere.
// ── The forecast series ──────────────────────────────────────────────────────────────────────
//
// ⚠ TWO BUGS LIVE HERE, and the second was caused by fixing the first.
//
// FIRST: `coverage.complete` alone is not a comparability test. A stored report is immutable, so
// its coverage records the membership it was written UNDER — `{2 of 2}` and `{3 of 3}` both read
// "complete" and are different workspaces' worth of repos. Seven quiet 2-repo sprints followed by
// one 3-repo sprint fitted a line straight through the onboarding.
//
// SECOND: requiring the FULL CURRENT membership across the whole series is correct and useless.
// One repo added last week disqualifies every period, forever, no matter how much history the
// other repos have. Measured on the real dev corpus: a workspace with 8 repos, 7 of them tracked
// for 51–86 days, could not forecast at all because the eighth arrived 12 days ago.
//
// So the series is fitted on the largest repo subset tracked across enough periods, RE-MEASURED
// over exactly that subset for every period — and the subset is disclosed. Comparability comes
// from measuring the same repos each time, not from promising membership never changed.
describe('the forecast series', () => {
  const grid = gridOrThrow();
  const target = windowForKey(grid, periodKeyFor(START + 4 * CADENCE_MS))!;

  /** Records the scope every metric scan was taken over, plus the values core was handed. */
  function capturingCtx(tracked: (repoIds: number[], atMs: number) => number[]): {
    ctx: ProContext;
    scans: BotScopeWire[];
    seen: (number | null)[][];
  } {
    const scans: BotScopeWire[] = [];
    const seen: (number | null)[][] = [];
    const base = fakeCtx({
      metrics: (scope) => {
        scans.push(scope);
        return vec({ merged_prs: [20, 20] });
      },
      tracked,
    });
    const ctx = {
      ...base,
      queries: {
        ...base.queries,
        computePeriodForecast: async (values: (number | null)[]) => {
          seen.push(values);
          return { point: 1, low: 0, high: 2, basis: 'stub', periodsUsed: values.length };
        },
      },
    } as unknown as ProContext;
    return { ctx, scans, seen };
  }

  it('fits on ALL repos when every one has been tracked throughout', async () => {
    const { ctx, seen } = capturingCtx((repoIds) => repoIds);
    const built = await buildPeriod(ctx, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    expect(built.report.forecasts.every((f) => f.available)).toBe(true);
    expect(built.report.forecastDisclosure).toContain('all 3 repos');
    // No null slots: every period was measured over the same set.
    expect(seen[0]!.every((v) => v != null)).toBe(true);
  });

  // THE CASE THAT USED TO BE UNFORECASTABLE. Repo 3 arrived recently; repos 1 and 2 go back.
  it('still forecasts over the stable subset when one repo was onboarded recently', async () => {
    const recent = START + 3.5 * CADENCE_MS; // inside the target period
    const { ctx, scans, seen } = capturingCtx((repoIds, atMs) =>
      repoIds.filter((id) => id !== 3 || atMs >= recent),
    );
    const built = await buildPeriod(ctx, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);

    // A real forecast, not a refusal — this is the whole point of the change.
    expect(built.report.forecasts.every((f) => f.available)).toBe(true);
    // …and the reader is told what it covers.
    expect(built.report.forecastDisclosure).toContain('2 of 3 repos');

    // EVERY forecast scan was taken over the SAME subset. That is what makes the slots
    // comparable — not a promise about membership, but one measurement rule applied throughout.
    const forecastScans = scans.filter((s) => s.repoIds.join(',') === '1,2');
    expect(forecastScans.length).toBeGreaterThanOrEqual(4);
    expect(seen[0]!.every((v) => v != null)).toBe(true);
    // The workspace id rides along unchanged — it decides who counts as a bot.
    expect(forecastScans.every((s) => s.workspaceId === SCOPE.workspaceId)).toBe(true);
  });

  it('refuses when NO repo has been tracked long enough to span the minimum series', async () => {
    // Nothing tracked before the target period starts.
    const { ctx } = capturingCtx((repoIds, atMs) => (atMs >= target.fromMs ? repoIds : []));
    const built = await buildPeriod(ctx, 1, SCOPE, grid, target, 'claude-haiku-5-5', [], []);
    expect(built.report.forecasts.every((f) => !f.available)).toBe(true);
    expect(built.report.forecasts[0]).toMatchObject({ reason: 'partial_coverage' });
    // A refusal names itself and discloses nothing it did not do.
    expect(built.report.forecastDisclosure).toBeUndefined();
  });

  // The gate inside `buildForecasts` survives as a belt-and-braces invariant: the series it is now
  // handed is consistent by construction, but a future caller that mixes memberships must still
  // lose the incomparable slots rather than fit through them.
  it('buildForecasts still nulls a slot measured over a different repo set', async () => {
    const { ctx, seen } = capturingCtx((repoIds) => repoIds);
    const mk = (index: number, repoIds: number[]) => {
      const fromMs = START + index * CADENCE_MS;
      return {
        key: periodKeyFor(fromMs),
        fromMs,
        toMs: fromMs + CADENCE_MS,
        metrics: vec({ merged_prs: [20, 20] }),
        coverage: { trackedRepos: repoIds.length, totalRepos: repoIds.length, complete: true },
        repoIds,
      };
    };
    await buildForecasts(ctx, [mk(0, [1, 2]), mk(1, [1, 2, 3]), mk(2, [1, 2, 3])], [1, 2, 3]);
    expect(seen[0]![0]).toBeNull(); // the 2-repo period is dropped, not fitted through
    expect(seen[0]!.slice(1).every((v) => v != null)).toBe(true);
  });
});

// ── The forecast disclosure survives a round trip ────────────────────────────────────────────
//
// It appeared on the generate response and VANISHED on reload: `forecast_json` stored only the
// array, so `rowToReport` rebuilt a report with the bands but no statement of what they were
// fitted on. A projection over 6 of 8 repos that the reader believes covers all 8 is precisely the
// over-claim this feature exists to avoid — and it was invisible in exactly the state a forwarded
// link lands in.
describe('forecast_json round trip', () => {
  const grid = gridOrThrow();
  const target = windowForKey(grid, periodKeyFor(START + 4 * CADENCE_MS))!;
  const recent = START + 3.5 * CADENCE_MS;

  // ⚠ EVERY period migration, discovered rather than pinned. A hand-listed single file is how the
  // sibling settings fixture ended up failing on a column it had never created: the list silently
  // goes stale the moment a migration adds one the code under test selects by name.
  const MIGRATIONS = periodMigrationSql();
  const llm: LlmClient = {
    async complete() {
      return { text: '**Report.**', inputTokens: 3000, outputTokens: 400, costUsd: 0.005 };
    },
  };

  /** A throwaway in-memory DB on the real migration, with a configurable tracking rule. */
  function freshDb(tracked: (repoIds: number[], atMs: number) => number[]) {
    const sqlite = new Database(':memory:');
    sqlite.exec(PRO_SETTINGS_STUB);
    sqlite.exec(WORKSPACES_STUB);
    for (const sql of MIGRATIONS) sqlite.exec(sql);
    const seams = fakeCtx({ metrics: () => vec({ merged_prs: [20, 20] }), tracked });
    const ctx = {
      ...seams,
      db: drizzle(sqlite, { schema: { ...periodSchema } }),
      isPg: false,
      recordAiUsage: async () => {},
    } as unknown as ProContext;
    return { sqlite, ctx };
  }

  it('persists the disclosure and reads it back on the free GET', async () => {
    const { sqlite, ctx } = freshDb((repoIds, atMs) =>
      repoIds.filter((id) => id !== 3 || atMs >= recent),
    );
    const out = await generatePeriodReport(ctx, llm, 1, SCOPE, grid, target, 'claude-haiku-5-5');
    expect(out.report?.forecastDisclosure).toContain('2 of 3 repos');

    // The FREE cached read — the path a reload and a forwarded link both take.
    const stored = await loadStoredReport(ctx, 1, SCOPE, target, 'claude-haiku-5-5');
    expect(stored?.forecastDisclosure).toBe(out.report?.forecastDisclosure);
    expect(stored?.forecasts.length).toBe(out.report?.forecasts.length);
    sqlite.close();
  });

  it('reads a LEGACY bare-array row without inventing a disclosure', async () => {
    const { sqlite, ctx } = freshDb((repoIds) => repoIds);
    await generatePeriodReport(ctx, llm, 1, SCOPE, grid, target, 'claude-haiku-5-5');
    // Rewrite the column in the pre-disclosure shape, as an existing row would hold it.
    const row = sqlite
      .prepare('SELECT forecast_json FROM workspace_period_reports WHERE narrative_md IS NOT NULL')
      .get() as { forecast_json: string };
    const legacy = JSON.parse(row.forecast_json).forecasts;
    sqlite
      .prepare('UPDATE workspace_period_reports SET forecast_json = ? WHERE narrative_md IS NOT NULL')
      .run(JSON.stringify(legacy));

    const stored = await loadStoredReport(ctx, 1, SCOPE, target, 'claude-haiku-5-5');
    expect(stored?.forecasts.length).toBe(legacy.length); // the bands still load
    expect(stored?.forecastDisclosure).toBeUndefined(); // …and it claims nothing about them
    sqlite.close();
  });
});
