// Chronology's working-hours render model: the calendar line, the budget scale, the scatter's
// axis and the triangle's geometry. Pure — no renderer.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/chronologyModel.test.ts
import { describe, expect, it } from 'vitest';
import { resolveFlowSettings, type FlowBudgetRow, type FlowPrRow } from '@pierre-review/shared';
import {
  budgetScale,
  calendarLine,
  dotRadius,
  effectiveChronologyWindow,
  formatWorkHours,
  neverWentBack,
  scatterTicks,
  scatterYRange,
  slowestPrs,
  slowestTenthShare,
  trianglePoint,
  workingDaysText,
} from '../src/components/Activity/chronologyModel.js';

function row(over: Partial<FlowPrRow>): FlowPrRow {
  return {
    prId: 1,
    repoFullName: 'acme/api',
    prNumber: 1,
    prTitle: 'x',
    githubUrl: 'https://github.com/acme/api/pull/1',
    openedAt: '2026-09-01T09:00:00.000Z',
    mergedAt: '2026-09-01T12:00:00.000Z',
    openedWeekday: 2,
    leadHours: 3,
    leadWorkHours: 3,
    workHours: { reviewer: 2, author: 0, landing: 1 },
    firstLookWorkHours: 2,
    rounds: 0,
    lines: 40,
    files: 2,
    reachAreas: [],
    ciRedHours: 0,
    ticketKey: null,
    selfMerged: false,
    dominant: 'reviewer',
    ...over,
  };
}

describe('the calendar in words', () => {
  it('reads a run of days as a range, including one that wraps the week', () => {
    expect(workingDaysText([1, 2, 3, 4, 5])).toBe('Monday to Friday');
    expect(workingDaysText([7, 1, 2, 3, 4])).toBe('Sunday to Thursday');
    expect(workingDaysText([1, 2, 3, 4, 5, 6, 7])).toBe('every day');
  });

  it('lists days with a gap in them rather than inventing a range', () => {
    expect(workingDaysText([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(workingDaysText([2])).toBe('Tuesdays');
  });

  it('states zone, days and hours in one line', () => {
    expect(calendarLine(resolveFlowSettings({ timeZone: 'Europe/London' }, 'UTC'))).toBe(
      'Working hours: Monday to Friday, 09:00–18:00, Europe/London.',
    );
  });
});

describe('figures', () => {
  it('never spells working time in days — a "d" reads as calendar days', () => {
    expect(formatWorkHours(0.4)).toBe('24m');
    expect(formatWorkHours(6.25)).toBe('6.3h');
    expect(formatWorkHours(47)).toBe('47h');
    expect(formatWorkHours(130)).toBe('130h');
  });

  it('reads an unknown window as the default', () => {
    expect(effectiveChronologyWindow(60)).toBe(60);
    expect(effectiveChronologyWindow(45)).toBe(30);
    expect(effectiveChronologyWindow(null)).toBe(30);
  });
});

describe('the budget chart shares one scale', () => {
  const b = (good: number, ok: number): FlowBudgetRow => ({
    measure: 'lead',
    good,
    ok,
    prs: 10,
    p50: 1,
    p75: 2,
    p90: 3,
    verdict: 'good',
    sentence: '',
  });
  it('is wide enough for every acceptable mark, with room past it', () => {
    const { max, ticks } = budgetScale([b(4, 8), b(1, 4), b(8, 16)], 9);
    expect(max).toBe(24);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(24);
  });

  it('grows with a looser budget rather than clipping its mark', () => {
    expect(budgetScale([b(20, 40)], 9).max).toBeGreaterThanOrEqual(60);
  });
});

describe('the scatter', () => {
  it('puts the ceiling above the slowest pull request, on a tick', () => {
    const { max } = scatterYRange([row({ leadWorkHours: 130 })]);
    expect(max).toBe(160);
    expect(scatterTicks(max).map((t) => t.label)).toContain('160h');
  });

  it('draws an unknown size as the smallest dot, never as a big one', () => {
    expect(dotRadius(null)).toBe(3);
    expect(dotRadius(10_000)).toBe(10);
  });

  it('lists the slowest in working hours, and what share they hold', () => {
    const prs = Array.from({ length: 20 }, (_, i) => row({ prId: i + 1, leadWorkHours: i + 1 }));
    expect(slowestPrs(prs, 3).map((p) => p.prId)).toEqual([20, 19, 18]);
    const t = slowestTenthShare(prs);
    expect(t.count).toBe(2);
    expect(t.share).toBeCloseTo((20 + 19) / 210, 9);
  });
});

describe('the triangle', () => {
  it('places a pull request by its shares, and leaves off one with no working time', () => {
    expect(trianglePoint({ reviewer: 3, author: 0, landing: 1 })).toEqual({
      reviewer: 0.75,
      author: 0,
      landing: 0.25,
    });
    expect(trianglePoint({ reviewer: 0, author: 0, landing: 0.01 })).toBeNull();
  });

  it('counts those that never went back to their author — the right-hand edge', () => {
    expect(neverWentBack([row({ rounds: 0 }), row({ rounds: 2 }), row({ rounds: 0 })])).toBe(2);
  });
});
