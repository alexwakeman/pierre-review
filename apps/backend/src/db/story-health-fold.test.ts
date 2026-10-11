// db/story-health-fold.ts — the label run's pure population rules. No database.
import { describe, expect, it } from 'vitest';
import type { StoryCriterionLabel } from '@pierre-review/shared';
import { refinementWeekOf, storiesToLabel, type StoryHealthStoryInput, type StoryHealthWeekBound } from './story-health-fold.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-06T00:00:00Z'); // a Monday
const weeks: StoryHealthWeekBound[] = Array.from({ length: 13 }, (_, i) => ({
  key: new Date(T0 + i * 7 * DAY).toISOString().slice(0, 10),
  startMs: T0 + i * 7 * DAY,
  endMs: T0 + (i + 1) * 7 * DAY,
}));
const at = (week: number, day = 1) => T0 + week * 7 * DAY + day * DAY;

let seq = 0;
const crit = (flags: boolean[]): StoryCriterionLabel[] =>
  flags.map((testable, i) => ({ n: i + 1, testable, reason: testable ? null : 'no expected result' }));
function story(p: Partial<StoryHealthStoryInput> = {}): StoryHealthStoryInput {
  seq += 1;
  return {
    ident: `jira:https://x#K-${seq}`,
    createdMs: at(0),
    firstOpenedMs: at(0, 2),
    lastMergedMs: at(0, 4),
    linesChanged: 100,
    workingHours: 10,
    prsTotal: 1,
    review: null,
    ticketKnown: true,
    labellable: true,
    criteriaCount: 1,
    label: null,
    ...p,
  };
}

describe('refinementWeekOf', () => {
  it('buckets by created week, falling back to the first PR opened', () => {
    expect(refinementWeekOf({ createdMs: at(3), firstOpenedMs: at(5) }, weeks)).toEqual({ week: 3, fallback: false });
    expect(refinementWeekOf({ createdMs: null, firstOpenedMs: at(5) }, weeks)).toEqual({ week: 5, fallback: true });
    expect(refinementWeekOf({ createdMs: T0 - DAY, firstOpenedMs: at(5) }, weeks).week).toBe(-1);
  });
});

describe('storiesToLabel', () => {
  it('lists labellable, unlabelled, in-span stories newest first', () => {
    const a = story({ createdMs: at(1) });
    const b = story({ createdMs: at(5) });
    const done = story({ createdMs: at(6), label: { criteria: crit([true]), story: { dependencies: [], gaps: [] } } });
    const none = story({ createdMs: at(7), labellable: false });
    const old = story({ createdMs: T0 - 40 * DAY });
    expect(storiesToLabel([a, b, done, none, old], weeks).map((s) => s.ident)).toEqual([b.ident, a.ident]);
  });
});
