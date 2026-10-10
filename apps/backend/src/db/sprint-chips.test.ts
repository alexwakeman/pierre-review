import { describe, expect, it } from 'vitest';
import type { StoryCriterionLabel, StoryIssueLabel } from '@pierre-review/shared';
import { sprintCriteriaOf, sprintIssuesFor, sprintLabelState, type SprintChipInput } from './sprint-chips.js';

// Reports → This sprint: a ticket's issues (db/sprint-chips.ts) — the four story issues over the
// criteria and the CURRENT label, the label gate, and the workspace checks.

const crit = (n: number, o: Partial<StoryCriterionLabel> = {}): StoryCriterionLabel => ({
  n,
  testable: true,
  bundled: false,
  dependsOnOtherWork: false,
  ...o,
});
const fine = { outOfScopeStated: true, dependencyNamed: true, nonCodeWork: false };
const base = (o: Partial<SprintChipInput> = {}): SprintChipInput => ({
  provider: 'jira',
  description: 'Save the basket.',
  acceptanceCriteria: '- Basket survives a reload\n- Basket expires after 30 days',
  label: null,
  ...o,
});
const ids = (i: SprintChipInput, checks?: Parameters<typeof sprintIssuesFor>[1]) => sprintIssuesFor(i, checks).map((c) => c.id);
const many = (k: number) => Array.from({ length: k }, (_, j) => `- Outcome ${j + 1}`).join('\n');

describe('sprintCriteriaOf', () => {
  it('reads the field first, then the description section, else none', () => {
    expect(sprintCriteriaOf(base(), 'jira')).toEqual({
      items: ['Basket survives a reload', 'Basket expires after 30 days'],
      source: 'acceptance_criteria',
    });
    const fromDescription = sprintCriteriaOf(
      { description: 'Intro\n\nh3. Acceptance criteria\n* One\n* Two', acceptanceCriteria: '' },
      'jira',
    );
    expect(fromDescription.source).toBe('description_heading');
    expect(fromDescription.items).toEqual(['One', 'Two']);
    expect(sprintCriteriaOf({ description: 'Nothing here', acceptanceCriteria: '' }, 'jira')).toEqual({ items: [], source: 'none' });
  });
});

describe('sprintIssuesFor — without a label', () => {
  it('a ticket with a few criteria and no label raises nothing', () => {
    expect(ids(base())).toEqual([]);
  });
  it('no criteria is "Unclear when done"', () => {
    const issues = sprintIssuesFor(base({ acceptanceCriteria: '', description: 'Fix the thing' }));
    expect(issues).toEqual([{ id: 'unclear_done', criteria: [], total: 0, reasons: ['no_criteria'] }]);
  });
  it('more than 8 criteria is "Too big" on count alone', () => {
    expect(ids(base({ acceptanceCriteria: many(8) }))).toEqual([]);
    expect(sprintIssuesFor(base({ acceptanceCriteria: many(9) }))).toEqual([
      { id: 'too_big', criteria: [], total: 9, reasons: ['many_criteria'] },
    ]);
  });
  it('criteria in the description are not an issue any more', () => {
    expect(ids(base({ acceptanceCriteria: '', description: 'Intro\n\nh3. Acceptance criteria\n* One\n* Two' }))).toEqual([]);
  });
});

describe('sprintIssuesFor — with a current label', () => {
  it('folds every label half into at most four issues', () => {
    const label: StoryIssueLabel = {
      criteria: [crit(1, { bundled: true, dependsOnOtherWork: true }), crit(2, { testable: false })],
      story: { outOfScopeStated: false, dependencyNamed: false, nonCodeWork: true },
    };
    expect(sprintIssuesFor(base({ label }))).toEqual([
      { id: 'unclear_done', criteria: [2], total: 2, reasons: ['untestable'] },
      { id: 'too_big', criteria: [1], total: 2, reasons: ['bundled', 'non_code_work'] },
      { id: 'waits_on_work', criteria: [1], total: 2, reasons: ['depends_unnamed'] },
      { id: 'scope_unstated', criteria: [], total: 2, reasons: ['no_out_of_scope'] },
    ]);
  });
  it('a clean label raises nothing', () => {
    expect(ids(base({ label: { criteria: [crit(1), crit(2)], story: fine } }))).toEqual([]);
  });
  it('a label judging a different number of criteria is ignored', () => {
    const label = { criteria: [crit(1, { testable: false })], story: { ...fine, outOfScopeStated: false } };
    expect(ids(base({ label }))).toEqual([]);
    expect(sprintLabelState(base({ label }), true)).toBe('pending');
  });
});

describe('sprintLabelState', () => {
  const label = { criteria: [crit(1), crit(2)], story: fine };
  it('off / none / current / pending', () => {
    expect(sprintLabelState(base({ label }), false)).toBe('off');
    expect(sprintLabelState(base({ acceptanceCriteria: '', description: 'x' }), true)).toBe('none');
    expect(sprintLabelState(base({ label }), true)).toBe('current');
    expect(sprintLabelState(base(), true)).toBe('pending');
  });
});

describe('sprintIssuesFor — the workspace checks', () => {
  const label: StoryIssueLabel = { criteria: [crit(1), crit(2)], story: { ...fine, outOfScopeStated: false } };
  it('a switched-off issue is not raised', () => {
    expect(ids(base({ label }), { off: ['scope_unstated'], issueTypes: [] })).toEqual([]);
  });
  it('a ticket whose type is not listed raises nothing, case-insensitively', () => {
    const storyOnly = { off: [], issueTypes: ['story'] };
    expect(ids(base({ label, issueType: 'Bug' }), storyOnly)).toEqual([]);
    expect(ids(base({ label, issueType: 'Story' }), storyOnly)).toEqual(['scope_unstated']);
    expect(ids(base({ label, issueType: null }), storyOnly)).toEqual(['scope_unstated']);
  });
});
