// Activity → This Sprint — the CODE-WRITTEN row summary of a Theme / People lane (shared
// `sprintLaneSummary`). Pure; lives here because the backend suite is the one that runs in CI.
import { describe, expect, it } from 'vitest';
import { sprintLaneSummary, type SprintColumn } from '@pierre-review/shared';

const COLS: SprintColumn[] = [
  { id: 'todo', name: 'Not started', meaning: 'not_started' },
  { id: 'dev', name: 'In progress', meaning: 'in_progress' },
  { id: 'cr', name: 'Code review', meaning: 'in_review' },
  { id: 'pr', name: 'Product review', meaning: 'product_review' },
  { id: 'done', name: 'Complete', meaning: 'done' },
];
const t = (column: string | null, ...states: Array<'open' | 'merged' | 'closed'>) => ({ column, prs: states.map((state) => ({ state })) });

describe('sprintLaneSummary', () => {
  it('counts by column in column order (empty columns left out), unknown apart; a PR = open or merged', () => {
    const s = sprintLaneSummary([t('done', 'merged'), t('cr', 'open'), t('cr', 'closed'), t(null), t('gone', 'merged')], COLS);
    expect(s.byColumn).toEqual([
      { columnId: 'cr', name: 'Code review', count: 2 },
      { columnId: 'done', name: 'Complete', count: 1 },
    ]);
    expect(s).toMatchObject({ tickets: 5, unknown: 2, withPr: 3, withoutPr: 2 });
    expect(s.progress).toBe('2 Code review, 1 Complete, 2 status unknown');
    // A closed-unmerged PR is not code that landed or is under way.
    expect(s.code).toBe('3 with a pull request, 2 without');
  });

  it('all / none / one / empty read plainly', () => {
    expect(sprintLaneSummary([t('dev', 'open'), t('done', 'merged')], COLS).code).toBe('All have a pull request');
    expect(sprintLaneSummary([t('todo'), t('todo')], COLS).code).toBe('None has a pull request');
    expect(sprintLaneSummary([t('todo')], COLS)).toMatchObject({ progress: '1 Not started', code: 'No pull request' });
    expect(sprintLaneSummary([t('pr', 'merged')], COLS)).toMatchObject({ progress: '1 Product review', code: 'Has a pull request' });
    expect(sprintLaneSummary([], COLS)).toMatchObject({ tickets: 0, progress: '', code: '', byColumn: [] });
  });
});
