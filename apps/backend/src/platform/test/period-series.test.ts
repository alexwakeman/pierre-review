// ── THE PERIOD SERIES (Reports → Period reports, the chart; period-report.ts `buildPeriodSeries`) ──
//
//   1. Length: 12 weeks of sprints (14-day → 6, 7-day → 12), 6 calendar months.
//   2. ONE repo set across every point: the repos tracked since the oldest period shown — a repo
//      onboarded mid-window is left out of every point, not added to the later ones.
//   3. Periods before any repo was tracked are dropped, never drawn as zero.
//   4. Deltas are consecutive and over the same set; the forecast is fitted at sprint grain and
//      refused (`uneven_periods`) at month grain.
//   5. Nothing here calls a model: the fake ctx has no LLM at all.
import { describe, expect, it } from 'vitest';
import { PERIOD_METRIC_KEYS, type PeriodMetricValue } from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import { buildPeriodSeries, periodGrid, seriesLength } from '../insights/period-report.js';
import { forecastNext } from '../../db/forecast.js';

const NOW = Date.parse('2026-03-17T09:30:00.000Z');
const SCOPE: BotScopeWire = { workspaceId: 7, repoIds: [1, 2, 3] };
const cadence = (days: number) => ({ cadenceDays: days, startAtMs: Date.parse('2026-01-01T00:00:00.000Z') });

/** Repo 1 since forever, repo 2 from 2026-02-01, repo 3 from 2026-03-01. */
const TRACKED_FROM: Record<number, number> = { 1: 0, 2: Date.parse('2026-02-01T00:00:00Z'), 3: Date.parse('2026-03-01T00:00:00Z') };

function fakeCtx(opts: { noReposBefore?: number } = {}): { ctx: ProContext; scopes: number[][] } {
  const scopes: number[][] = [];
  const queries = {
    getPeriodCoverage: async (_a: number, repoIds: number[], atMs: number) => ({
      trackedRepoIds: repoIds.filter((id) => TRACKED_FROM[id]! <= atMs && (opts.noReposBefore == null || atMs >= opts.noReposBefore)),
    }),
    getPeriodMetrics: async (_a: number, scope: BotScopeWire, w: { fromMs: number }) => {
      scopes.push(scope.repoIds);
      // merged_prs = 10 per repo per period, plus the period's week number (a gentle trend).
      const v = scope.repoIds.length * 10 + Math.round(w.fromMs / (7 * 86_400_000)) % 5;
      return { metrics: PERIOD_METRIC_KEYS.map((key): PeriodMetricValue => ({ key, value: key === 'merged_prs' ? v : null, sampleSize: key === 'merged_prs' ? v : 0 })) };
    },
    getPeriodLanes: async () => null,
    computePeriodForecast: async (values: (number | null)[], o?: { max?: number }) => forecastNext(values, o ?? {}),
  };
  return { ctx: { queries } as unknown as ProContext, scopes };
}

describe('seriesLength', () => {
  it('covers 12 weeks of sprints and 6 months', () => {
    expect(seriesLength(periodGrid(cadence(14), NOW)!)).toBe(6);
    expect(seriesLength(periodGrid(cadence(7), NOW)!)).toBe(12);
    expect(seriesLength(periodGrid(cadence(28), NOW)!)).toBe(3);
    expect(seriesLength(periodGrid(cadence(14), NOW, 'month')!)).toBe(6);
  });
});

describe('buildPeriodSeries', () => {
  it('measures every point over ONE repo set: the repos tracked since the oldest period', async () => {
    const { ctx, scopes } = fakeCtx();
    const s = await buildPeriodSeries(ctx, 1, SCOPE, periodGrid(cadence(14), NOW)!);
    expect(s.periods).toHaveLength(6);
    // Oldest first, contiguous.
    for (let i = 1; i < s.periods.length; i++) expect(s.periods[i]!.periodStart).toBe(s.periods[i - 1]!.periodEnd);
    // Repos 2 and 3 arrived inside the window: left out of EVERY point.
    expect(new Set(scopes.map((r) => r.join(',')))).toEqual(new Set(['1']));
    expect(s.repos).toEqual({ measured: 1, total: 3 });
    // Consecutive deltas over the same set; none on the first point.
    expect(s.periods[0]!.deltas).toEqual([]);
    const d = s.periods[1]!.deltas.find((x) => x.key === 'merged_prs')!;
    const v = (i: number) => s.periods[i]!.metrics.find((m) => m.key === 'merged_prs')!.value!;
    expect(d.prior).toBe(v(0));
    expect(d.value).toBe(v(1));
    // The projection slot is the period in progress, and a fitted forecast says what it used.
    expect(Date.parse(s.next!.periodStart)).toBeLessThanOrEqual(NOW);
    expect(Date.parse(s.next!.periodEnd)).toBeGreaterThan(NOW);
    expect(s.forecasts.find((f) => f.key === 'merged_prs')!.available).toBe(true);
    expect(s.forecastDisclosure).toBe('fitted on 6 periods');
  });

  it('drops periods before any repo was tracked, never drawing them as zero', async () => {
    const { ctx } = fakeCtx({ noReposBefore: Date.parse('2026-02-01T00:00:00Z') });
    const s = await buildPeriodSeries(ctx, 1, SCOPE, periodGrid(cadence(14), NOW)!);
    expect(s.periods.length).toBeGreaterThan(0);
    expect(s.periods.length).toBeLessThan(6);
    expect(Date.parse(s.periods[0]!.periodStart)).toBeGreaterThanOrEqual(Date.parse('2026-02-01T00:00:00Z'));
    // Fewer than four points: no forecast, and the reason is named.
    expect(s.forecasts.every((f) => !f.available && f.reason === 'insufficient_history')).toBe(true);
  });

  it('reads 6 calendar months and refuses the forecast at month grain', async () => {
    const { ctx } = fakeCtx();
    const s = await buildPeriodSeries(ctx, 1, SCOPE, periodGrid(cadence(14), NOW, 'month')!);
    expect(s.periods.map((p) => p.periodKey)).toEqual(['month-2025-09', 'month-2025-10', 'month-2025-11', 'month-2025-12', 'month-2026-01', 'month-2026-02']);
    expect(s.next?.periodKey).toBe('month-2026-03');
    expect(s.forecasts.every((f) => !f.available && f.reason === 'uneven_periods')).toBe(true);
    expect(s.forecastDisclosure).toBeNull();
  });
});
