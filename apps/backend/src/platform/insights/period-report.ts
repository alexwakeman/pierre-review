import { PERIOD_METRIC_KEYS, PERIOD_SERIES_MONTHS, PERIOD_SERIES_WEEKS } from '@pierre-review/shared';
import type {
  PeriodCoverage,
  PeriodForecast,
  PeriodGrain,
  PeriodLanes,
  PeriodMetricDelta,
  PeriodMetricDirection,
  PeriodMetricKey,
  PeriodMetricValue,
  PeriodRefusalReason,
  PeriodSeriesPoint,
  PeriodSeriesResponse,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import { currentSprintWindow, type SprintCadence } from '../settings/store.js';

// ── REPORTS → PERIOD REPORTS: THE SERIES (docs/PERIOD-REPORTING.md § The series) ───────────────
//
// CODE ONLY. The period grid (sprint or calendar month), the like-for-like deltas with their
// significance floors, the forecast over one repo set, and `buildPeriodSeries`, which the ONE
// Reports route serves. The stored, AI-narrated report pipeline that lived here (generation,
// backfill, storage, the payload hash, month-to-date, listing) was REMOVED 2026-11-08; its table
// `workspace_period_reports` stays dormant (still erased with the account).

/** 'YYYY-MM-DD' in UTC — a sprint period's identity. */
function periodDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 'YYYY-MM' in UTC — a calendar month's identity (a day form cannot tell a month from a sprint
 *  that starts on the 1st). */
function periodMonthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

// The SIGNIFICANCE table, MIRRORED from `PERIOD_METRIC_META` in core's db/period-metrics.ts.
//
// ⚠ IT IS A COPY, AND THAT IS A KNOWN COST. The floors belong beside the metric definitions in
// core, but the plugin computes the deltas — it is the side that holds the stored history and
// therefore the only side that has both periods — and `ProHostQueries` carries no seam for the
// meta. `Record<PeriodMetricKey, …>` at least makes a metric added at schema version 2 a COMPILE
// error here rather than a silently unrankable one; if the two ever disagree, CORE WINS and this
// table is the one to fix.
interface PeriodMetricMeta {
  direction: PeriodMetricDirection;
  /** Minimum items behind the statistic on BOTH sides before a change may be called significant. */
  sampleFloor: number;
  /** Minimum |change|, in the metric's OWN units (hours, points, lines, count, ratio). */
  absoluteFloor: number;
}

export const PERIOD_METRIC_META: Record<PeriodMetricKey, PeriodMetricMeta> = {
  merged_prs: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 3 },
  human_merged_prs: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 3 },
  opened_prs: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 3 },
  automation_merge_share_pct: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 5 },
  median_lead_time_hours: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 2 },
  median_time_to_first_human_review_hours: {
    direction: 'down_good',
    sampleFloor: 5,
    absoluteFloor: 1,
  },
  merge_ci_success_pct: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 5 },
  median_pr_size_lines: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 20 },
  median_human_pr_size_lines: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 20 },
  review_threads_opened: { direction: 'neutral', sampleFloor: 10, absoluteFloor: 5 },
  threads_replied_within_36h_pct: { direction: 'up_good', sampleFloor: 10, absoluteFloor: 5 },
  bot_review_comments: { direction: 'neutral', sampleFloor: 10, absoluteFloor: 5 },
  human_review_comments: { direction: 'up_good', sampleFloor: 10, absoluteFloor: 5 },
  bot_comments_per_merged_pr: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 0.5 },
  reviewer_concentration_pct: { direction: 'down_good', sampleFloor: 10, absoluteFloor: 5 },
};

// ── Period identity + the cadence grid ───────────────────────────────────────────────────────

export interface PeriodWindow {
  /** At `'sprint'` grain: 0 = the first period after the configured sprint start (indices go
   *  NEGATIVE — the start is a phase anchor). At `'month'` grain: whole months since 1970-01 UTC,
   *  so the index is an absolute calendar address and never needs configuring. */
  index: number;
  fromMs: number;
  /** EXCLUSIVE, matching the metric vector's half-open `[from, to)` predicates. */
  toMs: number;
  key: string;
  /** The window's REAL length in days: the configured cadence at sprint grain, 28-31 at month
   *  grain. ⚠ Never a sentinel — it is a disclosure on a forwarded artifact and an input to the
   *  payload hash. */
  cadenceDays: number;
  grain: PeriodGrain;
}

/**
 * The period grid, as a UNION ON THE GRAIN rather than one shape with unused fields.
 *
 * ⚠ THE UNION IS THE ENFORCEMENT. A month grid has no phase anchor, no configured length and no
 * fixed period duration, so `startMs` / `cadenceDays` / `cadenceMs` are not merely unused there —
 * any value they could hold would be a lie (30? 0? the length of *which* month?). Making them
 * absent turns every read of them into a compile error that has to be answered per grain, which
 * is how the cadence-vs-grain confusion below gets caught at build time instead of by a reader.
 */
export type PeriodGrid =
  | {
      grain: 'sprint';
      startMs: number;
      cadenceDays: number;
      cadenceMs: number;
      /** Index of the period containing `now` — IN PROGRESS, and therefore not reportable. */
      currentIndex: number;
    }
  | {
      grain: 'month';
      /** Whole months since 1970-01 (UTC) containing `now` — the OPEN month. */
      currentIndex: number;
    };

/** Whole months since 1970-01, UTC. The calendar grid's index — absolute, so it needs no anchor. */
function monthIndexOf(ms: number): number {
  const d = new Date(ms);
  return (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth();
}

/** The UTC-midnight first-of-month for a month index. */
function monthStartMs(index: number): number {
  const year = 1970 + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  return Date.UTC(year, month, 1);
}

/**
 * The period key.
 *
 *  • sprint → `'sprint-' + <period start as YYYY-MM-DD, UTC>` (§5). Deliberately NOT the plan's
 *    `s:…` form: this travels in a URL PATH SEGMENT and a colon there is needless encoding risk.
 *  • month  → `'month-' + <YYYY-MM, UTC>`.
 *
 * ⚠ THE TWO SHAPES ARE DISJOINT AND THE PREFIX IS LOAD-BEARING. One key space serves both grains
 * — one `?report=` URL parameter, one `insightsReportKey` store field, one stored `period_key`
 * column, one unique index. The prefix is what lets `grainOfKey` answer "what does this document
 * measure" from the key alone, which is why no route needs a `?grain=` parameter beside a key it
 * was already given.
 *
 * ⚠ MONTHS ALIGN TO UTC MIDNIGHT ON THE 1st, like every other boundary in this feature (the
 * sprint start is stored at UTC midnight, `periodDayKey` is UTC, the SPA titles in UTC). They are
 * deliberately NOT aligned to the Slack digest's send-time zone (`workspace_slack_targets.timezone`
 * since plugin 0030; it was `pro_settings.slack_timezone`): that column decides when a NOTIFICATION
 * goes out, and hanging the report grid off it would (a) move a stored artifact's window
 * when somebody edited an unrelated notification setting, and (b) make the period key
 * (`month-2026-08`) disagree with its own start instant for every reader east of Greenwich.
 */
export function periodKeyFor(fromMs: number, grain: PeriodGrain = 'sprint'): string {
  return grain === 'month' ? `month-${periodMonthKey(fromMs)}` : `sprint-${periodDayKey(fromMs)}`;
}

/** What a period key SAYS it measures, from its shape alone. Null for anything that is neither. */
export function grainOfKey(key: string): PeriodGrain | null {
  if (/^sprint-\d{4}-\d{2}-\d{2}$/.test(key)) return 'sprint';
  if (/^month-\d{4}-\d{2}$/.test(key)) return 'month';
  return null;
}

/**
 * The cadence grid, derived from the SAME `currentSprintWindow` machinery the Insights window
 * uses — deliberately, so a period boundary here and a sprint boundary there can never drift.
 * It takes the RESOLVED `SprintCadence` (see `resolveSprintCadence`), which is a per-WORKSPACE
 * fact: two workspaces on one account legitimately sit on two different grids.
 * Null when no cadence is configured, which is the ONE state that makes the SPRINT half of this
 * surface refuse to generate (§6.1): a period the user never chose is not an artifact they will
 * forward, so there is no silent fallback to a rolling fortnight.
 *
 * ⚠ THE MONTH GRID NEEDS NO CONFIGURATION AND THEREFORE NEVER RETURNS NULL. The calendar is not a
 * setting: a workspace that has never chosen a sprint length still has an August. `cadence` is
 * ignored entirely at that grain — reading it would be the beginning of the coupling the grain is
 * kept out of the settings row to avoid. `grain` is a TRAILING OPTIONAL parameter, so every
 * existing sprint call site is byte-identical.
 */
export function periodGrid(
  cadence: SprintCadence,
  nowMs: number,
  grain: PeriodGrain = 'sprint',
): PeriodGrid | null {
  if (grain === 'month') return { grain: 'month', currentIndex: monthIndexOf(nowMs) };
  const current = currentSprintWindow(cadence, nowMs);
  const cadenceDays = cadence.cadenceDays;
  const startMs = cadence.startAtMs;
  if (current == null || cadenceDays == null || cadenceDays < 1 || !startMs) return null;
  const cadenceMs = cadenceDays * 86_400_000;
  return {
    grain: 'sprint',
    startMs,
    cadenceDays,
    cadenceMs,
    currentIndex: Math.round((current.fromMs - startMs) / cadenceMs),
  };
}

/**
 * The window at one index. ⚠ THE ONLY PLACE THE TWO GRAINS' ARITHMETIC FORKS — everything above
 * it (which indices exist, how far back the grid reaches) and everything below it (metrics,
 * coverage, comparison, storage) is grain-agnostic and stays that way.
 *
 * At month grain `cadenceDays` is the REAL length of that month, computed from the two boundaries
 * rather than assumed: February 2026 stores 28 and January stores 31, and a stored artifact must
 * carry the number of days it actually measured.
 */
function windowAt(grid: PeriodGrid, index: number): PeriodWindow {
  if (grid.grain === 'month') {
    const fromMs = monthStartMs(index);
    const toMs = monthStartMs(index + 1);
    return {
      index,
      fromMs,
      toMs,
      key: periodKeyFor(fromMs, 'month'),
      cadenceDays: Math.round((toMs - fromMs) / 86_400_000),
      grain: 'month',
    };
  }
  const fromMs = grid.startMs + index * grid.cadenceMs;
  return {
    index,
    fromMs,
    toMs: fromMs + grid.cadenceMs,
    key: periodKeyFor(fromMs),
    cadenceDays: grid.cadenceDays,
    grain: 'sprint',
  };
}

/**
 * How far back the grid may be extrapolated, in periods. At a 14-day cadence this is a year; at
 * calendar-month grain it is a little over two years.
 *
 * It exists only so a hand-typed `?report=sprint-1970-01-01` cannot ask us to scan a window from
 * before the product existed; the real limit on useful history is the data (and the coverage rule),
 * not this number.
 */
const MAX_HISTORY_PERIODS = 26;

/**
 * The shortest series worth choosing a repo subset for. MIRRORS core's `MIN_FORECAST_POINTS`
 * (db/forecast.ts), which cannot be imported across the open-core boundary.
 *
 * Drift here is SAFE IN ONE DIRECTION and that is why a mirrored constant is acceptable: core is
 * the enforcer, so if core's minimum rose above this we would hand it a short series and get an
 * `insufficient_history` refusal — the honest answer, just reached a step later. It can never
 * produce a forecast core would have declined.
 */
const MIN_FORECAST_POINTS = 4;

/**
 * The most recent COMPLETED periods, newest first. The in-progress period is excluded on purpose:
 * its numbers move under the reader, so every free GET would recompute a different fingerprint and
 * flag the stored row stale forever — inviting a regeneration that changes and re-bills daily.
 *
 * ⚠ THE SPRINT START DATE IS A PHASE ANCHOR, NOT A PROJECT START — indices go NEGATIVE.
 *
 * This used to stop at index 0, treating the configured `sprintStartAt` as the beginning of
 * recorded history. It is not: it is the date the team happened to enter when they set their
 * cadence, and it says only WHERE the fortnightly boundaries fall, not when the team started
 * working. A workspace with two years of PRs and a sprint start entered six weeks ago had three
 * reportable periods and could never forecast, while all the data needed sat in the database.
 *
 * Extending backward on the same phase keeps every boundary aligned with the team's real sprint
 * rhythm — a period before the anchor is the same fortnight the team would have called a sprint,
 * just one they had not written down yet.
 */
export function completedWindows(grid: PeriodGrid, limit: number): PeriodWindow[] {
  const out: PeriodWindow[] = [];
  const earliest = grid.currentIndex - MAX_HISTORY_PERIODS;
  for (let i = grid.currentIndex - 1; i >= earliest && out.length < limit; i -= 1) {
    out.push(windowAt(grid, i));
  }
  return out;
}


// ── Host-seam result shapes (cast locally; the seam is typed `Promise<unknown>`) ─────────────

interface PeriodMetricsResult {
  metrics: PeriodMetricValue[];
  fingerprint: string;
}

interface PeriodCoverageResult {
  trackedRepoIds: number[];
}

type ForecastOutcome =
  | { point: number; low: number; high: number; basis: string; periodsUsed: number }
  | { refused: 'insufficient_history' | 'too_volatile' };

// Effort vs automation for one window. Its comment count spans inline comments, PR comments AND
// review bodies — unlike the metric vector's inline-only figure, which is what made a workspace
// with 786 SonarQube comments report zero bot activity.
const lanesFor = async (
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  window: PeriodWindow,
): Promise<PeriodLanes> =>
  (await ctx.queries.getPeriodLanes(accountId, scope, window)) as PeriodLanes;

const metricsFor = (
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  window: { fromMs: number; toMs: number },
): Promise<PeriodMetricsResult> =>
  ctx.queries.getPeriodMetrics(accountId, scope, window) as Promise<PeriodMetricsResult>;

const coverageFor = (
  ctx: ProContext,
  accountId: number,
  repoIds: number[],
  atMs: number,
): Promise<PeriodCoverageResult> =>
  ctx.queries.getPeriodCoverage(accountId, repoIds, atMs) as Promise<PeriodCoverageResult>;

// ── Deltas, movements, forecasts ─────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

function metricMap(metrics: PeriodMetricValue[]): Map<PeriodMetricKey, PeriodMetricValue> {
  return new Map(metrics.map((m) => [m.key, m]));
}

/**
 * This-vs-prior for every metric, over the coverage-stable subset.
 *
 * ⚠ THE THIRD SIGNIFICANCE CONDITION — "both periods are coverage-comparable" — IS ENFORCED
 * STRUCTURALLY, not by a flag here. `buildPeriod` only reaches this function once it has a
 * non-empty intersection of the two tracked sets and a matching cadence; every other case
 * short-circuits into a named `refusal` with NO deltas at all. A `coverageComparable` parameter
 * lived here briefly and was always passed `true` — a guard that cannot fire looks like coverage
 * and provides none, so it was removed rather than left as decoration.
 *
 * Both other conditions are applied per metric: the sample floor on BOTH sides (a swing measured
 * over four items is not a trend on either end of it) and the absolute floor on the change. A
 * delta that fails them is still CARRIED — the raw figures are real — it just may not be called
 * a change.
 */
export function buildDeltas(
  current: PeriodMetricValue[],
  prior: PeriodMetricValue[],
): PeriodMetricDelta[] {
  const priorByKey = metricMap(prior);
  return current.map((cur) => {
    const meta = PERIOD_METRIC_META[cur.key];
    const pri = priorByKey.get(cur.key);
    const priorValue = pri?.value ?? null;
    const absoluteChange =
      cur.value != null && priorValue != null ? round2(cur.value - priorValue) : null;
    const percentChange =
      absoluteChange != null && priorValue != null && priorValue !== 0
        ? round2((absoluteChange / priorValue) * 100)
        : null;
    const significant =
      absoluteChange != null &&
      cur.sampleSize >= meta.sampleFloor &&
      (pri?.sampleSize ?? 0) >= meta.sampleFloor &&
      Math.abs(absoluteChange) >= meta.absoluteFloor;
    return {
      key: cur.key,
      value: cur.value,
      prior: priorValue,
      absoluteChange,
      percentChange,
      significant,
      direction: meta.direction,
      // The thinness of the figure the ROW ACTUALLY SHOWS. When a comparison exists the row
      // renders `delta.value` (the coverage-stable subset), so it must be the SUBSET's sample
      // that is marked — the headline's `lowSample` describes a different, larger population and
      // would under-report thinness on exactly the workspaces where the subset is small.
      lowSample: cur.sampleSize < meta.sampleFloor,
    } satisfies PeriodMetricDelta;
  });
}


/** The metrics measured on a 0–100 scale. Their forecast declares a ceiling of 100; without it a
 *  rising series projects "CI success ≈ 104% (98–110%)", which is not a bold call but an
 *  impossible number. Kept beside the forecast rather than in core because the SCALE is a property
 *  of the metric definition, and core's estimator is deliberately told nothing about the metric. */
const PCT_METRIC_KEYS = new Set<PeriodMetricKey>([
  'merge_ci_success_pct',
  'threads_replied_within_36h_pct',
  'reviewer_concentration_pct',
  // ⚠ ADDING A `_pct` METRIC WITHOUT ADDING IT HERE is a silent defect, not a compile error: the
  // series fits fine and simply projects an impossible number. A rising automation share would
  // forecast "112% of merges authored by automation".
  'automation_merge_share_pct',
]);

interface HistoryPeriod {
  key: string;
  fromMs: number;
  toMs: number;
  metrics: PeriodMetricValue[];
  coverage: PeriodCoverage;
  /** The repo set the row's metrics were actually computed over, from the stored
   *  `repo_ids_json`. Load-bearing for the forecast — see the second warning on
   *  `buildForecasts`. Empty for a row written before the column carried a value. */
  repoIds: number[];
}

/** Exported for its unit test only — the belt-and-braces membership gate below is worth pinning
 *  independently of the series `buildPeriod` now hands it. */
export async function buildForecasts(
  ctx: ProContext,
  history: HistoryPeriod[],
  scopeRepoIds: number[],
): Promise<PeriodForecast[]> {
  const keys = history[history.length - 1]?.metrics.map((m) => m.key) ?? [];
  // ⚠ `coverage.complete` ALONE IS NOT A COMPARABILITY TEST, and using it as one reintroduced the
  // exact artifact this feature exists to refuse.
  //
  // A stored row is immutable (§6.3), so its `coverage` records the membership it was written
  // UNDER: `{trackedRepos: 2, totalRepos: 2, complete: true}` and
  // `{trackedRepos: 3, totalRepos: 3, complete: true}` are both "complete" and are two different
  // workspaces' worth of repos. Seven sprints at 2 repos (20 merges each) followed by one at 3
  // repos (120 merges) therefore produced the series [20,20,20,20,20,20,20,120] with NO nulls and
  // no refusal — a forecast fitted straight through a repo onboarding, which is the failure the
  // coverage rule was written to prevent, arriving by a different door.
  //
  // The comparable test is the repo SET, which is why `repo_ids_json` is on the row (§6.4). It was
  // being written and read nowhere.
  const scopeKey = [...scopeRepoIds].sort((a, b) => a - b).join(',');
  return Promise.all(
    keys.map(async (key): Promise<PeriodForecast> => {
      const values = history.map((h) => {
        if (!h.coverage.complete) return null;
        // A row predating the column has no set to compare and cannot be shown to be comparable.
        // Excluding it costs a forecast point; including it risks fitting across a membership
        // change, which is the error that matters.
        if (h.repoIds.length === 0) return null;
        if ([...h.repoIds].sort((a, b) => a - b).join(',') !== scopeKey) return null;
        return metricMap(h.metrics).get(key)?.value ?? null;
      });
      // The three 0–100 metrics declare their ceiling; everything else has none. Core will not
      // infer one — see the seam's comment for why inferring would truncate a real count forecast.
      const outcome = (await ctx.queries.computePeriodForecast(
        values,
        PCT_METRIC_KEYS.has(key) ? { max: 100 } : undefined,
      )) as ForecastOutcome;
      if ('refused' in outcome) return { available: false, key, reason: outcome.refused };
      return {
        available: true,
        key,
        point: outcome.point,
        low: outcome.low,
        high: outcome.high,
        basis: outcome.basis,
        periodsUsed: outcome.periodsUsed,
      };
    }),
  );
}

// ── THE PERIOD SERIES (Reports → Period reports, the chart) ───────────────────────────────────
//
// Every completed period in the reading window, oldest first, ALL measured over ONE repo set — the
// repos tracked since the oldest period shown — so each line is one population and never a repo
// onboarding schedule (§ Retroactive history is COVERAGE-BIASED). The deltas compare each period
// with the one before it over the same set: like-for-like by construction, with the server's own
// significance floors. The forecast is the fit `chooseForecastSeries` would make, over THIS set and
// these windows; refused at month grain (`uneven_periods`) and on too little history.
//
// ⚠ DB ONLY. No model call, no stored row, no payload hash: it is recomputed on every read, so
// nothing here can go stale or bill. Cost: one metric scan and one lane scan per period (≤ 12 + 12),
// plus one coverage read per period dropped for having no tracked repo.

/** How many completed periods the series reads: 12 weeks of sprints (at least 2), or 6 months. */
export function seriesLength(grid: PeriodGrid): number {
  if (grid.grain === 'month') return PERIOD_SERIES_MONTHS;
  return Math.min(12, Math.max(2, Math.floor((PERIOD_SERIES_WEEKS * 7) / grid.cadenceDays)));
}

export async function buildPeriodSeries(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  grid: PeriodGrid,
): Promise<Omit<PeriodSeriesResponse, 'enabled' | 'workspaceId' | 'cadenceConfigured'>> {
  const grain = grid.grain;
  const cadenceDays = grid.grain === 'sprint' ? grid.cadenceDays : null;
  const empty = (measured: number) => ({
    grain,
    cadenceDays,
    periods: [],
    repos: { measured, total: scope.repoIds.length },
    next: null,
    forecasts: PERIOD_METRIC_KEYS.map((key): PeriodForecast => ({ available: false, key, reason: 'insufficient_history' })),
    forecastDisclosure: null,
  });
  // Oldest first.
  let windows = completedWindows(grid, seriesLength(grid)).reverse();
  // The repo set: tracked since the oldest period's start. A period before ANY repo was tracked has
  // nothing to measure, so it is dropped rather than drawn as a zero.
  let repoIds: number[] = [];
  while (windows.length > 0) {
    const tracked = await coverageFor(ctx, accountId, scope.repoIds, windows[0]!.fromMs);
    repoIds = [...tracked.trackedRepoIds].sort((a, b) => a - b);
    if (repoIds.length > 0) break;
    windows = windows.slice(1);
  }
  if (windows.length === 0) return empty(0);
  const subset: BotScopeWire = { workspaceId: scope.workspaceId, repoIds };
  const measured = await Promise.all(
    windows.map(async (win) => {
      const [metrics, lanes] = await Promise.all([
        metricsFor(ctx, accountId, subset, win),
        // Over the FULL membership, like the report's lanes: its own population, labelled apart.
        lanesFor(ctx, accountId, scope, win).catch(() => null),
      ]);
      return { win, metrics: metrics.metrics, lanes };
    }),
  );
  const periods: PeriodSeriesPoint[] = measured.map((m, i) => ({
    periodKey: m.win.key,
    periodStart: new Date(m.win.fromMs).toISOString(),
    periodEnd: new Date(m.win.toMs).toISOString(),
    cadenceDays: m.win.cadenceDays,
    metrics: m.metrics,
    deltas: i === 0 ? [] : buildDeltas(m.metrics, measured[i - 1]!.metrics),
    lanes: m.lanes,
  }));

  // The projection slot is the period in progress.
  const nextWin = windowAt(grid, grid.currentIndex);
  const next = { periodKey: nextWin.key, periodStart: new Date(nextWin.fromMs).toISOString(), periodEnd: new Date(nextWin.toMs).toISOString() };
  let forecasts: PeriodForecast[];
  let forecastDisclosure: string | null = null;
  if (grain === 'month') {
    forecasts = PERIOD_METRIC_KEYS.map((key) => ({ available: false, key, reason: 'uneven_periods' as const }));
  } else if (periods.length < MIN_FORECAST_POINTS) {
    forecasts = PERIOD_METRIC_KEYS.map((key) => ({ available: false, key, reason: 'insufficient_history' as const }));
  } else {
    const coverage: PeriodCoverage = { trackedRepos: repoIds.length, totalRepos: repoIds.length, complete: true };
    const history: HistoryPeriod[] = measured.map((m) => ({ key: m.win.key, fromMs: m.win.fromMs, toMs: m.win.toMs, metrics: m.metrics, coverage, repoIds }));
    forecasts = await buildForecasts(ctx, history, repoIds);
    forecastDisclosure = `fitted on ${periods.length} periods`;
  }
  return { grain, cadenceDays, periods, repos: { measured: repoIds.length, total: scope.repoIds.length }, next, forecasts, forecastDisclosure };
}
