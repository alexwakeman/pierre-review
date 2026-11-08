// THE PERIOD SERIES' PURE HALF (lib/periodSeries.ts): the Change reading's baseline and its refusal,
// the projection in either reading, Values' one-unit-per-chart grouping, the round axis, the chips.
import { describe, expect, it } from 'vitest';
import { PERIOD_METRIC_KEYS, type PeriodMetricKey, type PeriodSeriesPoint } from '@pierre-review/shared';
import {
  PERIOD_METRIC_UNIT,
  changeAxis,
  changeLabel,
  changeSeries,
  projectionIn,
  seriesMarkdown,
  toggleMetric,
  unitGroups,
} from '../src/lib/periodSeries.js';

const pt = (vals: Partial<Record<PeriodMetricKey, { v: number | null; thin?: boolean }>>, i = 0): PeriodSeriesPoint => ({
  periodKey: `p${i}`,
  periodStart: '',
  periodEnd: '',
  cadenceDays: 14,
  metrics: PERIOD_METRIC_KEYS.map((key) => ({ key, value: vals[key]?.v ?? null, sampleSize: 10, ...(vals[key]?.thin ? { lowSample: true } : {}) })),
  deltas: [],
  lanes: null,
});

describe('changeSeries', () => {
  it('rebases on the first period above zero that is not a thin sample', () => {
    const s = [
      pt({ merged_prs: { v: null } }),
      pt({ merged_prs: { v: 0 } }),
      pt({ merged_prs: { v: 4, thin: true } }),
      pt({ merged_prs: { v: 20 } }),
      pt({ merged_prs: { v: 30 } }),
    ];
    const c = changeSeries(s, 'merged_prs');
    expect(c.base).toEqual({ index: 3, value: 20 });
    // Earlier periods are still drawn against it; a missing figure stays a gap, never 0.
    expect(c.values).toEqual([null, -100, -80, 0, 50]);
  });

  it('refuses when no period qualifies', () => {
    const c = changeSeries([pt({ merged_prs: { v: 0 } }), pt({ merged_prs: { v: 2, thin: true } })], 'merged_prs');
    expect(c.base).toBeNull();
    expect(c.values).toEqual([null, null]);
  });
});

describe('projectionIn', () => {
  const f = { available: true as const, key: 'merged_prs' as const, point: 30, low: 25, high: 35, basis: '', periodsUsed: 6 };
  it('in figures, or as change from the baseline; nothing for a refusal', () => {
    expect(projectionIn(f, 'values', null)).toEqual({ point: 30, low: 25, high: 35 });
    expect(projectionIn(f, 'change', { index: 0, value: 20 })).toEqual({ point: 50, low: 25, high: 75 });
    expect(projectionIn(f, 'change', null)).toBeNull();
    expect(projectionIn({ available: false, key: 'merged_prs', reason: 'too_volatile' }, 'values', null)).toBeNull();
  });
});

describe('unitGroups', () => {
  it('puts one unit per chart, in the order picked', () => {
    expect(unitGroups(['merged_prs', 'merge_ci_success_pct', 'bot_review_comments'])).toEqual([
      { unit: 'count', keys: ['merged_prs', 'bot_review_comments'] },
      { unit: 'pct', keys: ['merge_ci_success_pct'] },
    ]);
    // Every metric has a unit.
    for (const k of PERIOD_METRIC_KEYS) expect(PERIOD_METRIC_UNIT[k]).toBeTruthy();
  });
});

describe('changeAxis', () => {
  it('always includes 0 and ticks on a round step', () => {
    expect(changeAxis([0, 65, 80])).toEqual({ min: 0, max: 80, ticks: [0, 20, 40, 60, 80] });
    expect(changeAxis([0, 90, 110]).ticks).toEqual([0, 50, 100, 150]);
    expect(changeAxis([-12, 8]).ticks).toContain(0);
    expect(changeAxis([]).ticks).toEqual([0, 1]);
  });
});

describe('the chips and the labels', () => {
  it('toggles, but never switches the last metric off', () => {
    expect(toggleMetric(['merged_prs'], 'opened_prs')).toEqual(['merged_prs', 'opened_prs']);
    expect(toggleMetric(['merged_prs', 'opened_prs'], 'merged_prs')).toEqual(['opened_prs']);
    expect(toggleMetric(['merged_prs'], 'merged_prs')).toEqual(['merged_prs']);
  });
  it('signs a change', () => {
    expect([changeLabel(12), changeLabel(-8.5), changeLabel(0)]).toEqual(['+12%', '−8.5%', '0%']);
  });
  it('copies as a Markdown table, "—" for no figure', () => {
    const md = seriesMarkdown([pt({ merged_prs: { v: 20 } }, 0), pt({}, 1)], ['merged_prs'], () => 'Merged PRs', (_k, v) => String(v), (p) => p.periodKey, { measured: 3, total: 4 });
    expect(md).toBe('| Period | Merged PRs |\n| --- | ---: |\n| p0 | 20 |\n| p1 | — |\n\n3 of 4 repos: the ones tracked across every period.');
  });
});
