import { describe, expect, it } from 'vitest';
import { sprintIssuesWithClaude,
  STORY_ISSUES,
  STORY_TOO_BIG_CRITERIA,
  applyStoryIssueChecks,
  criteriaPhrase,
  foldStoryIssues,
  sprintBullets,
  sprintCommentMarkdown,
  storyIssueBullet,
  storyIssueChipText,
  storyIssueMeasure,
  storyIssueStates,
  storyIssueTypeChecked,
  type StoryCriterionLabel,
  type StoryIssueLabel,
  type SprintAssessmentRecord,
} from '@pierre-review/shared';

// The four story issues (packages/shared/src/story-issues.ts): the ONE fold, its templates and the
// checks filter. Pure.

const crit = (n: number, over: Partial<StoryCriterionLabel> = {}): StoryCriterionLabel => ({
  n,
  testable: true,
  bundled: false,
  dependsOnOtherWork: false,
  ...over,
});
const items = (k: number): string[] => Array.from({ length: k }, (_, i) => `criterion ${i + 1}`);
const clean = (k: number, story: Partial<StoryIssueLabel['story']> = {}): StoryIssueLabel => ({
  criteria: Array.from({ length: k }, (_, i) => crit(i + 1)),
  story: { outOfScopeStated: true, dependencyNamed: true, nonCodeWork: false, ...story },
});

describe('foldStoryIssues', () => {
  it('a clean labelled ticket has no issues', () => {
    expect(foldStoryIssues({ criteria: items(3), label: clean(3) })).toEqual([]);
  });

  it('no criteria is unclear_done from code alone, with or without a label', () => {
    const out = foldStoryIssues({ criteria: [], label: null });
    expect(out).toEqual([{ id: 'unclear_done', criteria: [], total: 0, reasons: ['no_criteria'] }]);
    expect(storyIssueChipText(out[0]!)).toBe('Unclear when done · no criteria');
  });

  it('no label: only the code halves (no criteria, more than 8 criteria) are raised', () => {
    expect(foldStoryIssues({ criteria: items(5), label: null })).toEqual([]);
    const big = foldStoryIssues({ criteria: items(STORY_TOO_BIG_CRITERIA + 1), label: null });
    expect(big.map((i) => i.id)).toEqual(['too_big']);
    expect(big[0]!.reasons).toEqual(['many_criteria']);
    expect(foldStoryIssues({ criteria: items(STORY_TOO_BIG_CRITERIA), label: null })).toEqual([]);
  });

  it('a label that judged a different number of criteria is ignored', () => {
    const l = clean(3, { outOfScopeStated: false });
    expect(foldStoryIssues({ criteria: items(4), label: l })).toEqual([]);
  });

  it('folds every label into exactly one of the four issues, in order', () => {
    const l: StoryIssueLabel = {
      criteria: [
        crit(1, { testable: false }),
        crit(2, { bundled: true, dependsOnOtherWork: true }),
        crit(3, { testable: false, bundled: true }),
        crit(4),
      ],
      story: { outOfScopeStated: false, dependencyNamed: false, nonCodeWork: true },
    };
    const out = foldStoryIssues({ criteria: items(4), label: l });
    expect(out.map((i) => i.id)).toEqual(STORY_ISSUES.map((m) => m.id));
    expect(out[0]).toEqual({ id: 'unclear_done', criteria: [1, 3], total: 4, reasons: ['untestable'] });
    expect(out[1]).toEqual({ id: 'too_big', criteria: [2, 3], total: 4, reasons: ['bundled', 'non_code_work'] });
    expect(out[2]).toEqual({ id: 'waits_on_work', criteria: [2], total: 4, reasons: ['depends_unnamed'] });
    expect(out[3]).toEqual({ id: 'scope_unstated', criteria: [], total: 4, reasons: ['no_out_of_scope'] });
    expect(out.map(storyIssueChipText)).toEqual([
      'Unclear when done · 2 of 4 criteria',
      'Too big · 2 of 4 criteria',
      'Waits on other work · 1 of 4 criteria',
      'Scope not stated',
    ]);
  });

  it('too_big on count reads the count, and folds the label reasons in too', () => {
    const l = clean(25);
    l.criteria[4] = crit(5, { bundled: true });
    const [big] = foldStoryIssues({ criteria: items(25), label: l });
    expect(big).toEqual({ id: 'too_big', criteria: [5], total: 25, reasons: ['many_criteria', 'bundled'] });
    expect(storyIssueChipText(big!)).toBe('Too big · 25 criteria');
    expect(storyIssueBullet(big!)).toBe('Split this story: it has 25 criteria and criterion 5 holds more than one outcome.');
  });
});

describe('storyIssueStates', () => {
  it('null where it cannot tell, false where the label says no', () => {
    expect(storyIssueStates({ criteria: items(3), label: null })).toEqual({
      unclear_done: null,
      too_big: null,
      waits_on_work: null,
      scope_unstated: null,
    });
    expect(storyIssueStates({ criteria: [], label: null }).unclear_done).toBe(true);
    expect(storyIssueStates({ criteria: items(3), label: clean(3) })).toEqual({
      unclear_done: false,
      too_big: false,
      waits_on_work: false,
      scope_unstated: false,
    });
  });
});

describe('storyIssueMeasure', () => {
  it('answers every issue for a labelled story and for no other (one population)', () => {
    expect(storyIssueMeasure({ criteria: items(12), label: null })).toEqual({
      unclear_done: null,
      too_big: null,
      waits_on_work: null,
      scope_unstated: null,
    });
    // No criteria is never folded in: it can never be labelled, so it would mix two populations.
    expect(storyIssueMeasure({ criteria: [], label: null }).unclear_done).toBeNull();
    expect(storyIssueMeasure({ criteria: items(12), label: clean(12) }).too_big).toBe(true);
    expect(storyIssueMeasure({ criteria: items(3), label: clean(3) }).too_big).toBe(false);
  });
});

describe('templates', () => {
  it('criteriaPhrase', () => {
    expect(criteriaPhrase([3])).toBe('criterion 3');
    expect(criteriaPhrase([2, 5])).toBe('criteria 2 and 5');
    expect(criteriaPhrase([2, 4, 5])).toBe('criteria 2, 4 and 5');
    expect(criteriaPhrase([1, 2, 3, 4])).toBe('4 criteria');
  });

  it('one sentence per issue', () => {
    expect(storyIssueBullet({ id: 'unclear_done', criteria: [2, 5], total: 12, reasons: ['untestable'] })).toBe(
      'Rewrite criteria 2 and 5 (of 12) as outcomes someone could check: the input, the action and the result.',
    );
    expect(storyIssueBullet({ id: 'too_big', criteria: [], total: 3, reasons: ['non_code_work'] })).toBe(
      'Move the work that is not code (sign-off, docs, config) into its own task.',
    );
    expect(storyIssueBullet({ id: 'waits_on_work', criteria: [4], total: 6, reasons: ['depends_unnamed'] })).toBe(
      'Criterion 4 (of 6) waits on other work: name it and link its ticket.',
    );
    expect(storyIssueBullet({ id: 'waits_on_work', criteria: [1, 4], total: 6, reasons: ['depends'] })).toBe(
      'Criteria 1 and 4 (of 6) wait on other work: say what happens if it is late.',
    );
    for (const m of STORY_ISSUES) {
      const issue = foldStoryIssues({
        criteria: items(9),
        label: {
          criteria: Array.from({ length: 9 }, (_, i) => crit(i + 1, { testable: false, bundled: true, dependsOnOtherWork: true })),
          story: { outOfScopeStated: false, dependencyNamed: true, nonCodeWork: true },
        },
      }).find((i) => i.id === m.id)!;
      const b = storyIssueBullet(issue);
      expect(b.endsWith('.')).toBe(true);
      expect(b.split(/\.\s/).length).toBe(1);
    }
  });
});

describe('checks', () => {
  const issues = foldStoryIssues({ criteria: items(3), label: clean(3, { outOfScopeStated: false }) });

  it('off drops an issue; issue types gate the whole ticket, case-insensitively', () => {
    expect(applyStoryIssueChecks(issues, { off: ['scope_unstated'], issueTypes: [] }, 'Story')).toEqual([]);
    expect(applyStoryIssueChecks(issues, { off: [], issueTypes: ['story'] }, 'Story')).toHaveLength(1);
    expect(applyStoryIssueChecks(issues, { off: [], issueTypes: ['Story'] }, 'Bug')).toEqual([]);
    expect(storyIssueTypeChecked({ off: [], issueTypes: ['Story'] }, null)).toBe(true);
  });
});

describe('sprintBullets', () => {
  const record = (body: SprintAssessmentRecord['body'], outdated = false): SprintAssessmentRecord => ({
    id: 1,
    workspaceId: 1,
    ident: 'x',
    model: 'm',
    status: 'succeeded',
    phase: null,
    repos: [],
    body,
    outdated,
    dropped: null,
    error: null,
    costUsd: null,
    numTurns: null,
    createdAt: '2026-10-10T00:00:00Z',
    completedAt: null,
  });
  const issues = foldStoryIssues({ criteria: [], label: null });

  it('the templated bullet without an assessment; a current run replaces it per id and never adds one', () => {
    const none = sprintBullets({ issues, assessment: null, issueType: null }, { off: [], issueTypes: [] });
    expect(none).toEqual([{ id: 'unclear_done', text: storyIssueBullet(issues[0]!), source: 'code', ref: null }]);

    const body = {
      summary: 'This may already be done.',
      issues: [
        { id: 'waits_on_work' as const, text: 'Needs the pricing API change in BMD-12.', ref: null },
        { id: 'unclear_done' as const, text: 'Say what a successful export looks like.', ref: { repo: 'a/b', path: 'src/x.ts' } },
      ],
      revisedCriteria: ['A user can export a CSV'],
    };
    const t = { issues, assessment: { record: record(body), currency: 'current' as const }, issueType: null };
    const got = sprintBullets(t, { off: [], issueTypes: [] });
    // waits_on_work was not raised by code: Claude's sentence for it is not a bullet.
    expect(got.map((b) => [b.id, b.source])).toEqual([['unclear_done', 'claude']]);
    expect(sprintBullets(t, { off: ['unclear_done'], issueTypes: [] })).toEqual([]);
    expect(sprintCommentMarkdown(got, body)).toBe(
      'This may already be done.\n\n- Say what a successful export looks like.\n\n**Proposed acceptance criteria**\n\n- A user can export a CSV',
    );
    // A stale run: the templated bullet.
    const stale = { ...t, assessment: { record: record(body), currency: 'stale' as const } };
    expect(sprintBullets(stale, { off: [], issueTypes: [] }).map((b) => b.source)).toEqual(['code']);
  });

  it('an outdated body is ignored', () => {
    const t = { issues, assessment: { record: record(null, true), currency: 'stale' as const }, issueType: null };
    expect(sprintBullets(t, { off: [], issueTypes: [] }).map((b) => b.source)).toEqual(['code']);
  });
});

describe('sprintIssuesWithClaude', () => {
  const body = {
    summary: 'May already be done.',
    issues: [
      { id: 'unclear_done' as const, text: 'Two options, none chosen.', ref: null },
      { id: 'scope_unstated' as const, text: 'Say what is out.', ref: null },
    ],
    revisedCriteria: [],
  };
  const coded = [{ id: 'scope_unstated' as const, criteria: [], total: 4, reasons: ['no_out_of_scope' as const] }];
  it('adds a current run’s issue that code did not raise, in order, and keeps code’s own', () => {
    expect(sprintIssuesWithClaude(coded, body, { off: [], issueTypes: [] }, 'Bug', 4)).toEqual([
      { id: 'unclear_done', criteria: [], total: 4, reasons: ['claude'] },
      coded[0],
    ]);
  });
  it('adds nothing without a current run, and obeys the checks', () => {
    expect(sprintIssuesWithClaude(coded, null, { off: [], issueTypes: [] }, 'Bug', 4)).toEqual(coded);
    expect(sprintIssuesWithClaude(coded, body, { off: ['unclear_done'], issueTypes: [] }, 'Bug', 4)).toEqual(coded);
  });
});
