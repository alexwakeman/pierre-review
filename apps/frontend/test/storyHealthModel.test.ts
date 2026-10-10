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
    series: 'scopeUnstated',
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
      { id: 'scopeUnstated' as const, points: [] },
      { id: 'unclearDone' as const, points: [] },
      { id: 'workingTimeS' as const, points: [] },
    ];
    expect(panelSeries({ series }, 'refinement').map((x) => x.meta.id)).toEqual(['unclearDone', 'scopeUnstated']);
    expect(panelSeries({ series }, 'delivery').map((x) => x.meta.id)).toEqual(['workingTimeS']);
  });

  it('draws one refinement series per story issue, labelled with the issue, lower is better', () => {
    const ref = STORY_HEALTH_SERIES.filter((m) => m.panel === 'refinement');
    expect(ref.map((m) => m.label)).toEqual(STORY_ISSUES.map((i) => i.label));
    for (const m of ref) expect(m).toMatchObject({ source: 'label', unit: 'pct', over: 'stories', better: 'lower' });
    expect(new Set(ref.map((m) => STORY_SERIES_COLOR[m.id])).size).toBe(4);
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
    const meta = STORY_HEALTH_SERIES_BY_ID.tooBig;
    const p = (o: Partial<StoryHealthPoint>): StoryHealthPoint => ({ value: 60, n: 5, thin: false, rolling: 55, rollingWeeks: 4, ...o });
    expect(pointLine(meta, p({}))).toBe('60% (5 stories) · 4 weeks 55%');
    expect(pointLine(meta, p({ n: 2, thin: true }))).toBe('60% (2 stories): too few to compare');
    expect(pointLine(meta, p({ value: null, n: 0 }))).toBe('none');
    expect(pointLine(STORY_HEALTH_SERIES_BY_ID.criteriaMet, p({ n: 1, rolling: null }))).toBe('60% (1 reviewed story)');
  });

  it('clusters only visible series, by week, in legend order', () => {
    const shifts = [
      shift({ series: 'tooBig', week: 6 }),
      shift({ series: 'unclearDone', week: 6 }),
      shift({ series: 'waitsOnWork', week: 3 }),
    ];
    const c = clusterShifts(shifts, new Set(['unclearDone', 'tooBig']));
    expect(c).toHaveLength(1);
    expect(c[0]?.week).toBe(6);
    expect(c[0]?.shifts.map((s) => s.series)).toEqual(['unclearDone', 'tooBig']);
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
});
