import { describe, expect, it } from 'vitest';
import { sprintChipFix, type StoryCriterionLabel } from '@pierre-review/shared';
import { sprintChipsFor, sprintCriteriaOf, sprintLabelState, type SprintChipInput } from './sprint-chips.js';

// Reports → This sprint: the chips (db/sprint-chips.ts) — every code rule, every label rule, the
// current-label gate, the order, and the templated fix text.

const VALUE = 'As a shopper, I want to save my basket, so that I can finish later.';
const crit = (n: number, o: Partial<StoryCriterionLabel> = {}): StoryCriterionLabel => ({
  n,
  testable: true,
  bundled: false,
  dependsOnOtherWork: false,
  ...o,
});
const base = (o: Partial<SprintChipInput> = {}): SprintChipInput => ({
  provider: 'jira',
  title: 'Save basket',
  description: VALUE,
  acceptanceCriteria: '- Basket survives a reload\n- Basket expires after 30 days',
  label: null,
  ...o,
});
const ids = (i: SprintChipInput) => sprintChipsFor(i).map((c) => c.id);

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

describe('sprintChipsFor — code rules', () => {
  it('a well-written ticket with no label carries no chips', () => {
    expect(ids(base())).toEqual([]);
  });

  it('no criteria and no persona', () => {
    expect(ids(base({ acceptanceCriteria: '', description: 'Fix the thing' }))).toEqual(['no_criteria', 'no_persona']);
  });

  it('criteria in the description are flagged on Jira only', () => {
    const description = `${VALUE}\n\nh3. Acceptance criteria\n* One\n* Two`;
    expect(ids(base({ acceptanceCriteria: '', description }))).toEqual(['criteria_not_in_field']);
    const md = `${VALUE}\n\n## Acceptance criteria\n- One\n- Two`;
    expect(ids(base({ provider: 'linear', acceptanceCriteria: '', description: md }))).toEqual([]);
    expect(ids(base({ provider: 'github', acceptanceCriteria: '', description: md }))).toEqual([]);
  });
});

describe('sprintChipsFor — label rules', () => {
  it('criterion chips carry the criterion they judged; story chips follow the order', () => {
    const chips = sprintChipsFor(
      base({
        label: {
          criteria: [crit(1, { bundled: true, dependsOnOtherWork: true }), crit(2, { testable: false })],
          story: { outOfScopeStated: false, dependencyNamed: false, nonCodeWork: true },
        },
      }),
    );
    expect(chips.map((c) => [c.id, c.criterion?.n ?? null])).toEqual([
      ['criterion_not_testable', 2],
      ['criterion_bundled', 1],
      ['criterion_depends_on_other_work', 1],
      ['dependency_not_named', null],
      ['out_of_scope_missing', null],
      ['non_code_work', null],
    ]);
    const notTestable = chips[0]!;
    expect(notTestable.criterion).toEqual({ n: 2, text: 'Basket expires after 30 days' });
    expect(notTestable.fix).toBe(sprintChipFix('criterion_not_testable', notTestable.criterion));
    expect(notTestable.fix).toContain('“Basket expires after 30 days”');
  });

  it('dependency_not_named only when a criterion depends on other work', () => {
    const story = { outOfScopeStated: true, dependencyNamed: false, nonCodeWork: false };
    expect(ids(base({ label: { criteria: [crit(1), crit(2)], story } }))).toEqual([]);
    expect(ids(base({ label: { criteria: [crit(1), crit(2, { dependsOnOtherWork: true })], story: { ...story, dependencyNamed: true } } }))).toEqual([
      'criterion_depends_on_other_work',
    ]);
  });

  it('a label judging a different number of criteria (stale) makes no label chips', () => {
    const label = { criteria: [crit(1, { testable: false })], story: { outOfScopeStated: false, dependencyNamed: true, nonCodeWork: false } };
    expect(ids(base({ label }))).toEqual([]);
    expect(sprintLabelState(base({ label }), true)).toBe('pending');
  });

  it('criterion text is clipped to the labeller’s 500 characters', () => {
    const long = 'x'.repeat(700);
    const chips = sprintChipsFor(
      base({
        acceptanceCriteria: `- ${long}`,
        label: { criteria: [crit(1, { bundled: true })], story: { outOfScopeStated: true, dependencyNamed: true, nonCodeWork: false } },
      }),
    );
    expect(chips[0]!.criterion!.text.length).toBe(500);
  });
});

describe('sprintLabelState', () => {
  const label = { criteria: [crit(1), crit(2)], story: { outOfScopeStated: true, dependencyNamed: true, nonCodeWork: false } };
  it('off / none / current / pending', () => {
    expect(sprintLabelState(base({ label }), false)).toBe('off');
    expect(sprintLabelState(base({ acceptanceCriteria: '', description: 'x' }), true)).toBe('none');
    expect(sprintLabelState(base({ label }), true)).toBe('current');
    expect(sprintLabelState(base(), true)).toBe('pending');
  });
});

describe('sprintChipsFor — the workspace checks', () => {
  const bare = base({ acceptanceCriteria: '', description: 'Fix the thing', issueType: 'Bug' });
  it('a switched-off check raises nothing', () => {
    expect(sprintChipsFor(bare, { off: ['no_persona'], issueTypes: {} }).map((c) => c.id)).toEqual(['no_criteria']);
  });
  it('a check limited to other issue types skips this one, case-insensitively', () => {
    const storyOnly = { off: [], issueTypes: { no_persona: ['story'] } };
    expect(sprintChipsFor(bare, storyOnly).map((c) => c.id)).toEqual(['no_criteria']);
    expect(sprintChipsFor({ ...bare, issueType: 'Story' }, storyOnly).map((c) => c.id)).toEqual(['no_criteria', 'no_persona']);
  });
  it('the template without a reason names a persona', () => {
    expect(ids(base({ description: 'As an admin I want a delete button' }))).not.toContain('no_persona');
  });
});
