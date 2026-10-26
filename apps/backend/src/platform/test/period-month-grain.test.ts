// ── THE CALENDAR-MONTH GRAIN, AND THE OPEN MONTH ────────────────────────────────────────────
//
// Reports offers TWO period grids, and they coexist: the arithmetic sprint grid (a configured
// length in days, phase-anchored) and the CALENDAR, aligned to the 1st in UTC. Sprint stays the
// default; the calendar adds real months and a live month-to-date.
//
// Everything in this file exists because of two defects that were both SILENT — no error, no
// failing test, just a wrong document:
//
//   THE FEATURE-KILLER. The comparison refusal keyed on `cadenceDays` alone. January is 31 days
//   and February is 28, so at month grain EVERY month-over-month comparison would have answered
//   `cadence_changed` and shown no delta at all — which is exactly the comparison the grain exists
//   to provide. The refusal now keys on GRAIN FIRST, and on `cadenceDays` only WITHIN the sprint
//   grain (where the day count really is the configured setting).
//
//   THE COLUMN THAT WAS NEVER READ. `grain` has been on `workspace_period_reports` since the table
//   was created (`DEFAULT 'sprint'`, "so a second grain does not need a migration"), and four sites
//   hard-coded `grain: 'sprint'` on the way out. A month row would therefore have been PERSISTED
//   as 'month' and SERVED as 'sprint' — so the SPA would have titled it with the sprint formatter
//   ("1 Aug – 1 Sep", a 32-day span that does not exist) and the narration prompt would have been
//   handed the sprint grain's month-word BAN for a document that IS a month.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/period-month-grain.test.ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { PERIOD_METRIC_KEYS } from '@pierre-review/shared';
import type { PeriodMetricKey, PeriodMetricValue } from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import type { SprintCadence } from '../settings/store.js';
import * as periodSchema from '../insights/period-schema.sqlite.js';
import {
  buildMonthToDate,
  buildPeriod,
  completedWindows,
  generatePeriodReport,
  grainOfKey,
  listPeriods,
  loadStoredReport,
  parseArchivedKey,
  periodGrid,
  periodKeyFor,
  windowForKey,
} from '../insights/period-report.js';
import { formatPeriodRange } from '../insights/period-questions.js';

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
  'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);' +
  // The write-up tables plugin 0042 adds `provider` to that are created BEFORE 0025 (so not replayed
  // here); the others (synthesis, work plan, flow pointers) are created by the replayed files.
  ['sprint_reports', 'bot_theme_reports', 'pr_comment_annotations']
    .map((t) => `CREATE TABLE ${t} (id integer PRIMARY KEY, model text);`)
    .join('');

const DAY = 86_400_000;
// Mid-March 2026, so January (31d) and February (28d) are both COMPLETE and adjacent — the exact
// pair the day-count refusal used to reject.
const NOW = Date.parse('2026-03-17T09:30:00.000Z');
const SCOPE: BotScopeWire = { workspaceId: 7, repoIds: [1, 2, 3] };

// A sprint cadence IS configured, and the month grid must ignore it entirely.
const cadence = (days: number | null = 14): SprintCadence => ({
  cadenceDays: days,
  startAtMs: days == null ? null : Date.parse('2026-01-01T00:00:00.000Z'),
});

const monthGrid = periodGrid(cadence(), NOW, 'month')!;
const sprintGrid = periodGrid(cadence(), NOW)!;

const JAN = 'month-2026-01';
const FEB = 'month-2026-02';
const MAR = 'month-2026-03';

/** Metrics as a pure function of the window LENGTH in days — so a 31-day January and a 28-day
 *  February really do report different counts, which is what makes the comparison meaningful
 *  rather than a tautology. */
const vec = (days: number): PeriodMetricValue[] =>
  PERIOD_METRIC_KEYS.map((key: PeriodMetricKey) => ({
    key,
    value: key === 'merged_prs' ? days : null,
    sampleSize: key === 'merged_prs' ? days : 0,
  }));

const dayCount = (w: { fromMs: number; toMs: number }): number =>
  Math.round((w.toMs - w.fromMs) / DAY);

// ── The grid ────────────────────────────────────────────────────────────────────────────────
describe('the calendar-month grid', () => {
  it('needs NO configuration — the calendar is not a setting', () => {
    // The sprint half refuses outright without a cadence (§6.1: a period nobody chose is not an
    // artifact they will forward). A workspace that has never picked a sprint length still has an
    // August, so the month grid must never return null.
    expect(periodGrid(cadence(null), NOW)).toBeNull();
    expect(periodGrid(cadence(null), NOW, 'month')).not.toBeNull();
  });

  it('aligns periods to the 1st in UTC and carries each month’s REAL day count', () => {
    const done = completedWindows(monthGrid, 3);
    expect(done.map((w) => w.key)).toEqual([FEB, JAN, 'month-2025-12']);
    const [feb, jan] = done;
    expect(new Date(feb!.fromMs).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(new Date(feb!.toMs).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    // ⚠ NOT a sentinel 30 or 0 — the row's day count is a disclosure on a forwarded artifact and
    // an input to the payload hash, so it has to be the number of days actually measured.
    expect(feb!.cadenceDays).toBe(28);
    expect(jan!.cadenceDays).toBe(31);
    expect(feb!.grain).toBe('month');
  });

  it('excludes the OPEN month from the completed list, like the in-progress sprint', () => {
    expect(completedWindows(monthGrid, 12).map((w) => w.key)).not.toContain(MAR);
    expect(windowForKey(monthGrid, MAR)).toBeNull();
  });

  it('handles a leap February and a year boundary', () => {
    const g = periodGrid(cadence(), Date.parse('2028-05-02T00:00:00.000Z'), 'month')!;
    expect(windowForKey(g, 'month-2028-02')!.cadenceDays).toBe(29);
    const dec = windowForKey(g, 'month-2027-12')!;
    expect(new Date(dec.toMs).toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });
});

// ── The key space ───────────────────────────────────────────────────────────────────────────
describe('the two key shapes are disjoint, and the key names its own grid', () => {
  it('uses a MONTH key form — a YYYY-MM-DD start day cannot express a month', () => {
    expect(periodKeyFor(Date.parse('2026-01-01T00:00:00.000Z'), 'month')).toBe(JAN);
    expect(periodKeyFor(Date.parse('2026-01-01T00:00:00.000Z'))).toBe('sprint-2026-01-01');
    expect(grainOfKey(JAN)).toBe('month');
    expect(grainOfKey('sprint-2026-01-01')).toBe('sprint');
    expect(grainOfKey('month-2026-1')).toBeNull();
    expect(grainOfKey('nonsense')).toBeNull();
  });

  // ⚠ AN UNRESOLVABLE KEY MUST NOT BECOME A CLICKABLE BUTTON THAT OPENS BLANK — defect (b) in a
  // new costume. A month key asked of a sprint grid is not a near-miss to be snapped to a
  // boundary; it names a period on the OTHER grid.
  it('refuses a month key on the sprint grid and a sprint key on the month grid', () => {
    expect(windowForKey(sprintGrid, JAN)).toBeNull();
    expect(windowForKey(monthGrid, 'sprint-2026-01-01')).toBeNull();
    // ...and still refuses the shapes that were always wrong.
    expect(windowForKey(monthGrid, 'month-2026-13')).toBeNull();
    expect(windowForKey(monthGrid, 'month-not-a-date')).toBeNull();
  });

  it('parses an ARCHIVED month key, so an aged-out month stays readable', () => {
    // `archivedKeyFor` emits `<periodKey>@cad<days>` for either grain; a parser that only knew the
    // sprint shape would have emitted keys nothing could read back — listed, clickable, blank.
    expect(parseArchivedKey('month-2026-02@cad28')).toEqual({
      periodKey: FEB,
      cadenceDays: 28,
    });
    expect(parseArchivedKey('month-2026-02')).toBeNull();
  });
});

// ── The title ───────────────────────────────────────────────────────────────────────────────
describe('a month is NAMED, not ranged', () => {
  it('does not render the exclusive end boundary, which would read as a 32-day span', () => {
    const feb = windowForKey(monthGrid, FEB)!;
    const jan = windowForKey(monthGrid, JAN)!;
    expect(formatPeriodRange(jan.fromMs, jan.toMs, 'month')).toBe('January 2026');
    expect(formatPeriodRange(feb.fromMs, feb.toMs, 'month')).toBe('February 2026');
    // The sprint formatter — the one that would have been used, since the grain was hard-coded.
    expect(formatPeriodRange(jan.fromMs, jan.toMs)).toBe('1 Jan – 1 Feb');
  });
});

// ── The build ───────────────────────────────────────────────────────────────────────────────
describe('buildPeriod at month grain', () => {
  const ctx = (): ProContext =>
    ({
      queries: {
        getPeriodMetrics: async (
          _a: number,
          scope: BotScopeWire,
          window: { fromMs: number; toMs: number },
        ) => ({
          metrics: vec(dayCount(window)),
          fingerprint: `fp:${scope.repoIds.join(',')}:${window.fromMs}:${window.toMs}`,
        }),
        getPeriodCoverage: async (_a: number, repoIds: number[]) => ({ trackedRepoIds: repoIds }),
        computePeriodForecast: async () => ({
          point: 1,
          low: 0,
          high: 2,
          basis: 'theil-sen',
          periodsUsed: 8,
        }),
        getPeriodLanes: async () => ({
          lanes: [],
          automationMergeSharePct: 0,
          medianTimeToFirstHumanReviewHours: null,
          silentAutomation: [],
        }),
      },
    }) as unknown as ProContext;

  // ⚠ THE FEATURE-KILLER. 31 days against 28 must COMPARE.
  it('COMPARES February (28d) against January (31d) instead of refusing on the day count', async () => {
    const feb = windowForKey(monthGrid, FEB)!;
    // A stored January row at its real 31 days — the shape the old refusal tripped on.
    const priorRow = {
      periodKey: JAN,
      grain: 'month',
      cadenceDays: 31,
      generatedAt: new Date(NOW),
    } as never;
    const built = await buildPeriod(
      ctx(),
      1,
      SCOPE,
      monthGrid,
      feb,
      'claude-haiku-5-5',
      [],
      [priorRow],
    );
    expect(built.report.comparison.refusal).toBeNull();
    expect(built.report.comparison.priorPeriodKey).toBe(JAN);
    const merged = built.report.comparison.deltas.find((d) => d.key === 'merged_prs');
    expect(merged?.value).toBe(28);
    expect(merged?.prior).toBe(31);
  });

  // The refusal is not gone — it still fires when the stored prior is a DIFFERENT GRAIN.
  it('still refuses when the stored prior period sits on the other grid', async () => {
    const feb = windowForKey(monthGrid, FEB)!;
    const priorRow = {
      periodKey: JAN,
      grain: 'sprint',
      cadenceDays: 14,
      generatedAt: new Date(NOW),
    } as never;
    const built = await buildPeriod(
      ctx(),
      1,
      SCOPE,
      monthGrid,
      feb,
      'claude-haiku-5-5',
      [],
      [priorRow],
    );
    expect(built.report.comparison.refusal).toBe('cadence_changed');
    expect(built.report.comparison.deltas).toEqual([]);
  });

  // ⚠ TRAP (a): db/forecast.ts fits Theil-Sen on x = the ARRAY INDEX, i.e. it assumes the periods
  // are equally spaced. Calendar months are 28-31 days — a ±5.4% swing in every COUNT metric that
  // the estimator reads as signal, which would make February a genuine-looking dip EVERY YEAR.
  // The stub above always SUCCEEDS, so a forecast here could only come from actually fitting one.
  it('REFUSES the forecast at month grain, named, rather than fitting an unevenly-spaced series', async () => {
    const feb = windowForKey(monthGrid, FEB)!;
    const built = await buildPeriod(ctx(), 1, SCOPE, monthGrid, feb, 'claude-haiku-5-5', [], []);
    expect(built.report.forecasts).toHaveLength(PERIOD_METRIC_KEYS.length);
    for (const f of built.report.forecasts) {
      expect(f.available).toBe(false);
      if (!f.available) expect(f.reason).toBe('uneven_periods');
    }
    // ...and the sprint grain still forecasts, so the refusal is about the grain and not a
    // blanket switch-off.
    const sprintWin = completedWindows(sprintGrid, 1)[0]!;
    const sprintBuilt = await buildPeriod(
      ctx(),
      1,
      SCOPE,
      sprintGrid,
      sprintWin,
      'claude-haiku-5-5',
      [],
      [],
    );
    expect(sprintBuilt.report.forecasts.some((f) => f.available)).toBe(true);
  });

  it('carries the WINDOW’s grain and real day count onto the report', async () => {
    const feb = windowForKey(monthGrid, FEB)!;
    const built = await buildPeriod(ctx(), 1, SCOPE, monthGrid, feb, 'claude-haiku-5-5', [], []);
    expect(built.report.grain).toBe('month');
    expect(built.report.cadenceDays).toBe(28);
  });
});

// ── Storage: the round trip, and the open month that must never reach it ─────────────────────
describe('a month report through the database', () => {
  const MIGRATIONS = periodMigrationSql();
  let sqlite: Database.Database;
  let ctx: ProContext;

  const llm: LlmClient = {
    async complete() {
      return { text: '**February 2026.**', inputTokens: 3000, outputTokens: 400, costUsd: 0.005 };
    },
  };

  const storedRows = (): { period_key: string; grain: string; cadence_days: number }[] =>
    sqlite
      .prepare(
        'SELECT period_key, grain, cadence_days FROM workspace_period_reports ORDER BY period_key',
      )
      .all() as { period_key: string; grain: string; cadence_days: number }[];

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(
      PRO_SETTINGS_STUB,
    );
    sqlite.exec(
      WORKSPACES_STUB,
    );
    for (const sql of MIGRATIONS) sqlite.exec(sql);
    ctx = {
      db: drizzle(sqlite, { schema: { ...periodSchema } }),
      recordAiUsage: async () => {},
      queries: {
        getPeriodMetrics: async (
          _a: number,
          scope: BotScopeWire,
          window: { fromMs: number; toMs: number },
        ) => ({
          metrics: vec(dayCount(window)),
          fingerprint: `fp:${scope.repoIds.join(',')}:${window.fromMs}:${window.toMs}`,
        }),
        getPeriodCoverage: async (_a: number, repoIds: number[]) => ({ trackedRepoIds: repoIds }),
        computePeriodForecast: async () => ({ refused: 'insufficient_history' as const }),
        getPeriodLanes: async () => ({
          lanes: [],
          automationMergeSharePct: 0,
          medianTimeToFirstHumanReviewHours: null,
          silentAutomation: [],
        }),
      },
    } as unknown as ProContext;
  });

  // ⚠ THE SECOND SILENT DEFECT. `rowToReport` and three siblings hard-coded `grain: 'sprint'`, so
  // a month row would have been WRITTEN as 'month' and READ BACK as 'sprint'. Nothing threw; the
  // title formatter and the narration prompt would simply both have been wrong forever.
  it('round-trips the grain through storage — persisted as month, SERVED as month', async () => {
    const feb = windowForKey(monthGrid, FEB)!;
    const out = await generatePeriodReport(ctx, llm, 1, SCOPE, monthGrid, feb, 'claude-haiku-5-5');
    expect(out.generated).toBe(true);
    expect(out.report?.grain).toBe('month');

    // The COLUMN really holds it (the write half)...
    const row = storedRows().find((r) => r.period_key === FEB)!;
    expect(row.grain).toBe('month');
    expect(row.cadence_days).toBe(28);

    // ...and the read half serves it back rather than a literal.
    const reread = await loadStoredReport(ctx, 1, SCOPE, feb, 'claude-haiku-5-5');
    expect(reread?.grain).toBe('month');
    expect(reread?.cadenceDays).toBe(28);
    expect(reread?.periodKey).toBe(FEB);
  });

  // The backfill writes 8 prior periods metrics-only; every one of them is a month too.
  it('backfills PRIOR MONTHS at month grain, never sprint rows', async () => {
    const feb = windowForKey(monthGrid, FEB)!;
    await generatePeriodReport(ctx, llm, 1, SCOPE, monthGrid, feb, 'claude-haiku-5-5');
    const all = storedRows();
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((r) => r.grain === 'month')).toBe(true);
    expect(all.every((r) => r.period_key.startsWith('month-'))).toBe(true);
    // Each row carries ITS OWN month's length, not one shared number.
    const jan = all.find((r) => r.period_key === JAN)!;
    expect(jan.cadence_days).toBe(31);
  });

  // ⚠ EVERY LIST IS SCOPED TO ONE GRAIN. A month row seen from the sprint grid is not an archived
  // artifact — it is a live period one toggle away. Folding it into `archived` would show the whole
  // calendar history under "Earlier cadences" and list every document twice.
  it('never lets one grain’s rows leak into the other grain’s list or archive', async () => {
    const feb = windowForKey(monthGrid, FEB)!;
    await generatePeriodReport(ctx, llm, 1, SCOPE, monthGrid, feb, 'claude-haiku-5-5');

    const sprintList = await listPeriods(ctx, 1, SCOPE, sprintGrid);
    expect(sprintList.periods.every((p) => p.periodKey.startsWith('sprint-'))).toBe(true);
    expect(sprintList.archived).toEqual([]);

    const monthList = await listPeriods(ctx, 1, SCOPE, monthGrid);
    expect(monthList.periods.every((p) => p.periodKey.startsWith('month-'))).toBe(true);
    // Every listed period is one the detail read will actually serve — the open month excepted,
    // which is marked and served live.
    for (const p of monthList.periods) {
      if (p.inProgress) continue;
      expect(windowForKey(monthGrid, p.periodKey)).not.toBeNull();
    }
    // And the grain rides the wire, because two grains write one `insightsReportKey` field.
    expect(monthList.periods.every((p) => p.grain === 'month')).toBe(true);
  });

  it('lists the OPEN month, marked in progress and never narrated', async () => {
    const listing = await listPeriods(ctx, 1, SCOPE, monthGrid);
    const open = listing.periods.find((p) => p.periodKey === MAR);
    expect(open).toBeDefined();
    expect(open?.inProgress).toBe(true);
    expect(open?.hasNarrative).toBe(false);
    expect(open?.model).toBeNull();
    // The sprint list has no such entry: the in-progress sprint is already the whole subject of
    // the free flow-metrics header on this same pane.
    const sprintList = await listPeriods(ctx, 1, SCOPE, sprintGrid);
    expect(sprintList.periods.some((p) => p.inProgress)).toBe(false);
  });

  // ⚠ MONTH-TO-DATE MUST NEVER PERSIST. Two mechanisms make an open period unstorable: the free
  // GET recomputes every stored row's data fingerprint (which folds every metric value, so an open
  // month would read `stale` on essentially every load, forever, next to a Generate button), and
  // `payloadHashFor` folds nothing `Date.now()`-derived (or a dormant workspace re-bills on a
  // timer) — while an open period's upper bound IS `Date.now()`.
  it('computes month-to-date WITHOUT writing a row, calling a model, or spending anything', async () => {
    // ⚠ THE MODEL IS RULED OUT STRUCTURALLY, NOT BY A SPY: `buildMonthToDate` takes no `LlmClient`
    // argument at all, so there is no seam through which it could bill. What
    // this test has to pin is the other half — that it writes nothing.
    expect(storedRows()).toEqual([]);
    const mtd = await buildMonthToDate(ctx, 1, SCOPE, NOW);
    // Nothing written. Not one row, at any key.
    expect(storedRows()).toEqual([]);
    expect(mtd.narrative).toBeNull();
    expect(mtd.model).toBeNull();
    // ...and it never claims to be stale, because there is nothing to regenerate.
    expect(mtd.stale).toBe(false);
    expect(mtd.inProgress).toBe(true);
    expect(mtd.grain).toBe('month');
    expect(mtd.periodKey).toBe(MAR);
    // Re-reading it a second time still writes nothing.
    await buildMonthToDate(ctx, 1, SCOPE, NOW + 60_000);
    expect(storedRows()).toEqual([]);
  });
});

// ── Month to date: the elapsed-slice comparison ─────────────────────────────────────────────
describe('month to date compares like for like', () => {
  const ctx = (): ProContext =>
    ({
      queries: {
        getPeriodMetrics: async (
          _a: number,
          scope: BotScopeWire,
          window: { fromMs: number; toMs: number },
        ) => ({
          // Half-day resolution, so a 16-day slice and a 17-day headline are visibly different
          // numbers rather than rounding to the same integer.
          metrics: vec(Math.round(((window.toMs - window.fromMs) / DAY) * 10) / 10),
          fingerprint: `fp:${scope.repoIds.join(',')}:${window.fromMs}:${window.toMs}`,
        }),
        getPeriodCoverage: async (_a: number, repoIds: number[]) => ({ trackedRepoIds: repoIds }),
        computePeriodForecast: async () => ({ refused: 'insufficient_history' as const }),
        getPeriodLanes: async () => ({
          lanes: [],
          automationMergeSharePct: 0,
          medianTimeToFirstHumanReviewHours: null,
          silentAutomation: [],
        }),
      },
    }) as unknown as ProContext;

  // ⚠ NOT 17 DAYS OF MARCH AGAINST THE WHOLE OF FEBRUARY. That "drop" would be the calendar, not
  // the team. Both sides are measured over the SAME number of milliseconds from their own month's
  // start, and the disclosure says so.
  it('compares the same stretch of the previous month, not the whole of it', async () => {
    const mtd = await buildMonthToDate(ctx(), 1, SCOPE, NOW);
    expect(mtd.comparison.refusal).toBeNull();
    expect(mtd.comparison.priorPeriodKey).toBe(FEB);
    const d = mtd.comparison.deltas.find((x) => x.key === 'merged_prs')!;
    // 16 days and 9.5 hours elapsed → the same slice on both sides, so the delta is exactly zero.
    expect(d.value).toBe(d.prior);
    expect(mtd.comparison.subsetDisclosure).toContain('of each');
    // The HEADLINE covers [1 Mar, now) over the full membership and is a DIFFERENT population
    // from the delta — the standing rule, which `rowFigures()` already resolves on the client.
    expect(mtd.metrics.find((m) => m.key === 'merged_prs')?.value).toBeCloseTo(16.4, 1);
    expect(mtd.elapsedDays).toBe(16);
  });

  // ⚠ ON 31 MARCH, 30 DAYS HAVE ELAPSED AND FEBRUARY ONLY HAS 28. Clamping ONE side would subtract
  // windows of different lengths, which is the exact thing `cadence_changed` exists to refuse.
  it('clamps the slice to the SHORTER month and uses the clamped length on BOTH sides', async () => {
    const late = Date.parse('2026-03-31T12:00:00.000Z');
    const mtd = await buildMonthToDate(ctx(), 1, SCOPE, late);
    const d = mtd.comparison.deltas.find((x) => x.key === 'merged_prs')!;
    expect(d.value).toBe(28);
    expect(d.prior).toBe(28);
    expect(mtd.comparison.subsetDisclosure).toContain('first 28 days');
    // The headline still covers the whole elapsed month — 30.5 days — and says so. Two
    // populations, disclosed, never mixed into one subtraction.
    expect(mtd.metrics.find((m) => m.key === 'merged_prs')?.value).toBeCloseTo(30.5, 1);
    expect(mtd.elapsedDays).toBe(30);
  });

  it('offers no forecast and no drill-down pills on an open period', async () => {
    const mtd = await buildMonthToDate(ctx(), 1, SCOPE, NOW);
    expect(mtd.suggested).toEqual([]);
    expect(mtd.forecasts.every((f) => !f.available)).toBe(true);
  });
});
