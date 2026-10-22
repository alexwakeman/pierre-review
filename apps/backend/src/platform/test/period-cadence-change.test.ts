// ── WHAT HAPPENS TO STORED REPORTS WHEN THE SPRINT CADENCE CHANGES ──────────────────────────
//
// period-report.test.ts covers the grid and the off-grid key refusal, but NEVER a cadence CHANGE
// — which is exactly why three defects survived to production in a feature whose entire premise is
// "a stored report is an artifact somebody forwarded".
//
// THE COLLISION THAT MAKES ALL THREE POSSIBLE. A period key names a START DAY
// (`sprint-YYYY-MM-DD`), and the same day begins a period at more than one cadence: from the same
// anchor, index 4 of a 14-day grid and index 8 of a 7-day grid BOTH start on day 56. Two rows, two
// different windows (14 days vs 7), one key.
//
//   (a) SILENT OVERWRITE. `loadStoredReport` matched on the key ALONE and `persistReport` upserted
//       on (account, workspace, period_key, model) with `set: values` carrying `period_end` and
//       `cadence_days`. Regenerating after a 14 → 7 change rewrote the stored row IN PLACE: same
//       name, a different window's numbers, in a document already in somebody's inbox.
//   (b) LISTED-BUT-BLANK. `listPeriods` emitted every stored row regardless of grid alignment while
//       the detail GET refuses a non-aligned key, so after a 14 → 21 change most of the history
//       stayed CLICKABLE and opened as the ordinary "not generated yet" empty state.
//   (c) PERMANENT STALENESS. The staleness probe recomputes the fingerprint over the NEW window and
//       compares it to the stored one, so a colliding row read `stale: true` forever — inviting
//       precisely the regenerate that performed (a).
//
// THE FIX IS REFUSE-AND-PRESERVE, and every assertion below is one half of it: the old-cadence rows
// stay in the table, are filtered out of the list / the history / the detail, and stay readable at
// an explicit archived key. Nothing is deleted and nothing is auto-archived on the settings write.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/period-cadence-change.test.ts
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
  archivedKeyFor,
  generatePeriodReport,
  listPeriods,
  loadArchivedReport,
  loadStoredReport,
  parseArchivedKey,
  periodGrid,
  periodKeyFor,
  windowForKey,
} from '../insights/period-report.js';

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
// Day 73. On a 14-day grid that is period 5 (so 0–4 are complete); on a 7-day grid it is period 10.
const NOW = START + 73 * DAY;

const cadence = (days: number): SprintCadence => ({
  cadenceDays: days,
  startAtMs: START,
});

const grid14 = periodGrid(cadence(14), NOW)!;
const grid7 = periodGrid(cadence(7), NOW)!;

// ⚠ THE COLLIDING KEY. Day 56 begins period 4 of the 14-day grid and period 8 of the 7-day one.
const COLLIDING_KEY = periodKeyFor(START + 56 * DAY);
const win14 = windowForKey(grid14, COLLIDING_KEY)!;
const win7 = windowForKey(grid7, COLLIDING_KEY)!;

const SCOPE: BotScopeWire = { workspaceId: 7, repoIds: [1, 2, 3] };

const vec = (merged: number): PeriodMetricValue[] =>
  PERIOD_METRIC_KEYS.map((key: PeriodMetricKey) => ({
    key,
    value: key === 'merged_prs' ? merged : null,
    sampleSize: key === 'merged_prs' ? merged : 0,
  }));

describe('a cadence change against stored reports', () => {
  const MIGRATIONS = periodMigrationSql();
  let sqlite: Database.Database;
  let ctx: ProContext;
  let llmCalls: number;
  // Metrics are a pure function of the WINDOW LENGTH here, so a 7-day period reports half of the
  // 14-day one covering the same start day. That is the whole hazard in one number: the two rows
  // are not two readings of one thing, they are two different measurements.
  const mergedFor = (window: { fromMs: number; toMs: number }): number =>
    Math.round((window.toMs - window.fromMs) / DAY);

  const llm: LlmClient = {
    async complete() {
      llmCalls += 1;
      return { text: '**Sprint report.**', inputTokens: 3000, outputTokens: 400, costUsd: 0.005 };
    },
  };

  const rows = (): { period_key: string; cadence_days: number; model: string }[] =>
    sqlite
      .prepare(
        'SELECT period_key, cadence_days, model FROM workspace_period_reports ORDER BY period_key, cadence_days',
      )
      .all() as { period_key: string; cadence_days: number; model: string }[];

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(
      PRO_SETTINGS_STUB,
    );
    // The composite FK in 0029 points at core's `workspaces`; this suite exercises the period
    // table only, so the stub is enough to let the migration blob apply.
    sqlite.exec(
      WORKSPACES_STUB,
    );
    for (const sql of MIGRATIONS) sqlite.exec(sql);
    llmCalls = 0;
    ctx = {
      db: drizzle(sqlite, { schema: { ...periodSchema } }),
      recordAiUsage: async () => {},
      queries: {
        getPeriodMetrics: async (
          _accountId: number,
          scope: BotScopeWire,
          window: { fromMs: number; toMs: number },
        ) => {
          const metrics = vec(mergedFor(window));
          return {
            metrics,
            fingerprint: `fp:${scope.repoIds.join(',')}:${window.fromMs}:${window.toMs}`,
          };
        },
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

  const generate14 = () =>
    generatePeriodReport(ctx, llm, 1, SCOPE, grid14, win14, 'claude-haiku-5-5');
  const generate7 = () => generatePeriodReport(ctx, llm, 1, SCOPE, grid7, win7, 'claude-haiku-5-5');

  it('the two grids really do collide on one period key — the premise of every case below', () => {
    expect(win14.key).toBe(win7.key);
    expect(win14.cadenceDays).toBe(14);
    expect(win7.cadenceDays).toBe(7);
    expect(win14.fromMs).toBe(win7.fromMs);
    // Same name, different windows. Without a cadence in the identity these are one row.
    expect(win14.toMs).not.toBe(win7.toMs);
  });

  // ── (a) SILENT OVERWRITE ────────────────────────────────────────────────────────────────────
  it('(a) generating at the new cadence does NOT overwrite the stored 14-day artifact', async () => {
    const first = await generate14();
    expect(first.generated).toBe(true);
    expect(first.report?.metrics.find((m) => m.key === 'merged_prs')?.value).toBe(14);

    const second = await generate7();
    expect(second.generated).toBe(true);
    expect(second.report?.metrics.find((m) => m.key === 'merged_prs')?.value).toBe(7);

    // BOTH rows exist for the colliding key. Before migration 0029 widened the unique index (and
    // `persistReport`'s ON CONFLICT target with it), the second write replaced the first in place.
    const collided = rows().filter((r) => r.period_key === COLLIDING_KEY);
    expect(collided.map((r) => r.cadence_days).sort((a, b) => a - b)).toEqual([7, 14]);

    // And the 14-day row's own numbers are untouched — the forwarded document still says 14.
    const stored14 = sqlite
      .prepare(
        'SELECT metrics_json, period_end FROM workspace_period_reports WHERE period_key = ? AND cadence_days = 14',
      )
      .get(COLLIDING_KEY) as { metrics_json: string; period_end: number };
    expect(JSON.parse(stored14.metrics_json)[0].value).toBe(14);
    expect(stored14.period_end * 1000).toBe(win14.toMs);
  });

  // ── (c) PERMANENT STALENESS ─────────────────────────────────────────────────────────────────
  it('(c) a 14-day row is never SERVED under the 7-day grid, so it cannot read stale forever', async () => {
    await generate14();
    // Same key, new grid: the only stored row measures a different number of days, so this period
    // is genuinely "not generated yet" at 7 days. Serving the 14-day row here would put another
    // window's numbers under this heading AND — because the probe recomputes over the 7-day window
    // — would flag it stale on every read, inviting the regenerate that used to perform (a).
    expect(await loadStoredReport(ctx, 1, SCOPE, win7, 'claude-haiku-5-5')).toBeNull();

    // Under its OWN grid it is served, and it is NOT stale: nothing about the data moved.
    const live = await loadStoredReport(ctx, 1, SCOPE, win14, 'claude-haiku-5-5');
    expect(live?.cadenceDays).toBe(14);
    expect(live?.stale).toBe(false);
  });

  // ── (b) LISTED-BUT-BLANK ────────────────────────────────────────────────────────────────────
  it('(b) after the change the old-cadence rows are ARCHIVED, never listed as clickable periods', async () => {
    await generate14(); // writes the target + 8 metrics-only backfill rows, all at 14 days

    const listing = await listPeriods(ctx, 1, SCOPE, grid7);

    // Not one 14-day row appears as a live period. Before the fix they all did, and every one of
    // them opened as the ordinary empty state — indistinguishable from "not generated yet".
    expect(listing.periods.every((p) => p.cadenceDays === 7)).toBe(true);
    // ...and every listed period is one the detail GET will actually serve.
    for (const p of listing.periods) {
      expect(windowForKey(grid7, p.periodKey)).not.toBeNull();
    }

    // They are all preserved, named, and labelled with the cadence they were measured under.
    expect(listing.archived.length).toBe(9);
    expect(listing.archived.every((a) => a.cadenceDays === 14)).toBe(true);
    expect(listing.archived.every((a) => a.reason === 'cadence_changed')).toBe(true);
    const target = listing.archived.find((a) => a.periodKey === COLLIDING_KEY);
    expect(target?.hasNarrative).toBe(true);
    expect(target?.archivedKey).toBe(archivedKeyFor(COLLIDING_KEY, 14));
  });

  it('(b) the same period key can be BOTH a live 7-day period and a 14-day archive entry', async () => {
    await generate14();
    await generate7();
    const listing = await listPeriods(ctx, 1, SCOPE, grid7);
    expect(listing.periods.some((p) => p.periodKey === COLLIDING_KEY && p.cadenceDays === 7)).toBe(
      true,
    );
    expect(
      listing.archived.some((a) => a.periodKey === COLLIDING_KEY && a.cadenceDays === 14),
    ).toBe(true);
  });

  // ── PRESERVE: the archived artifact is still readable ────────────────────────────────────────
  it('serves the archived 14-day report at its explicit key, frozen and never stale', async () => {
    await generate14();
    const key = archivedKeyFor(COLLIDING_KEY, 14);
    expect(parseArchivedKey(key)).toEqual({ periodKey: COLLIDING_KEY, cadenceDays: 14 });

    const report = await loadArchivedReport(ctx, 1, SCOPE, key, 'claude-haiku-5-5');
    expect(report?.cadenceDays).toBe(14);
    expect(report?.metrics.find((m) => m.key === 'merged_prs')?.value).toBe(14);
    expect(report?.narrative).toBe('**Sprint report.**');
    expect(report?.archived).toBe(true);
    // ⚠ NEVER STALE. `stale` exists to offer a REGENERATION and an archived period cannot be
    // regenerated — its window is not on the current grid. A stale badge here would name an action
    // that does not exist, and the action it used to invite is what destroyed the artifact.
    expect(report?.stale).toBe(false);
  });

  it('a plain period key is NOT an archived key — the live path must keep it', () => {
    expect(parseArchivedKey(COLLIDING_KEY)).toBeNull();
    expect(parseArchivedKey('sprint-2026-02-26@cad0')).toBeNull();
    expect(parseArchivedKey('nonsense@cad14')).toBeNull();
  });

  it('an archived key naming a cadence nothing was stored at reads as absent, not as another row', async () => {
    await generate14();
    expect(
      await loadArchivedReport(ctx, 1, SCOPE, archivedKeyFor(COLLIDING_KEY, 21), null),
    ).toBeNull();
  });

  // ── THE BACKFILL AND THE $0 CACHE ARE CADENCE-SCOPED TOO ────────────────────────────────────
  it('the backfill does not mistake 14-day rows for periods it has already measured at 7', async () => {
    await generate14();
    const before = rows().filter((r) => r.cadence_days === 7).length;
    expect(before).toBe(0);

    await generate7();
    // A full fresh backfill at the new cadence: the target plus BACKFILL_PERIODS priors. If the
    // "already have this period" check had ignored the cadence, the colliding keys would have been
    // skipped and the 7-day series would have holes measured by nobody.
    const sevens = rows().filter((r) => r.cadence_days === 7);
    expect(sevens.length).toBe(9);
    // Every 7-day row really was measured over 7 days.
    const stored = sqlite
      .prepare('SELECT metrics_json FROM workspace_period_reports WHERE cadence_days = 7')
      .all() as { metrics_json: string }[];
    for (const r of stored) expect(JSON.parse(r.metrics_json)[0].value).toBe(7);
  });

  it('the $0-on-unchanged cache does not compare hashes across two different windows', async () => {
    await generate14();
    expect(llmCalls).toBe(1);
    // The 7-day run is real work over a different window — it must BILL, not hit the 14-day row's
    // payload hash. (The hash folds the cadence in, so this is belt and braces over the row filter;
    // both were needed, because the filter is what stops the cache even LOOKING at the wrong row.)
    const out = await generate7();
    expect(out.generated).toBe(true);
    expect(llmCalls).toBe(2);

    // Re-running the 7-day one IS a cache hit, so the two guards have not simply disabled the cache.
    const again = await generate7();
    expect(again.generated).toBe(false);
    expect(llmCalls).toBe(2);
  });

  // ── NOTHING IS DELETED OR AUTO-ARCHIVED ─────────────────────────────────────────────────────
  it('changing the cadence twice preserves BOTH earlier generations', async () => {
    await generate14();
    await generate7();
    const grid21 = periodGrid(cadence(21), NOW)!;
    const listing = await listPeriods(ctx, 1, SCOPE, grid21);
    // Every stored row is now unreachable from the live grid — and every one of them is still in
    // the table, named in the archive. A report stops being LISTED when the cadence moves; it stops
    // EXISTING only when the account is erased.
    expect(listing.periods.every((p) => p.cadenceDays === 21)).toBe(true);
    const cadences = new Set(listing.archived.map((a) => a.cadenceDays));
    expect([...cadences].sort((a, b) => a - b)).toEqual([7, 14]);
    expect(rows().length).toBe(18);
  });
});
