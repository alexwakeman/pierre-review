// ── THE PERIOD GRID, THE METRIC META AND THE SIGNIFICANCE FLOORS (insights/period-report.ts) ─────
//
// What the Reports series stands on (docs/PERIOD-REPORTING.md § The series). Salvaged from the
// stored-report suites removed 2026-11-08 with the AI write-up:
//   1. The sprint grid: `now` is in progress and never listed; the anchor is a PHASE (indices go
//      negative), bounded by the look-back horizon; no cadence ⇒ no grid; per-workspace cadences.
//   2. The calendar-month grid: needs no setting, aligns to the 1st (UTC), real day counts, the open
//      month never listed, leap years and year boundaries.
//   3. The metric-meta mirror covers exactly the shared key list.
//   4. A delta is significant only over BOTH sample floors and the absolute floor.
import { describe, expect, it } from 'vitest';
import { PERIOD_METRIC_KEYS, type PeriodMetricKey, type PeriodMetricValue } from '@pierre-review/shared';
import type { SprintCadence } from '../settings/store.js';
import { PERIOD_METRIC_META, buildDeltas, completedWindows, periodGrid } from '../insights/period-report.js';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const CADENCE = 14;
const CADENCE_MS = CADENCE * DAY;
// Mid-way through period 5, so periods 0-4 are complete and 5 is in progress.
const NOW = START + 5 * CADENCE_MS + 3 * DAY;
const cadence = (days: number | null = CADENCE, startMs: number | null = START): SprintCadence => ({ cadenceDays: days, startAtMs: startMs });
const sprintGrid = (c: SprintCadence = cadence()) => {
  const g = periodGrid(c, NOW);
  if (g == null) throw new Error('no grid');
  return g;
};

describe('the sprint grid', () => {
  it('places `now` in the period that contains it and excludes it from the completed list', () => {
    const grid = sprintGrid();
    expect(grid.currentIndex).toBe(5);
    const done = completedWindows(grid, 3);
    expect(done.map((w) => w.index)).toEqual([4, 3, 2]); // newest first
    expect(done.every((w) => w.toMs <= NOW)).toBe(true);
    expect(done[0]!.key).toBe('sprint-2026-02-26');
  });

  // ⚠ THE SPRINT START IS A PHASE ANCHOR, NOT THE START OF HISTORY: indices go negative, bounded by
  // the look-back horizon rather than by the date the team happened to configure.
  it('extrapolates BACKWARD past the anchor, on the same phase, bounded by the horizon', () => {
    const grid = sprintGrid();
    const wins = completedWindows(grid, 99);
    expect(wins.map((w) => w.index).slice(0, 6)).toEqual([4, 3, 2, 1, 0, -1]);
    expect(wins).toHaveLength(26);
    const before = wins.find((w) => w.index === -1)!;
    expect([before.fromMs, before.toMs, before.cadenceDays]).toEqual([START - CADENCE_MS, START, CADENCE]);
  });

  it('has NO grid when the cadence is unconfigured — the one hard refusal', () => {
    expect(periodGrid(cadence(null, null), NOW)).toBeNull();
    expect(periodGrid(cadence(null, START), NOW)).toBeNull();
    expect(periodGrid(cadence(CADENCE, null), NOW)).toBeNull();
  });

  it('grids a 7-day workspace on 7-day boundaries from the same anchor', () => {
    const weekly = sprintGrid(cadence(7));
    expect(weekly.currentIndex).toBe(10);
    expect(completedWindows(weekly, 2).map((w) => w.fromMs)).toEqual([START + 9 * 7 * DAY, START + 8 * 7 * DAY]);
  });
});

describe('the calendar-month grid', () => {
  const MID_MARCH = Date.parse('2026-03-17T09:30:00.000Z');
  it('needs NO configuration — the calendar is not a setting', () => {
    expect(periodGrid(cadence(null, null), MID_MARCH)).toBeNull();
    expect(periodGrid(cadence(null, null), MID_MARCH, 'month')).not.toBeNull();
  });

  it('aligns to the 1st in UTC, carries each month’s REAL day count, and never lists the open month', () => {
    const done = completedWindows(periodGrid(cadence(), MID_MARCH, 'month')!, 3);
    expect(done.map((w) => w.key)).toEqual(['month-2026-02', 'month-2026-01', 'month-2025-12']);
    expect(new Date(done[0]!.fromMs).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(new Date(done[0]!.toMs).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(done.map((w) => w.cadenceDays)).toEqual([28, 31, 31]);
    expect(done[0]!.grain).toBe('month');
  });

  it('handles a leap February and a year boundary', () => {
    const done = completedWindows(periodGrid(cadence(), Date.parse('2028-03-02T00:00:00.000Z'), 'month')!, 3);
    expect(done[0]!.cadenceDays).toBe(29);
    expect(new Date(done[2]!.toMs).toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });
});

describe('the metric-meta mirror', () => {
  it('covers exactly the shared key list, in the contract order', () => {
    expect(Object.keys(PERIOD_METRIC_META)).toEqual(PERIOD_METRIC_KEYS);
  });
});

describe('buildDeltas — significance', () => {
  const vec = (value: number, sampleSize: number): PeriodMetricValue[] =>
    PERIOD_METRIC_KEYS.map((key: PeriodMetricKey) => ({ key, value: key === 'merged_prs' ? value : null, sampleSize: key === 'merged_prs' ? sampleSize : 0 }));
  const merged = (cur: PeriodMetricValue[], pri: PeriodMetricValue[]) => buildDeltas(cur, pri).find((d) => d.key === 'merged_prs')!;

  it('calls a change significant only over both sample floors and the absolute floor', () => {
    expect(merged(vec(30, 30), vec(20, 20))).toMatchObject({ value: 30, prior: 20, absoluteChange: 10, percentChange: 50, significant: true, direction: 'up_good' });
    // Below the absolute floor (3): carried, not significant.
    expect(merged(vec(22, 22), vec(20, 20)).significant).toBe(false);
    // One side below the sample floor (5): not significant, however big the swing.
    expect(merged(vec(30, 30), vec(4, 4)).significant).toBe(false);
  });

  it('a missing figure is no change, never a zero', () => {
    const d = buildDeltas(vec(30, 30), vec(20, 20)).find((x) => x.key === 'opened_prs')!;
    expect([d.value, d.prior, d.absoluteChange, d.significant]).toEqual([null, null, null, false]);
  });
});
