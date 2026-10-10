// db/story-health-fold.ts — Story health's pure fold. No database.
import { describe, expect, it } from 'vitest';
import { STORY_HEALTH_SERIES, STORY_SHIFT_MIN_HOURS, STORY_SHIFT_Z, type StoryCriterionLabel } from '@pierre-review/shared';
import { foldStoryHealth, storiesToLabel, twoProportionZ, type StoryHealthStoryInput, type StoryHealthWeekBound } from './story-health-fold.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-06T00:00:00Z'); // a Monday
const weeks: StoryHealthWeekBound[] = Array.from({ length: 13 }, (_, i) => ({
  key: new Date(T0 + i * 7 * DAY).toISOString().slice(0, 10),
  startMs: T0 + i * 7 * DAY,
  endMs: T0 + (i + 1) * 7 * DAY,
}));
const NOW = T0 + 12 * 7 * DAY + 2 * DAY; // inside the last week
const at = (week: number, day = 1) => T0 + week * 7 * DAY + day * DAY;

let seq = 0;
const crit = (flags: Array<[boolean, boolean, boolean]>): StoryCriterionLabel[] =>
  flags.map(([testable, bundled, dependsOnOtherWork], i) => ({ n: i + 1, testable, bundled, dependsOnOtherWork }));
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
    criteriaInField: true,
    userValueStated: false,
    label: null,
    ...p,
  };
}
const seriesOf = (f: ReturnType<typeof foldStoryHealth>, id: string) => f.series.find((s) => s.id === id)!;

describe('foldStoryHealth', () => {
  it('buckets refinement by created week (falling back to first PR opened, counted) and delivery by last merge', () => {
    const f = foldStoryHealth(
      [
        story({ createdMs: at(1), lastMergedMs: at(3) }),
        story({ createdMs: null, firstOpenedMs: at(2), lastMergedMs: at(3) }),
        // Created before the span, merged in it: delivery only.
        story({ createdMs: T0 - 30 * DAY, lastMergedMs: at(4) }),
      ],
      weeks,
      { nowMs: NOW, labels: true },
    );
    expect(f.weeks[1]!.storiesCreated).toBe(1);
    expect(f.weeks[2]!).toMatchObject({ storiesCreated: 1, createdFallback: 1 });
    expect(f.createdFallbackTotal).toBe(1);
    expect(f.weeks[3]!.storiesMerged).toBe(2);
    expect(f.weeks[4]!.storiesMerged).toBe(1);
    expect(f.weeks.reduce((n, w) => n + w.storiesCreated, 0)).toBe(2);
    expect(f.weeks[12]!.partial).toBe(true);
    expect(f.weeks[11]!.partial).toBe(false);
  });

  it('weights criterion series by criteria (n = labelled stories) and reports coverage', () => {
    const f = foldStoryHealth(
      [
        story({ label: { criteria: crit([[true, false, false], [true, true, false], [false, false, true]]), story: { outOfScopeStated: true, dependencyNamed: false, nonCodeWork: false } } }),
        story({ label: { criteria: crit([[false, false, false]]), story: { outOfScopeStated: false, dependencyNamed: true, nonCodeWork: false } } }),
        story({ label: { criteria: crit([[true, false, false]]), story: { outOfScopeStated: false, dependencyNamed: false, nonCodeWork: true } } }),
        story({ label: null }),
        story({ label: null, labellable: false }),
      ],
      weeks,
      { nowMs: NOW, labels: true },
    );
    expect(f.weeks[0]).toMatchObject({ storiesCreated: 5, labellable: 4, labelled: 3 });
    expect(f.unlabelled).toBe(1);
    const testable = seriesOf(f, 'criteriaTestable').points[0]!;
    // 3 testable of 5 criteria, over 3 labelled stories.
    expect(testable).toMatchObject({ value: 60, n: 3, criteria: 5, thin: false });
    expect(seriesOf(f, 'outOfScopeStated').points[0]!.value).toBeCloseTo(100 / 3);
    // Code series run over every story created that week.
    expect(seriesOf(f, 'criteriaInField').points[0]).toMatchObject({ value: 100, n: 5 });
  });

  it('omits every label series, the coverage and the to-do count when labels are off', () => {
    const f = foldStoryHealth(
      [story({ label: { criteria: crit([[true, false, false]]), story: { outOfScopeStated: true, dependencyNamed: false, nonCodeWork: false } } })],
      weeks,
      { nowMs: NOW, labels: false },
    );
    const labelIds = STORY_HEALTH_SERIES.filter((s) => s.source === 'label').map((s) => s.id);
    expect(f.series.some((s) => (labelIds as string[]).includes(s.id))).toBe(false);
    expect(f.series.map((s) => s.id)).toContain('criteriaInField');
    expect(f.weeks[0]!.labelled).toBe(0);
    expect(f.unlabelled).toBe(0);
  });

  it('marks a week with n < 3 thin, leaves unknown as null, and pools the rolling line over non-thin weeks', () => {
    const stories = [
      // week 0: three stories, 10/20/30 h → median 20.
      story({ lastMergedMs: at(0), workingHours: 10 }),
      story({ lastMergedMs: at(0), workingHours: 20 }),
      story({ lastMergedMs: at(0), workingHours: 30 }),
      // week 1: one story (thin), 1000 h — must not reach the rolling line.
      story({ lastMergedMs: at(1), workingHours: 1000 }),
      // week 2: three stories 40/50/60.
      story({ lastMergedMs: at(2), workingHours: 40 }),
      story({ lastMergedMs: at(2), workingHours: 50 }),
      story({ lastMergedMs: at(2), workingHours: 60 }),
      // unknown size: no band, counted.
      story({ lastMergedMs: at(2), linesChanged: null }),
    ];
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    const s = seriesOf(f, 'workingTimeS').points;
    expect(s[0]).toMatchObject({ value: 20, n: 3, thin: false, rolling: 20, rollingWeeks: 1 });
    expect(s[1]).toMatchObject({ value: 1000, n: 1, thin: true, rolling: 20, rollingWeeks: 1 });
    // Pooled: median of 10,20,30,40,50,60 = 35 (not the mean of the weekly medians).
    expect(s[2]).toMatchObject({ value: 50, rolling: 35, rollingWeeks: 2 });
    expect(s[5]).toMatchObject({ value: null, n: 0, thin: true });
    expect(f.weeks[2]!.unsizedStories).toBe(1);
    expect(f.unsizedTotal).toBe(1);
    expect(seriesOf(f, 'workingTimeM').points[0]!.value).toBeNull();
  });

  it('pools a percentage as a ratio of sums', () => {
    const reviewed = (week: number, met: number, total: number) =>
      story({ lastMergedMs: at(week), review: { met, total } });
    const f = foldStoryHealth(
      [reviewed(0, 1, 1), reviewed(0, 1, 1), reviewed(0, 0, 8), reviewed(1, 3, 3), reviewed(1, 3, 3), reviewed(1, 3, 3)],
      weeks,
      { nowMs: NOW, labels: true },
    );
    const p = seriesOf(f, 'criteriaMet').points;
    expect(p[0]).toMatchObject({ value: 20, n: 3 });
    expect(f.weeks[0]!.reviewedStories).toBe(3);
    // (2 + 9) / (10 + 9) — not (20 + 100) / 2.
    expect(p[1]!.rolling).toBeCloseTo((100 * 11) / 19);
  });

  it('time series: detects a step on the ROLLING values, colours it by the declared direction', () => {
    const stories: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) {
      const hours = w < 6 ? 10 : 40;
      for (let k = 0; k < 4; k += 1) stories.push(story({ lastMergedMs: at(w), workingHours: hours + k }));
    }
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    const shift = f.shifts.find((s) => s.series === 'workingTimeS')!;
    // The rolling line ramps over weeks 6–8; the split lands inside the ramp.
    expect(shift).toMatchObject({ week: 7, weekStart: weeks[7]!.key, direction: 'up', verdict: 'worse', nOf: 'weeks' });
    expect(shift.before).toBeCloseTo(11.5);
    expect(shift.after).toBeCloseTo(41.5);
    expect(shift.beforeWeeks + shift.afterWeeks).toBe(13);
    // PRs per story declares no better direction: a shift there is never green or red.
    const prs: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) for (let k = 0; k < 4; k += 1) prs.push(story({ lastMergedMs: at(w), prsTotal: w < 6 ? 1 : 5 }));
    const g = foldStoryHealth(prs, weeks, { nowMs: NOW, labels: true });
    expect(g.shifts.find((s) => s.series === 'prsPerStory')?.verdict).toBeNull();
  });

  it(`⚠ time series: a clean step smaller than ${STORY_SHIFT_MIN_HOURS} working hours never flags`, () => {
    const run = (after: number) => {
      const stories: StoryHealthStoryInput[] = [];
      for (let w = 0; w < 13; w += 1) for (let k = 0; k < 4; k += 1) stories.push(story({ lastMergedMs: at(w), workingHours: w < 6 ? 10 : after }));
      return foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true }).shifts.filter((s) => s.series === 'workingTimeS');
    };
    expect(run(10 + STORY_SHIFT_MIN_HOURS - 1)).toEqual([]);
    expect(run(10 + STORY_SHIFT_MIN_HOURS + 2)).toHaveLength(1);
    // PRs per story: a half-PR step is under the floor.
    const prs: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) for (let k = 0; k < 4; k += 1) prs.push(story({ lastMergedMs: at(w), prsTotal: w < 6 ? 1 : k < 2 ? 1 : 2 }));
    expect(foldStoryHealth(prs, weeks, { nowMs: NOW, labels: true }).shifts.filter((s) => s.series === 'prsPerStory')).toEqual([]);
  });

  it('⚠ rate series: a one-story change never flags', () => {
    // Three stories a week, none with criteria in the field — except one story in week 9. Weekly that
    // is 0% → 33% → 0%; pooled it is at most 1 of 15.
    const stories: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) {
      for (let k = 0; k < 3; k += 1) stories.push(story({ createdMs: at(w), criteriaInField: w === 9 && k === 0 }));
    }
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    expect(f.shifts.filter((s) => s.series === 'criteriaInField')).toEqual([]);
    // Nor do small weeks swinging 0% ↔ 100% with no change in the pooled share.
    const swing: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) for (let k = 0; k < 3; k += 1) swing.push(story({ createdMs: at(w), userValueStated: w % 2 === 0 }));
    expect(foldStoryHealth(swing, weeks, { nowMs: NOW, labels: true }).shifts.filter((s) => s.series === 'userValueStated')).toEqual([]);
  });

  it('rate series: a real 40% → 80% over 20 + 20 stories flags, with pooled shares and units', () => {
    const stories: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 8; w += 1) {
      for (let k = 0; k < 5; k += 1) stories.push(story({ createdMs: at(w), criteriaInField: k < (w < 4 ? 2 : 4) }));
    }
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    const s = f.shifts.find((x) => x.series === 'criteriaInField')!;
    expect(s).toMatchObject({ week: 4, before: 40, after: 80, beforeN: 20, afterN: 20, nOf: 'stories', beforeWeeks: 4, afterWeeks: 4, direction: 'up', verdict: 'better' });
    expect(twoProportionZ(8, 20, 16, 20)).toBeGreaterThanOrEqual(STORY_SHIFT_Z);
    // Fewer than STORY_SHIFT_MIN_STORIES a side: the same shares do not flag.
    // Fewer than STORY_SHIFT_MIN_STORIES a side: 14 + 14 stories, 43% → 86%, never flags.
    const few: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 4; w += 1) {
      for (let k = 0; k < 7; k += 1) few.push(story({ createdMs: at(w), criteriaInField: k < (w < 2 ? 3 : 6) }));
    }
    expect(foldStoryHealth(few, weeks, { nowMs: NOW, labels: true }).shifts.filter((x) => x.series === 'criteriaInField')).toEqual([]);
  });

  it('rate series: a criterion-weighted measure tests CRITERIA, with the story floor', () => {
    const label = (testable: number, of: number) => ({
      criteria: crit(Array.from({ length: of }, (_, i) => [i < testable, false, false] as [boolean, boolean, boolean])),
      story: { outOfScopeStated: false, dependencyNamed: false, nonCodeWork: false },
    });
    const build = (perSide: number, of: number) => {
      const out: StoryHealthStoryInput[] = [];
      for (let i = 0; i < perSide; i += 1) out.push(story({ createdMs: at(i % 5), label: label(of / 4, of) }));
      for (let i = 0; i < perSide; i += 1) out.push(story({ createdMs: at(6 + (i % 5)), label: label(of / 2, of) }));
      return foldStoryHealth(out, weeks, { nowMs: NOW, labels: true }).shifts.filter((s) => s.series === 'criteriaTestable');
    };
    // 15 + 15 stories, four criteria each: 25% → 50% over 60 + 60 criteria flags…
    const [hit] = build(15, 4);
    expect(hit).toMatchObject({ before: 25, after: 50, beforeN: 60, afterN: 60, nOf: 'criteria', beforeStories: 15, afterStories: 15 });
    // …the same shares over one criterion a story (15 + 15 units) do not…
    expect(twoProportionZ(15 * 0.25, 15, 15 * 0.5, 15)).toBeLessThan(STORY_SHIFT_Z);
    // …and 10 + 10 stories never flag, however many criteria they carry.
    expect(build(10, 40)).toEqual([]);
  });

  it('a story with nothing merged yet is in refinement only', () => {
    const f = foldStoryHealth([story({ createdMs: at(11), lastMergedMs: null })], weeks, { nowMs: NOW, labels: true });
    expect(f.weeks[11]!.storiesCreated).toBe(1);
    expect(f.weeks.reduce((n, w) => n + w.storiesMerged, 0)).toBe(0);
  });

  it('⚠ a story whose ticket text was never read is left out of the code series, never counted as "no"', () => {
    const f = foldStoryHealth(
      [
        story({ criteriaInField: true, userValueStated: true }),
        story({ ticketKnown: false, criteriaInField: false, userValueStated: false, labellable: false }),
      ],
      weeks,
      { nowMs: NOW, labels: true },
    );
    expect(seriesOf(f, 'criteriaInField').points[0]).toMatchObject({ value: 100, n: 1 });
    expect(seriesOf(f, 'userValueStated').points[0]).toMatchObject({ value: 100, n: 1 });
    expect(f.weeks[0]!.storiesCreated).toBe(2);
  });

  it('never finds a shift in thin weeks or in a flat series', () => {
    const stories: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) stories.push(story({ lastMergedMs: at(w), workingHours: w < 6 ? 1 : 500 }));
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    expect(f.shifts.filter((s) => s.series === 'workingTimeS')).toEqual([]);
  });
});

describe('storiesToLabel', () => {
  it('lists labellable, unlabelled, refinement-bucketed stories newest first', () => {
    const a = story({ createdMs: at(1) });
    const b = story({ createdMs: at(5) });
    const done = story({ createdMs: at(6), label: { criteria: crit([[true, true, true]]), story: { outOfScopeStated: false, dependencyNamed: false, nonCodeWork: false } } });
    const none = story({ createdMs: at(7), labellable: false });
    const old = story({ createdMs: T0 - 40 * DAY });
    expect(storiesToLabel([a, b, done, none, old], weeks).map((s) => s.ident)).toEqual([b.ident, a.ident]);
  });
});
