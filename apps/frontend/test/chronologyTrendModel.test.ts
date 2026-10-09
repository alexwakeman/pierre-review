// Chronology "Over time" render model: the running gain, marker clustering and the lens figures.
// Pure — no renderer.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/chronologyTrendModel.test.ts
import { describe, expect, it } from 'vitest';
import type { FlowTrendEvent, FlowTrendEventKind, FlowTrendWeek } from '@pierre-review/shared';
import {
  lensSignificance,
  clusterEvents,
  EVENT_KIND_ORDER,
  lensChange,
  lensValue,
  runningGain,
  signedHours,
  usableWeek,
} from '../src/components/Activity/chronologyTrendModel.js';

function week(i: number, median: number | null, prs = 10, partial = false): FlowTrendWeek {
  const n = median == null ? 0 : prs;
  return {
    weekStart: `2026-01-${String(i + 1).padStart(2, '0')}`,
    from: '',
    to: '',
    partial,
    measuredPrs: n,
    thin: n < 5,
    reposWithData: 1,
    reposInWorkspace: 1,
    courtsWork: [],
    medianLeadWorkHours: median,
    budgets: [],
  };
}

describe('runningGain', () => {
  it('defaults to the median of the first eight usable weeks and counts from the ninth', () => {
    const weeks = [
      ...Array.from({ length: 8 }, (_, i) => week(i, 10 + (i % 2) * 2)), // 10,12,… → median 11
      week(8, 8, 10), // saves 3 × 10 = 30
      week(9, 12, 5), // loses 1 × 5 = −5
    ];
    const g = runningGain(weeks)!;
    expect(g.start).toBe(8);
    expect(g.baseline).toBe(11);
    expect(g.baselineWeeks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(g.weekly.slice(8)).toEqual([30, -5]);
    expect(g.cumulative.slice(8)).toEqual([30, 25]);
    expect(g.cumulative.slice(0, 8).every((v) => v == null)).toBe(true);
  });

  it('leaves thin and partial weeks out of the baseline and the sum, carrying the total', () => {
    const weeks = [
      week(0, 10),
      week(1, 100, 2), // thin: not in the baseline
      week(2, 10),
      week(3, 10),
      week(4, 10),
      week(5, 6, 3), // thin: not counted
      week(6, 6, 10, true), // the unfinished current week
    ];
    const g = runningGain(weeks, 5)!;
    expect(g.baselineWeeks).toEqual([0, 2, 3, 4]);
    expect(g.baseline).toBe(10);
    expect(g.weekly.slice(5)).toEqual([null, null]);
    expect(g.cumulative.slice(5)).toEqual([0, 0]);
  });

  it('a picked week measures from that week, against the eight usable weeks before it', () => {
    const weeks = Array.from({ length: 20 }, (_, i) => week(i, i < 10 ? 20 : 5));
    const g = runningGain(weeks, 10)!;
    expect(g.start).toBe(10);
    expect(g.baselineWeeks).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(g.cumulative[19]).toBe(10 * 15 * 10);
  });

  it('refuses with fewer than four usable weeks before the start', () => {
    const weeks = [week(0, 10), week(1, 10), week(2, 10), week(3, 5)];
    expect(runningGain(weeks, 3)).toBeNull();
    expect(runningGain(weeks)).toBeNull();
  });

  it('usableWeek is the server rule: not thin, not partial, has a median', () => {
    expect(usableWeek(week(0, 5))).toBe(true);
    expect(usableWeek(week(0, 5, 4))).toBe(false);
    expect(usableWeek(week(0, 5, 10, true))).toBe(false);
    expect(usableWeek(week(0, null))).toBe(false);
  });
});

describe('clusterEvents', () => {
  const ev = (id: string, kind: FlowTrendEventKind, w: number): FlowTrendEvent => ({
    id,
    kind,
    at: `2026-01-0${w + 1}T00:00:00Z`,
    week: w,
    label: id,
  });
  const all = new Set(EVENT_KIND_ORDER);

  it('stacks the events of one week into one marker, recorded kinds before shifts', () => {
    const c = clusterEvents([ev('s', 'shift', 2), ev('b', 'bot', 2), ev('p', 'contributor', 5)], all);
    expect(c.map((x) => [x.week, x.events.map((e) => e.id), x.lead, x.shiftsOnly])).toEqual([
      [2, ['b', 's'], 'bot', false],
      [5, ['p'], 'contributor', false],
    ]);
  });

  it('a week of shifts alone is dashed; hidden kinds drop out', () => {
    const c = clusterEvents([ev('s', 'shift', 1), ev('b', 'bot', 1)], new Set<FlowTrendEventKind>(['shift']));
    expect(c).toHaveLength(1);
    expect(c[0]!.shiftsOnly).toBe(true);
  });
});

describe('lens figures', () => {
  it('prints shares as percent and points, hours as hours', () => {
    expect(lensValue('reviewerShare', 0.426)).toBe('43%');
    expect(lensChange('reviewerShare', 0.42, 0.3)).toBe('−12 points');
    expect(lensValue('lead', 6.24)).toBe('6.2 h');
    expect(lensChange('lead', 8, 5.5)).toBe('−2.5 h');
    expect(lensChange('lead', 5, 5.01)).toBe('No change');
    expect(lensValue('lead', null)).toBe('–');
  });
  it('signs a gain with a real minus', () => {
    expect(signedHours(120.4)).toBe('+120 h');
    expect(signedHours(-35)).toBe('−35 h');
    expect(signedHours(0.2)).toBe('0 h');
  });
});

describe('lensSignificance', () => {
  it('calls only a shift, lower is better, and says nothing otherwise', () => {
    expect(lensSignificance({ verdict: 'shift', before: 10, after: 6 })).toBe('better');
    expect(lensSignificance({ verdict: 'shift', before: 0.09, after: 0.32 })).toBe('worse');
    expect(lensSignificance({ verdict: 'normal', before: 10, after: 2 })).toBeNull();
    expect(lensSignificance({ verdict: 'too_few', before: 10, after: 2 })).toBeNull();
    expect(lensSignificance({ verdict: 'shift', before: null, after: 2 })).toBeNull();
    expect(lensSignificance({ verdict: 'shift', before: 3, after: 3 })).toBeNull();
  });
});
