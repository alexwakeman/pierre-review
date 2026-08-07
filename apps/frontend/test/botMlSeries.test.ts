// The pure series maths behind the Behaviour tab's ML severity/category charts.
//
// What these pin: a quiet week is a GAP in the severity line and a real 0 in the category lines
// (two different truths — there is no severity below `nit`, but "no security findings" is a
// value); the x-axis is the union of every selected bot's weeks, last 12; and the category fold
// sums across the selected bots while ignoring any week the axis doesn't show.
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotBehaviourMlBot, MlSeverityCounts } from '@pierre-review/shared';
import {
  categoriesPresent,
  categoryWeeklySeries,
  meanSeverityOrdinal,
  meanSeverityValues,
  mlWeekLabels,
  severityBreakdownNote,
} from '../src/lib/botMlSeries.js';

const counts = (over: Partial<MlSeverityCounts> = {}): MlSeverityCounts => ({
  nit: 0,
  minor: 0,
  major: 0,
  critical: 0,
  ...over,
});

const week = (n: number): string => `2026-0${n < 10 ? n : 9}-0${(n % 9) + 1}T00:00:00.000Z`;

function bot(
  key: string,
  weekly: Array<{
    weekStart: string;
    bySeverity?: Partial<MlSeverityCounts>;
    byCategory?: BotBehaviourMlBot['weekly'][number]['byCategory'];
  }>,
  byCategory: BotBehaviourMlBot['byCategory'] = [],
): BotBehaviourMlBot {
  return {
    key,
    findings: 0,
    bySeverity: counts(),
    byVendorSeverity: counts(),
    vendorDeclared: 0,
    byCategory,
    weekly: weekly.map((w) => ({
      weekStart: w.weekStart,
      bySeverity: counts(w.bySeverity),
      byCategory: w.byCategory ?? [],
    })),
  };
}

describe('meanSeverityOrdinal', () => {
  it('averages on the 1–4 ordinal', () => {
    // 2 nits (1) + 2 criticals (4) → 2.5, the midpoint between minor and major.
    expect(meanSeverityOrdinal(counts({ nit: 2, critical: 2 }))).toBe(2.5);
    expect(meanSeverityOrdinal(counts({ major: 3 }))).toBe(3);
  });

  it('is NULL for a week with no findings, never 0', () => {
    // 0 is off the bottom of the scale — a zero here would draw every quiet week as a plunge
    // into "less than trivial", which is not a thing a severity can be.
    expect(meanSeverityOrdinal(counts())).toBeNull();
  });
});

describe('severityBreakdownNote', () => {
  it('states the count the mean was drawn from, low class first', () => {
    const note = severityBreakdownNote(counts({ nit: 7, major: 2 }));
    expect(note).toBe('9 findings · 7 nit / 2 major');
  });

  it('says nothing when there is nothing to say', () => {
    expect(severityBreakdownNote(counts())).toBeNull();
  });
});

describe('mlWeekLabels', () => {
  it('unions every bot’s weeks, ascending', () => {
    const a = bot('u1', [{ weekStart: week(1) }, { weekStart: week(3) }]);
    const b = bot('u2', [{ weekStart: week(2) }, { weekStart: week(3) }]);
    expect(mlWeekLabels([a, b])).toEqual([week(1), week(2), week(3)]);
  });

  it('keeps only the last 12 weeks', () => {
    const many = bot(
      'u1',
      Array.from({ length: 20 }, (_, i) => ({ weekStart: `2026-01-${String(i + 1).padStart(2, '0')}` })),
    );
    const labels = mlWeekLabels([many]);
    expect(labels).toHaveLength(12);
    expect(labels[11]).toBe('2026-01-20');
  });
});

describe('meanSeverityValues', () => {
  it('aligns to the shared axis and breaks the line on a week the bot missed', () => {
    const a = bot('u1', [
      { weekStart: week(1), bySeverity: { nit: 1 } },
      { weekStart: week(3), bySeverity: { critical: 1 } },
    ]);
    // week(2) is on the axis (another bot has it) but not in this bot's own weekly array.
    expect(meanSeverityValues(a, [week(1), week(2), week(3)])).toEqual([1, null, 4]);
  });

  it('breaks the line on a week the bot was present but found nothing', () => {
    const a = bot('u1', [
      { weekStart: week(1), bySeverity: { minor: 2 } },
      { weekStart: week(2) },
    ]);
    expect(meanSeverityValues(a, [week(1), week(2)])).toEqual([2, null]);
  });
});

describe('categoryWeeklySeries', () => {
  it('sums the selected bots per week and keeps a real 0 for a quiet week', () => {
    const a = bot('u1', [
      { weekStart: week(1), byCategory: [{ category: 'security', count: 2 }] },
      { weekStart: week(2), byCategory: [] },
    ]);
    const b = bot('u2', [
      { weekStart: week(1), byCategory: [{ category: 'security', count: 1 }] },
      { weekStart: week(2), byCategory: [{ category: 'testing', count: 4 }] },
    ]);
    const series = categoryWeeklySeries([a, b], [week(1), week(2)]);
    expect(series.map((s) => s.category)).toEqual(['testing', 'security']); // desc by total
    expect(series.find((s) => s.category === 'security')!.values).toEqual([3, 0]);
    expect(series.find((s) => s.category === 'testing')!.values).toEqual([0, 4]);
  });

  it('ignores a week outside the axis rather than mis-indexing it', () => {
    const a = bot('u1', [
      { weekStart: week(1), byCategory: [{ category: 'praise', count: 5 }] },
      { weekStart: week(2), byCategory: [{ category: 'praise', count: 1 }] },
    ]);
    // Only week 2 is shown — week 1's 5 must be dropped, not folded into the visible column.
    expect(categoryWeeklySeries([a], [week(2)])[0]!.values).toEqual([1]);
  });

  it('drops a category nobody used', () => {
    const a = bot('u1', [{ weekStart: week(1), byCategory: [{ category: 'nitpick', count: 0 }] }]);
    expect(categoryWeeklySeries([a], [week(1)])).toEqual([]);
  });
});

describe('categoriesPresent', () => {
  it('ranks the window categories across bots, most-used first', () => {
    const a = bot('u1', [], [
      { category: 'nitpick', count: 3 },
      { category: 'security', count: 1 },
    ]);
    const b = bot('u2', [], [{ category: 'security', count: 5 }]);
    expect(categoriesPresent([a, b])).toEqual(['security', 'nitpick']);
  });
});
