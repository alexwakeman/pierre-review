// db/story-health-fold.ts — Story health's pure fold. No database.
import { describe, expect, it } from 'vitest';
import {
  STORY_HEALTH_HOVER_STORIES,
  STORY_HEALTH_SERIES,
  STORY_SHIFT_MIN_HOURS,
  STORY_SHIFT_Z,
  type StoryCriterionLabel,
  type StoryLevelLabels,
  type TicketLinkBlocker,
} from '@pierre-review/shared';
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
const crit = (flags: Flags): StoryCriterionLabel[] =>
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
/** One `testable` answer per criterion. */
type Flags = boolean[];
const STORY_OK: StoryLevelLabels = { dependencies: [], gaps: [] };
const DEP = { kind: 'design' as const, what: 'map page design', owner: 'UCD team', ticketKey: null };
const GAP = { type: 'edge_case' as const, text: 'No behaviour when the upload fails' };
const doneLink: TicketLinkBlocker = { key: 'K-900', title: 'Old spike', status: 'Done', category: 'done', relation: 'is blocked by', url: null };
/** A labelled story whose criteria count matches its label (so the label is usable). */
const labelled = (flags: Flags, st: Partial<StoryLevelLabels> = {}, p: Partial<StoryHealthStoryInput> = {}) =>
  story({ criteriaCount: flags.length, label: { criteria: crit(flags), story: { ...STORY_OK, ...st } }, ...p });
const OK: Flags = [true];
const withGap = (yes: boolean) => ({ gaps: yes ? [GAP] : [] });
const withDep = (yes: boolean) => ({ dependencies: yes ? [DEP] : [] });
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

  it('counts each issue in its own unit under the rate rule, and reports coverage', () => {
    const f = foldStoryHealth(
      [
        // Criterion 3 of 3 untestable, a named design dependency (text only: not a linked blocker), a gap.
        labelled([true, true, false], { dependencies: [DEP], gaps: [GAP] }, { key: 'K-2', title: 'Map page', links: [] }),
        // A spec gap only; its links were never read.
        labelled(OK, withGap(true), { key: 'K-1', title: 'Upload' }),
        // ⚠ A FINISHED linked blocker still counts: Blocked is how the story was written.
        labelled(OK, {}, { links: [doneLink], key: 'K-3', title: null }),
        // Unlabelled, with an OPEN link: in Blocked (code) only.
        story({ criteriaCount: 12, label: null, links: [{ ...doneLink, category: 'new' }] }),
        // Known ticket, no criteria, no label possible: counted apart, in no criteria series.
        story({ criteriaCount: 0, label: null, labellable: false }),
      ],
      weeks,
      { nowMs: NOW, labels: true },
    );
    expect(f.weeks[0]).toMatchObject({ storiesCreated: 5, noCriteria: 1, labellable: 4, labelled: 3 });
    expect(f.unlabelled).toBe(1);
    // Criteria that can't be checked: 1 of the 5 criteria in the 3 labelled stories (n = stories).
    expect(seriesOf(f, 'unclearDone').points[0]).toMatchObject({ n: 3, thin: false, criteria: { num: 1, den: 5 } });
    expect(seriesOf(f, 'unclearDone').points[0]!.value).toBeCloseTo(20);
    // Linked blockers: 2 of the 3 stories whose links were read (labelled or not).
    expect(seriesOf(f, 'blocked').points[0]).toMatchObject({ n: 3 });
    expect(seriesOf(f, 'blocked').points[0]!.value).toBeCloseTo(200 / 3);
    expect(seriesOf(f, 'blocked').points[0]!.criteria).toBeUndefined();
    expect(seriesOf(f, 'specGaps').points[0]!.value).toBeCloseTo(200 / 3);
    expect(f.series.filter((x) => STORY_HEALTH_SERIES.find((m) => m.id === x.id)!.panel === 'refinement').map((x) => x.id)).toEqual([
      'unclearDone',
      'blocked',
      'specGaps',
    ]);
  });

  it('a refinement point carries its hover detail: the stories with the issue, Spec gaps’ types', () => {
    const f = foldStoryHealth(
      [
        labelled(OK, { dependencies: [DEP], gaps: [GAP, { type: 'edge_case', text: 'No empty-file rule' }] }, { key: 'K-10', title: 'B', links: [] }),
        labelled(OK, { gaps: [{ type: 'rule', text: 'No rule for ties' }] }, { key: 'K-9', title: 'A' }),
        labelled([true, false, false], {}, { links: [doneLink], key: 'K-11', title: 'C' }),
      ],
      weeks,
      { nowMs: NOW, labels: true },
    );
    const blocked = seriesOf(f, 'blocked').points[0]!;
    // Text-only dependencies are not linked blockers.
    expect(blocked.stories!.map((x) => x.key)).toEqual(['K-11']);
    expect(blocked.storiesMore).toBe(0);
    // The criteria series lists the stories with ≥ 1 such criterion.
    expect(seriesOf(f, 'unclearDone').points[0]!.stories!.map((x) => x.key)).toEqual(['K-11']);
    const gaps = seriesOf(f, 'specGaps').points[0]!;
    // Key order is numeric-aware (K-9 before K-10); a type counts once per story.
    expect(gaps.stories).toEqual([
      { ident: expect.any(String), key: 'K-9', title: 'A' },
      { ident: expect.any(String), key: 'K-10', title: 'B' },
    ]);
    expect(gaps.gapTypes).toEqual({ edge_case: 1, rule: 1 });
    // Delivery points carry none of it.
    expect(seriesOf(f, 'workingTimeS').points[0]!.stories).toBeUndefined();
  });

  it(`the hover list is capped at ${STORY_HEALTH_HOVER_STORIES}, the rest counted`, () => {
    const many = Array.from({ length: STORY_HEALTH_HOVER_STORIES + 3 }, (_, i) => labelled(OK, withGap(true), { key: `K-${i + 1}` }));
    const p = seriesOf(foldStoryHealth(many, weeks, { nowMs: NOW, labels: true }), 'specGaps').points[0]!;
    expect(p.stories).toHaveLength(STORY_HEALTH_HOVER_STORIES);
    expect(p.storiesMore).toBe(3);
  });

  it('⚠ ignores a label that judged a different number of criteria than today', () => {
    const f = foldStoryHealth([story({ criteriaCount: 2, label: { criteria: crit([false]), story: { dependencies: [DEP], gaps: [GAP] } } })], weeks, {
      nowMs: NOW,
      labels: true,
    });
    for (const id of ['unclearDone', 'specGaps']) expect(seriesOf(f, id).points[0]!.n).toBe(0);
  });

  it('⚠ Blocked is OMITTED when no story in the span has a linked blocker; a held series is listed too', () => {
    const none = foldStoryHealth([labelled(OK, withDep(true), { links: [] }), labelled(OK)], weeks, {
      nowMs: NOW,
      labels: true,
      held: { specGaps: 'not agreed' },
    });
    expect(none.series.some((x) => x.id === 'blocked')).toBe(false);
    expect(none.omitted).toEqual([
      { series: 'blocked', reason: 'no_links' },
      { series: 'specGaps', reason: 'held' },
    ]);
    const one = foldStoryHealth([labelled(OK, {}, { links: [doneLink] })], weeks, { nowMs: NOW, labels: true });
    expect(one.series.some((x) => x.id === 'blocked')).toBe(true);
    expect(one.omitted).toEqual([]);
  });

  it('omits every label series, the coverage and the to-do count when labels are off — the linked-blocker series stays', () => {
    const f = foldStoryHealth(
      [labelled(OK, {}, { links: [doneLink] }), story({ criteriaCount: 0, labellable: false })],
      weeks,
      { nowMs: NOW, labels: false, held: { specGaps: 'not agreed' } },
    );
    const labelIds = STORY_HEALTH_SERIES.filter((s) => s.source === 'label').map((s) => s.id);
    expect(labelIds).toEqual(['unclearDone', 'specGaps']);
    expect(f.series.some((s) => (labelIds as string[]).includes(s.id))).toBe(false);
    expect(f.series.map((s) => s.id)).toContain('workingTimeS');
    expect(seriesOf(f, 'blocked').points[0]).toMatchObject({ value: 100, n: 1 });
    // A held LABEL series is not listed while labels are off.
    expect(f.omitted).toEqual([]);
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
    // Three labelled stories a week, no spec gaps — except one story in week 9. Weekly that is
    // 0% → 33% → 0%; pooled it is at most 1 of 15.
    const stories: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) {
      for (let k = 0; k < 3; k += 1) stories.push(labelled(OK, withGap(w === 9 && k === 0), { createdMs: at(w) }));
    }
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    expect(f.shifts.filter((s) => s.series === 'specGaps')).toEqual([]);
    // Nor do small weeks swinging 0% ↔ 100% with no change in the pooled share.
    const swing: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) for (let k = 0; k < 3; k += 1) swing.push(labelled(OK, {}, { createdMs: at(w), links: w % 2 === 0 ? [doneLink] : [] }));
    expect(foldStoryHealth(swing, weeks, { nowMs: NOW, labels: true }).shifts.filter((s) => s.series === 'blocked')).toEqual([]);
  });

  it('rate series: a real 40% → 80% over 20 + 20 stories flags, with pooled shares and units', () => {
    const stories: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 8; w += 1) {
      for (let k = 0; k < 5; k += 1) stories.push(labelled(OK, withGap(k < (w < 4 ? 2 : 4)), { createdMs: at(w) }));
    }
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    const s = f.shifts.find((x) => x.series === 'specGaps')!;
    // Lower is better for every issue: up is worse.
    expect(s).toMatchObject({ week: 4, before: 40, after: 80, beforeN: 20, afterN: 20, nOf: 'stories', beforeWeeks: 4, afterWeeks: 4, direction: 'up', verdict: 'worse' });
    expect(twoProportionZ(8, 20, 16, 20)).toBeGreaterThanOrEqual(STORY_SHIFT_Z);
    // Fewer than STORY_SHIFT_MIN_STORIES a side: 14 + 14 stories, 43% → 86%, never flags.
    const few: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 4; w += 1) {
      for (let k = 0; k < 7; k += 1) few.push(labelled(OK, withGap(k < (w < 2 ? 3 : 6)), { createdMs: at(w) }));
    }
    expect(foldStoryHealth(few, weeks, { nowMs: NOW, labels: true }).shifts.filter((x) => x.series === 'specGaps')).toEqual([]);
  });

  it('rate series: criteria met tests CRITERIA, with the story floor', () => {
    const build = (perSide: number, of: number) => {
      const out: StoryHealthStoryInput[] = [];
      for (let i = 0; i < perSide; i += 1) out.push(story({ lastMergedMs: at(i % 5), review: { met: of / 4, total: of } }));
      for (let i = 0; i < perSide; i += 1) out.push(story({ lastMergedMs: at(6 + (i % 5)), review: { met: of / 2, total: of } }));
      return foldStoryHealth(out, weeks, { nowMs: NOW, labels: true }).shifts.filter((s) => s.series === 'criteriaMet');
    };
    // 15 + 15 stories, four criteria each: 25% → 50% over 60 + 60 criteria flags…
    const [hit] = build(15, 4);
    expect(hit).toMatchObject({ before: 25, after: 50, beforeN: 60, afterN: 60, nOf: 'criteria', beforeStories: 15, afterStories: 15 });
    // …the same shares over one criterion a story (15 + 15 units) do not…
    expect(twoProportionZ(15 * 0.25, 15, 15 * 0.5, 15)).toBeLessThan(STORY_SHIFT_Z);
    // …and 10 + 10 stories never flag, however many criteria they carry.
    expect(build(10, 40)).toEqual([]);
  });

  it('⚠ criteria that can’t be checked tests CRITERIA, but the floor counts STORIES — clustering cannot fake a shift', () => {
    // 6 + 6 stories with 20 criteria each: 10% → 60% over 120 + 120 criteria. Huge z, but 6 stories a
    // side: never flagged.
    const build = (perSide: number, n: number) => {
      const out: StoryHealthStoryInput[] = [];
      const flags = (bad: number) => Array.from({ length: n }, (_, i) => i >= bad);
      for (let i = 0; i < perSide; i += 1) out.push(labelled(flags(n / 10), {}, { createdMs: at(i % 5) }));
      for (let i = 0; i < perSide; i += 1) out.push(labelled(flags((6 * n) / 10), {}, { createdMs: at(6 + (i % 5)) }));
      return foldStoryHealth(out, weeks, { nowMs: NOW, labels: true }).shifts.filter((s) => s.series === 'unclearDone');
    };
    expect(twoProportionZ(12, 120, 72, 120)).toBeGreaterThan(STORY_SHIFT_Z);
    expect(build(6, 20)).toEqual([]);
    // 15 + 15 stories, the same shares: flagged, counted in criteria, stories alongside.
    const [hit] = build(15, 10);
    expect(hit).toMatchObject({ before: 10, after: 60, beforeN: 150, afterN: 150, nOf: 'criteria', beforeStories: 15, afterStories: 15, verdict: 'worse' });
  });

  it('a story with nothing merged yet is in refinement only', () => {
    const f = foldStoryHealth([story({ createdMs: at(11), lastMergedMs: null })], weeks, { nowMs: NOW, labels: true });
    expect(f.weeks[11]!.storiesCreated).toBe(1);
    expect(f.weeks.reduce((n, w) => n + w.storiesMerged, 0)).toBe(0);
  });

  it('⚠ a story whose ticket text was never read is left out of every refinement series, never counted as "no criteria"', () => {
    const f = foldStoryHealth(
      [story({ criteriaCount: 0, labellable: false }), story({ ticketKnown: false, criteriaCount: 0, labellable: false })],
      weeks,
      { nowMs: NOW, labels: true },
    );
    expect(seriesOf(f, 'unclearDone').points[0]).toMatchObject({ value: null, n: 0 });
    expect(seriesOf(f, 'specGaps').points[0]).toMatchObject({ value: null, n: 0 });
    expect(f.weeks[0]!.storiesCreated).toBe(2);
    // The read ticket with no criteria is counted apart; the unread one is not.
    expect(f.weeks[0]!.noCriteria).toBe(1);
  });

  it('⚠ a week of unlabelled and no-criteria stories reads no rate and raises no shift (coverage is not a change)', () => {
    // Weeks 0-5: 10 labelled stories each, 2 untestable. Weeks 6-12: 10 no-criteria + 10 unlabelled, 0 labelled.
    const stories: StoryHealthStoryInput[] = [];
    for (let w = 0; w < 13; w += 1) {
      for (let i = 0; i < 10; i += 1) {
        if (w < 6) stories.push(labelled(i < 2 ? [false] : OK, {}, { createdMs: at(w) }));
        else {
          stories.push(story({ createdMs: at(w), criteriaCount: 0, label: null, labellable: false }));
          stories.push(story({ createdMs: at(w), criteriaCount: 4, label: null }));
        }
      }
    }
    const f = foldStoryHealth(stories, weeks, { nowMs: NOW, labels: true });
    const pts = seriesOf(f, 'unclearDone').points;
    expect(pts[3]!.value).toBe(20);
    for (let w = 6; w < 13; w += 1) expect(pts[w]).toMatchObject({ value: null, n: 0 });
    expect(f.shifts.filter((s) => s.series === 'unclearDone')).toEqual([]);
    expect(f.weeks[8]!.noCriteria).toBe(10);
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
    const done = labelled([true], {}, { createdMs: at(6) });
    const none = story({ createdMs: at(7), labellable: false });
    const old = story({ createdMs: T0 - 40 * DAY });
    expect(storiesToLabel([a, b, done, none, old], weeks).map((s) => s.ident)).toEqual([b.ident, a.ident]);
  });
});

describe('held series', () => {
  it('a held series is left out entirely — no points, no shifts', () => {
    const f = foldStoryHealth([], [], { nowMs: 0, labels: true, held: { specGaps: 'not agreed' } });
    expect(f.series.some((s) => s.id === 'specGaps')).toBe(false);
    expect(foldStoryHealth([], [], { nowMs: 0, labels: true }).series.some((s) => s.id === 'specGaps')).toBe(true);
  });
});
