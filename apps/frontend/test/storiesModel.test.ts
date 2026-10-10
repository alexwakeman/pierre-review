// Reports → Stories: the pure folds behind the tab (chart rows, row text).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storiesModel.test.ts
import { describe, expect, it } from 'vitest';
import { STORY_TIME_CHART_ROWS, type StoryRow } from '@pierre-review/shared';
import {
  buildSizeModel,
  buildTimeRows,
  formatWorkingTime,
  reviewShortfallParts,
  storyLabel,
  storyMetaParts,
} from '../src/components/Activity/storiesModel.js';
import { effectiveInsightsTab } from '../src/components/Activity/bottlenecksModel.js';

function story(over: Partial<StoryRow> & { key: string }): StoryRow {
  // Cast: the fixture leaves out fields no fold here reads.
  return {
    ident: `jira:https://x.atlassian.net#${over.key}`,
    title: `Title ${over.key}`,
    url: null,
    provider: 'jira',
    prs: { total: 1, open: 0, merged: 1, closed: 0, mergedInWindow: 1 },
    pullRequests: [],
    firstOpenedAt: '2026-10-01T09:00:00Z',
    lastMergedAt: '2026-10-02T09:00:00Z',
    workingHours: 8,
    clockHours: 24,
    linesChanged: 100,
    files: 3,
    unsizedPrs: 0,
    criteria: { count: 3, source: 'acceptance_criteria' },
    review: null,
    unmetCount: 0,
    ...over,
  } as StoryRow;
}

describe('the Stories tab literal', () => {
  it('is a member the derive keeps', () => {
    expect(effectiveInsightsTab('stories')).toBe('stories');
    expect(effectiveInsightsTab('nonsense')).toBe('overview');
  });
});

describe('chart (a): time and pull requests', () => {
  it('ranks by working hours, caps, and states what it cut', () => {
    const many = Array.from({ length: STORY_TIME_CHART_ROWS + 4 }, (_, i) =>
      story({ key: `K-${i}`, ident: `i${i}`, workingHours: i, prs: { total: i % 3, open: 0, merged: 1, closed: 0, mergedInWindow: 1 } }),
    );
    const m = buildTimeRows(many);
    expect(m.labels).toHaveLength(STORY_TIME_CHART_ROWS);
    expect(m.more).toBe(4);
    expect(m.hours[0]).toBe(STORY_TIME_CHART_ROWS + 3);
    expect(m.labels[0]).toBe(`K-${STORY_TIME_CHART_ROWS + 3} Title K-${STORY_TIME_CHART_ROWS + 3}`);
    expect(m.prs[0]).toBe((STORY_TIME_CHART_ROWS + 3) % 3);
  });

  it('writes the key alone when there is no title', () => {
    expect(storyLabel({ key: 'K-1', title: null })).toBe('K-1');
    expect(storyLabel({ key: 'K-1', title: '  ' })).toBe('K-1');
  });
});

describe('chart (b): size and criteria', () => {
  it('never plots an unknown at zero, and flags shortfall stories', () => {
    const rows = [
      story({ key: 'A', ident: 'a', linesChanged: 50, criteria: { count: 2, source: 'review' } }),
      story({ key: 'B', ident: 'b', linesChanged: null, files: null, unsizedPrs: 1 }),
      story({ key: 'C', ident: 'c', criteria: { count: null, source: 'none' } }),
      story({ key: 'D', ident: 'd', linesChanged: 0, criteria: { count: 0, source: 'acceptance_criteria' } }),
    ];
    const m = buildSizeModel(rows, ['a']);
    expect(m.points.map((p) => [p.ident, p.x, p.y, p.flagged])).toEqual([
      ['a', 50, 2, true],
      ['d', 0, 0, false],
    ]);
    expect(m.unsized.map((s) => s.ident)).toEqual(['b']);
    expect(m.noCriteria.map((s) => s.ident)).toEqual(['c']);
  });
});

describe('row text', () => {
  it('prints an unknown size as unknown, and the criteria source', () => {
    const parts = storyMetaParts(story({ key: 'A', linesChanged: null, workingHours: 4 }), 8);
    expect(parts).toEqual(['1 pull request', '4h to merge', 'size unknown', '3 criteria (from the ticket’s criteria)']);
    expect(storyMetaParts(story({ key: 'A', criteria: { count: null, source: 'none' } }), 8)).toContain('no criteria found');
  });

  it('formats working time in working days past one day', () => {
    expect(formatWorkingTime(16, 8)).toBe('2 working days');
    expect(formatWorkingTime(8, 8)).toBe('1 working day');
    expect(formatWorkingTime(0.5, 8)).toBe('30m');
    expect(formatWorkingTime(0, 8)).toBe('0h');
  });

  it('names only the non-zero shortfalls', () => {
    const s = story({
      key: 'A',
      review: {
        id: 1,
        alignment: 'partly_aligned',
        met: 2,
        partlyMet: 1,
        notMet: 0,
        unclear: 0,
        notChecked: 0,
        total: 3,
        missing: 2,
        checkedAt: null,
      },
    });
    expect(reviewShortfallParts(s)).toEqual(['1 partly met', '2 missing']);
    expect(reviewShortfallParts(story({ key: 'B' }))).toEqual([]);
  });
});
