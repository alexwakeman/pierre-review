import { describe, expect, it } from 'vitest';
import {
  STORY_HEALTH_SERIES,
  STORY_HEALTH_SERIES_BY_ID,
  STORY_ISSUES,
  STORY_LABEL_RUN_CAP,
  type StoryHealthPoint,
  type StoryHealthShift,
  type StoryHealthWeek,
} from '@pierre-review/shared';
import {
  axisTop,
  clusterShifts,
  gapTypesLine,
  latestFigureLine,
  moreStoriesLine,
  omittedSentence,
  pointNumerator,
  seriesCountsSentence,
  seriesInfoLines,
  shiftSentence,
  coverageLine,
  createdLine,
  DELIVERY_STRIPS,
  formatStoryChange,
  formatStoryValue,
  headlineVerdict,
  labelPressCount,
  panelSeries,
  pointLine,
  rollingHeadline,
  shiftUnits,
  shiftVerdictWord,
  smallMultipleColumns,
  STORY_SERIES_COLOR,
  weekIndex,
} from '../src/components/Activity/storyHealthModel.js';
import { weekLabel } from '../src/components/Activity/chronologyTrendModel.js';

function week(over: Partial<StoryHealthWeek> = {}): StoryHealthWeek {
  return {
    weekStart: '2026-09-07',
    from: '2026-09-07T00:00:00.000Z',
    to: '2026-09-14T00:00:00.000Z',
    partial: false,
    storiesCreated: 15,
    createdFallback: 0,
    noCriteria: 0,
    labellable: 15,
    labelled: 12,
    storiesMerged: 9,
    unsizedStories: 0,
    reviewedStories: 4,
    ...over,
  };
}

function shift(over: Partial<StoryHealthShift>): StoryHealthShift {
  return {
    series: 'specGaps',
    week: 6,
    weekStart: '2026-08-10',
    before: 50,
    after: 70,
    beforeWeeks: 6,
    afterWeeks: 5,
    beforeN: 40,
    afterN: 35,
    nOf: 'stories',
    direction: 'up',
    verdict: 'better',
    ...over,
  };
}

describe('story health model', () => {
  it('formats each unit', () => {
    expect(formatStoryValue('pct', 48.6)).toBe('49%');
    expect(formatStoryValue('hours', 6.24)).toBe('6.2 h');
    expect(formatStoryValue('count', 2)).toBe('2');
    expect(formatStoryValue('count', 1.55)).toBe('1.6');
  });

  it('words a change with a real minus and singular points', () => {
    expect(formatStoryChange('pct', 50, 62)).toBe('+12 points');
    expect(formatStoryChange('pct', 50, 49)).toBe('−1 point');
    expect(formatStoryChange('pct', 50, 50.2)).toBe('no change');
    expect(formatStoryChange('hours', 10, 6.5)).toBe('−3.5 h');
    expect(formatStoryChange('count', 1, 1.5)).toBe('+0.5');
  });

  it('pins percentages to 0–100 and rounds other axes up', () => {
    expect(axisTop('pct', [3, 12])).toBe(100);
    expect(axisTop('hours', [null, 0.4])).toBe(1);
    expect(axisTop('hours', [37, 12])).toBe(50);
    expect(axisTop('count', [2.2])).toBe(2.5);
    expect(axisTop('hours', [])).toBe(1);
  });

  it('keeps the legend order and drops series the response omits', () => {
    const series = [
      { id: 'specGaps' as const, points: [] },
      { id: 'unclearDone' as const, points: [] },
      { id: 'workingTimeS' as const, points: [] },
    ];
    expect(panelSeries({ series }, 'refinement').map((x) => x.meta.id)).toEqual(['unclearDone', 'specGaps']);
    expect(panelSeries({ series }, 'delivery').map((x) => x.meta.id)).toEqual(['workingTimeS']);
  });

  it('draws one refinement series per story issue, labelled with the MEASURE’s label', () => {
    const ref = STORY_HEALTH_SERIES.filter((m) => m.panel === 'refinement');
    expect(ref.map((m) => m.label)).toEqual(STORY_ISSUES.map((i) => i.measureLabel));
    // The measures differ from the chips: criteria, not stories; tracker links only, finished or not.
    expect(ref.map((m) => m.label)).toEqual(['Criteria that can’t be checked', 'Stories with a linked blocker', 'Spec gaps']);
    expect(ref.map((m) => [m.source, m.over, m.better])).toEqual([
      ['label', 'criteria', 'lower'],
      ['code', 'stories', null],
      ['label', 'stories', 'lower'],
    ]);
    for (const m of ref) expect(m.unit).toBe('pct');
    expect(new Set(ref.map((m) => STORY_SERIES_COLOR[m.id])).size).toBe(3);
  });

  it('gives every series a colour and every delivery series a strip of one unit', () => {
    for (const m of STORY_HEALTH_SERIES) expect(STORY_SERIES_COLOR[m.id]).toMatch(/^#/);
    const delivery = STORY_HEALTH_SERIES.filter((m) => m.panel === 'delivery').map((m) => m.id);
    expect(DELIVERY_STRIPS.flatMap((s) => s.ids).sort()).toEqual([...delivery].sort());
    for (const s of DELIVERY_STRIPS) {
      expect(new Set(s.ids.map((id) => STORY_HEALTH_SERIES_BY_ID[id].unit)).size).toBe(1);
    }
  });

  it('prints coverage and fallback counts', () => {
    expect(coverageLine(week())).toBe('12 of 15 stories labelled');
    expect(coverageLine(week({ labelled: 0, labellable: 1 }))).toBe('0 of 1 story labelled');
    expect(createdLine(week({ createdFallback: 2 }))).toBe('15 stories written (2 dated by first pull request)');
    expect(createdLine(week({ noCriteria: 3 }))).toBe('15 stories written · 3 with no criteria');
  });

  it('says thin and unknown, never zero', () => {
    const meta = STORY_HEALTH_SERIES_BY_ID.blocked;
    const p = (o: Partial<StoryHealthPoint>): StoryHealthPoint => ({ value: 60, n: 5, thin: false, rolling: 55, rollingWeeks: 4, ...o });
    expect(pointLine(meta, p({}))).toBe('60% (5 stories) · 4 weeks 55%');
    expect(pointLine(meta, p({ n: 2, thin: true }))).toBe('60% (2 stories): too few to compare');
    expect(pointLine(meta, p({ value: null, n: 0 }))).toBe('none');
    expect(pointLine(STORY_HEALTH_SERIES_BY_ID.criteriaMet, p({ n: 1, rolling: null }))).toBe('60% (1 reviewed story)');
    expect(pointLine(STORY_HEALTH_SERIES_BY_ID.unclearDone, p({ rolling: null, criteria: { num: 12, den: 20 } }))).toBe(
      '60% (20 criteria in 5 stories)',
    );
  });

  it('clusters only visible series, by week, in legend order', () => {
    const shifts = [
      shift({ series: 'specGaps', week: 6 }),
      shift({ series: 'unclearDone', week: 6 }),
      shift({ series: 'blocked', week: 3 }),
    ];
    const c = clusterShifts(shifts, new Set(['unclearDone', 'specGaps']));
    expect(c).toHaveLength(1);
    expect(c[0]?.week).toBe(6);
    expect(c[0]?.shifts.map((s) => s.series)).toEqual(['unclearDone', 'specGaps']);
  });

  it('colours a shift only from its verdict', () => {
    expect(shiftVerdictWord(shift({ verdict: 'better' }))).toBe('Better');
    expect(shiftVerdictWord(shift({ verdict: 'worse' }))).toBe('Worse');
    expect(shiftVerdictWord(shift({ series: 'prsPerStory', verdict: null }))).toBeNull();
  });

  it('finds a picked week by its start and caps a press', () => {
    const weeks = [week({ weekStart: '2026-09-07' }), week({ weekStart: '2026-09-14' })];
    expect(weekIndex(weeks, '2026-09-14')).toBe(1);
    expect(weekIndex(weeks, '2026-01-01')).toBeNull();
    expect(labelPressCount(400, STORY_LABEL_RUN_CAP)).toBe(STORY_LABEL_RUN_CAP);
    expect(labelPressCount(0, STORY_LABEL_RUN_CAP)).toBe(0);
  });

  it('lays small charts two to a row from 560px', () => {
    expect(smallMultipleColumns(559)).toBe(1);
    expect(smallMultipleColumns(560)).toBe(2);
    expect(smallMultipleColumns(320)).toBe(1);
  });

  it('reads the headline off the rolling line: latest value and the first in the span', () => {
    const p = (rolling: number | null): StoryHealthPoint => ({ value: rolling, n: 5, thin: false, rolling, rollingWeeks: 1 });
    expect(rollingHeadline([p(null), p(40), p(55), p(null)])).toEqual({ current: 55, first: 40, firstWeek: 1 });
    expect(rollingHeadline([p(null), p(null)])).toBeNull();
  });

  it('colours the headline change only with a shift moving the same way', () => {
    expect(headlineVerdict(undefined, 40, 60)).toBeNull();
    expect(headlineVerdict(shift({ direction: 'up', verdict: 'better' }), 40, 60)).toBe('better');
    expect(headlineVerdict(shift({ direction: 'up', verdict: 'better' }), 60, 40)).toBeNull();
    expect(headlineVerdict(shift({ direction: 'down', verdict: 'worse' }), 60, 40)).toBe('worse');
    expect(headlineVerdict(shift({ series: 'prsPerStory', verdict: null }), 40, 60)).toBeNull();
  });

  it('names a shift side by its units', () => {
    expect(shiftUnits(301, 'criteria')).toBe('301 criteria');
    expect(shiftUnits(1, 'stories')).toBe('1 story');
    expect(shiftUnits(4, 'weeks')).toBe('4 weeks');
  });

  it('the chart ⓘ is computed: what counts, this week, the shift', () => {
    const meta = STORY_HEALTH_SERIES_BY_ID.blocked;
    const weeks = [week({ weekStart: '2026-08-10' }), week({ weekStart: '2026-08-17', partial: true })];
    const pts: StoryHealthPoint[] = [
      { value: 20, n: 10, thin: false, rolling: 20, rollingWeeks: 1 },
      {
        value: 44.4,
        n: 9,
        thin: false,
        rolling: 30,
        rollingWeeks: 2,
        stories: [
          { ident: 'a', key: 'BMD-1', title: 'One' },
          { ident: 'b', key: 'BMD-2', title: null },
        ],
        storiesMore: 2,
      },
    ];
    const sh = shift({ series: 'blocked', before: 19.2, after: 44, weekStart: '2026-08-17', beforeN: 32, afterN: 28, nOf: 'stories', direction: 'up' });
    expect(seriesInfoLines(meta, pts, weeks, sh)).toEqual([
      'A story counts when your tracker links it to work it waits on, finished or not.',
      'This week so far: 4 of 9 stories',
      `Rose from 19% to 44% on ${weekLabel('2026-08-17')}, 32 vs 28 stories`,
    ]);
    // No shift → nothing about shifts.
    expect(seriesInfoLines(meta, pts, weeks, undefined)).toHaveLength(2);
    // Criteria that can't be checked counts CRITERIA, this week and in the shift.
    const ud = STORY_HEALTH_SERIES_BY_ID.unclearDone;
    const cp: StoryHealthPoint[] = [{ value: 25, n: 4, thin: false, rolling: 25, rollingWeeks: 1, criteria: { num: 5, den: 20 } }];
    const csh = shift({ series: 'unclearDone', before: 10, after: 40, weekStart: '2026-08-17', beforeN: 150, afterN: 160, nOf: 'criteria', direction: 'up' });
    expect(seriesInfoLines(ud, cp, [week({ weekStart: '2026-08-17' })], csh)).toEqual([
      'Criteria in the stories Claude has read that can’t be checked as written.',
      'This week: 5 of 20 criteria',
      `Rose from 10% to 40% on ${weekLabel('2026-08-17')}, 150 vs 160 criteria`,
    ]);
  });

  it('an omitted refinement series is one short sentence', () => {
    expect(omittedSentence({ series: 'blocked', reason: 'no_links' })).toBe('No blocking links in your tracker in these 90 days.');
    expect(omittedSentence({ series: 'specGaps', reason: 'held' })).toBe(
      'Spec gaps is not charted: two readings of the same tickets disagree too often.',
    );
  });

  it('this week\'s figure: numerator from the list, else from the value; empty weeks say so', () => {
    expect(pointNumerator({ value: 50, n: 8 })).toBe(4);
    expect(pointNumerator({ value: null, n: 0 })).toBeNull();
    expect(pointNumerator({ value: 50, n: 8, stories: [], storiesMore: 0 })).toBe(0);
    const ud = STORY_HEALTH_SERIES_BY_ID.unclearDone;
    expect(latestFigureLine(ud, [{ value: null, n: 0, thin: true, rolling: null, rollingWeeks: 0 }], [week()])).toBe(
      'This week: no stories',
    );
    expect(latestFigureLine(ud, [], [])).toBeNull();
    expect(
      latestFigureLine(STORY_HEALTH_SERIES_BY_ID.workingTimeS, [{ value: 6.2, n: 3, thin: false, rolling: null, rollingWeeks: 0 }], [week()]),
    ).toBe('This week: 6.2 h · 3 stories');
    expect(
      latestFigureLine(STORY_HEALTH_SERIES_BY_ID.criteriaMet, [{ value: 80, n: 1, thin: true, rolling: null, rollingWeeks: 0 }], [week()]),
    ).toBe('This week: 80% · 1 reviewed story');
  });

  it('a time shift counts weeks; every series has a "what counts" sentence', () => {
    expect(
      shiftSentence(shift({ series: 'workingTimeM', before: 30, after: 12, direction: 'down', beforeN: 6, afterN: 5, nOf: 'weeks', weekStart: '2026-08-17' })),
    ).toBe(`Fell from 30 h to 12 h on ${weekLabel('2026-08-17')}, 6 vs 5 weeks`);
    for (const m of STORY_HEALTH_SERIES) expect(seriesCountsSentence(m.id).length).toBeGreaterThan(10);
    expect(seriesCountsSentence('workingTimeS')).toContain('under 300 lines');
  });

  it('hover extras: gap types (most first), "and N more"', () => {
    expect(gapTypesLine({ gapTypes: { rule: 2, edge_case: 4, design: 0 } })).toBe('Edge case 4 · Business rule 2');
    expect(gapTypesLine({ gapTypes: {} })).toBeNull();
    expect(moreStoriesLine({ storiesMore: 3 })).toBe('and 3 more');
    expect(moreStoriesLine({ storiesMore: 0 })).toBeNull();
  });
});
