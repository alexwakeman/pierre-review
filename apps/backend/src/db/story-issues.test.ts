import { describe, expect, it } from 'vitest';
import {
  STORY_ISSUES,
  applyStoryIssueChecks,
  foldStoryIssues,
  isBlockingRelation,
  isStoryIssueId,
  joinCapped,
  parseTicketLinkBlockers,
  sprintBullets,
  sprintCommentMarkdown,
  sprintIssuesWithClaude,
  storyBlockedSource,
  storyBlockerPhrase,
  storyIssueBullet,
  storyIssueChipText,
  storyIssueMeasure,
  storyIssueStates,
  storyIssueTypeChecked,
  type KnownTicket,
  type SprintAssessmentRecord,
  type StoryCriterionLabel,
  type StoryIssue,
  type StoryIssueLabel,
  type TicketLinkBlocker,
} from '@pierre-review/shared';

// The three story issues (packages/shared/src/story-issues.ts): the ONE fold, its two questions (now vs
// as written), its templates and the checks filter. Pure.

const crit = (n: number, over: Partial<StoryCriterionLabel> = {}): StoryCriterionLabel => ({ n, testable: true, reason: null, ...over });
const items = (k: number): string[] => Array.from({ length: k }, (_, i) => `criterion ${i + 1}`);
const clean = (k: number, story: Partial<StoryIssueLabel['story']> = {}): StoryIssueLabel => ({
  criteria: Array.from({ length: k }, (_, i) => crit(i + 1)),
  story: { dependencies: [], gaps: [], ...story },
});
const link = (key: string, o: Partial<TicketLinkBlocker> = {}): TicketLinkBlocker => ({
  key,
  title: `Title ${key}`,
  status: 'To Do',
  category: 'new',
  relation: 'is blocked by',
  url: null,
  ...o,
});
const issue = (o: Partial<StoryIssue> & Pick<StoryIssue, 'id'>): StoryIssue => ({
  total: 3,
  reasons: [],
  criteria: [],
  blockers: [],
  gaps: [],
  ...o,
});

describe('foldStoryIssues', () => {
  it('a clean labelled ticket has no issues', () => {
    expect(foldStoryIssues({ criteria: items(3), label: clean(3) })).toEqual([]);
  });

  it('no criteria is unclear_done from code alone', () => {
    const out = foldStoryIssues({ criteria: [], label: null });
    expect(out).toEqual([issue({ id: 'unclear_done', total: 0, reasons: ['no_criteria'] })]);
    expect(storyIssueChipText(out[0]!)).toBe('Unclear when done · no criteria');
  });

  it('no label: a long list raises nothing ("Too big" is gone); a label of the wrong length is ignored', () => {
    expect(foldStoryIssues({ criteria: items(25), label: null })).toEqual([]);
    const wrong = { criteria: [crit(1, { testable: false, reason: 'vague' })], story: { dependencies: [], gaps: [] } };
    expect(foldStoryIssues({ criteria: items(4), label: wrong })).toEqual([]);
  });

  it('folds a label into the three issues, in order, each with its detail', () => {
    const l: StoryIssueLabel = {
      criteria: [crit(1, { testable: false, reason: 'no expected result' }), crit(2), crit(3, { testable: false, reason: "'intuitive' can't be checked" })],
      story: {
        dependencies: [{ kind: 'api', what: 'pricing API', owner: 'Payments team', ticketKey: null }],
        gaps: [{ type: 'edge_case', text: 'No behaviour when the upload fails' }],
      },
    };
    const out = foldStoryIssues({ criteria: items(3), label: l });
    expect(out.map((i) => i.id)).toEqual(STORY_ISSUES.map((m) => m.id));
    expect(out[0]!.criteria).toEqual([
      { n: 1, reason: 'no expected result' },
      { n: 3, reason: "'intuitive' can't be checked" },
    ]);
    expect(out.map(storyIssueChipText)).toEqual(['Unclear when done · 2 of 3 criteria', 'Blocked · 1 open', 'Spec gaps · 1 gap']);
    expect(out.map(storyIssueBullet)).toEqual([
      "Criterion 1: no expected result · Criterion 3: 'intuitive' can't be checked",
      'Waits on pricing API, Payments team, no ticket',
      'No behaviour when the upload fails',
    ]);
  });

  it('links come first and win a key collision; a done link is shown, never raised', () => {
    const l = clean(2, { dependencies: [{ kind: 'ticket', what: 'banner', owner: 'UCD team', ticketKey: 'bmd-568' }] });
    const out = foldStoryIssues({
      criteria: items(2),
      label: l,
      links: [link('BMD-568', { title: 'cookie banner' }), link('BMD-12', { status: 'Done', category: 'done' })],
    });
    const blocked = out.find((i) => i.id === 'blocked')!;
    expect(blocked.reasons).toEqual(['linked']);
    expect(blocked.blockers.map((b) => [b.source, b.ticketKey, b.resolved])).toEqual([
      ['link', 'BMD-568', false],
      ['link', 'BMD-12', true],
    ]);
    expect(storyIssueBullet(blocked)).toBe('Waits on BMD-568 cookie banner (To Do)');
    // Only done links → nothing raised now.
    expect(foldStoryIssues({ criteria: items(2), label: clean(2), links: [link('BMD-12', { category: 'done' })] })).toEqual([]);
  });

  it('a named key resolves through the stored tickets (title, status), and a done one is resolved', () => {
    const l = clean(2, { dependencies: [{ kind: 'ticket', what: 'banner', owner: null, ticketKey: 'BMD-9' }] });
    const known = (category: KnownTicket['category']) =>
      new Map<string, KnownTicket>([['BMD-9', { title: 'Cookie banner', status: 'In Review', category, url: null }]]);
    const [open] = foldStoryIssues({ criteria: items(2), label: l, knownTickets: known('indeterminate') });
    expect(storyBlockerPhrase(open!.blockers[0]!)).toBe('BMD-9 Cookie banner (In Review)');
    expect(foldStoryIssues({ criteria: items(2), label: l, knownTickets: known('done') })).toEqual([]);
  });
});

describe('the two questions: now vs as written', () => {
  const finished = { criteria: items(2), label: clean(2), links: [link('BMD-12', { category: 'done' })] };

  it('storyIssueStates (now): a finished blocker is not blocking', () => {
    expect(storyIssueStates(finished).blocked).toBe(false);
    // No label: blocked is true on an open link, otherwise unknown.
    expect(storyIssueStates({ criteria: items(2), label: null, links: [link('X-1')] }).blocked).toBe(true);
    expect(storyIssueStates({ criteria: items(2), label: null })).toEqual({ unclear_done: null, blocked: null, spec_gaps: null });
  });

  it('storyIssueMeasure (as written): any dependency counts, finished or not — labelled stories only', () => {
    expect(storyIssueMeasure(finished)).toEqual({ unclear_done: false, blocked: true, spec_gaps: false });
    expect(storyBlockedSource(finished)).toBe('linked');
    const textOnly = { criteria: items(2), label: clean(2, { dependencies: [{ kind: 'decision', what: 'pricing decision', owner: null, ticketKey: null }] }) };
    expect(storyBlockedSource(textOnly)).toBe('text_only');
    expect(storyIssueMeasure({ criteria: items(2), label: null, links: [link('X-1')] })).toEqual({ unclear_done: null, blocked: null, spec_gaps: null });
    // No criteria is never folded in: it can never be labelled.
    expect(storyIssueMeasure({ criteria: [], label: null }).unclear_done).toBeNull();
  });
});

describe('tracker links', () => {
  it('isBlockingRelation reads this ticket’s side of a Jira link', () => {
    for (const p of ['is blocked by', 'depends on', 'Is Dependent On', 'requires', 'waits for']) expect(isBlockingRelation(p)).toBe(true);
    for (const p of ['blocks', 'is depended on by', 'is required by', 'relates to', 'clones']) expect(isBlockingRelation(p)).toBe(false);
  });
  it('parseTicketLinkBlockers is tolerant: non-array → null, bad entries dropped, http urls dropped', () => {
    expect(parseTicketLinkBlockers(null)).toBeNull();
    expect(parseTicketLinkBlockers({})).toBeNull();
    expect(
      parseTicketLinkBlockers([{ key: ' A-1 ', category: 'odd', url: 'http://x' }, { title: 'no key' }, 7]),
    ).toEqual([{ key: 'A-1', title: null, status: null, category: null, relation: '', url: null }]);
  });
});

describe('templates', () => {
  it('joinCapped shows three, then "and N more"', () => {
    expect(joinCapped(['a', 'b'])).toBe('a · b');
    expect(joinCapped(['a', 'b', 'c', 'd', 'e'])).toBe('a · b · c and 2 more');
  });
  it('a no-criteria bullet asks for criteria', () => {
    expect(storyIssueBullet(issue({ id: 'unclear_done', total: 0, reasons: ['no_criteria'] }))).toBe(
      'Add acceptance criteria: outcomes a tester could check, one per line.',
    );
  });
  it('isStoryIssueId drops the retired ids', () => {
    for (const old of ['too_big', 'waits_on_work', 'scope_unstated', 'no_persona']) expect(isStoryIssueId(old)).toBe(false);
    for (const m of STORY_ISSUES) expect(isStoryIssueId(m.id)).toBe(true);
  });
});

describe('checks', () => {
  const issues = foldStoryIssues({ criteria: items(3), label: clean(3, { gaps: [{ type: 'rule', text: 'No rule for ties' }] }) });

  it('off drops an issue; issue types gate the whole ticket, case-insensitively', () => {
    expect(applyStoryIssueChecks(issues, { off: ['spec_gaps'], issueTypes: [] }, 'Story')).toEqual([]);
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
        { id: 'blocked' as const, text: 'Waits on the pricing API change in BMD-12, owned by Payments.', ref: null },
        { id: 'unclear_done' as const, text: 'Say what a successful export looks like.', ref: { repo: 'a/b', path: 'src/x.ts' } },
      ],
      revisedCriteria: ['A user can export a CSV'],
    };
    const t = { issues, assessment: { record: record(body), currency: 'current' as const }, issueType: null };
    const got = sprintBullets(t, { off: [], issueTypes: [] });
    // blocked was not on the row: Claude's sentence for it is not a bullet.
    expect(got.map((b) => [b.id, b.source])).toEqual([['unclear_done', 'claude']]);
    expect(sprintBullets(t, { off: ['unclear_done'], issueTypes: [] })).toEqual([]);
    expect(sprintCommentMarkdown(got, body)).toBe(
      'This may already be done.\n\n- Say what a successful export looks like.\n\n**Proposed acceptance criteria**\n\n- A user can export a CSV',
    );
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
      { id: 'spec_gaps' as const, text: 'No behaviour when the file is empty.', ref: null },
    ],
    revisedCriteria: [],
  };
  const coded = [issue({ id: 'spec_gaps', total: 4, reasons: ['gaps'], gaps: [{ type: 'edge_case', text: 'No empty-file rule' }] })];
  it('adds a current run’s issue that code did not raise, in order, and keeps code’s own', () => {
    expect(sprintIssuesWithClaude(coded, body, { off: [], issueTypes: [] }, 'Bug', 4)).toEqual([
      issue({ id: 'unclear_done', total: 4, reasons: ['claude'] }),
      coded[0],
    ]);
  });
  it('skips a retired id in a stored body, adds nothing without a run, and obeys the checks', () => {
    const old = { ...body, issues: [{ id: 'too_big', text: 'Split it.', ref: null }] } as unknown as typeof body;
    expect(sprintIssuesWithClaude(coded, old, { off: [], issueTypes: [] }, 'Bug', 4)).toEqual(coded);
    expect(sprintIssuesWithClaude(coded, null, { off: [], issueTypes: [] }, 'Bug', 4)).toEqual(coded);
    expect(sprintIssuesWithClaude(coded, body, { off: ['unclear_done'], issueTypes: [] }, 'Bug', 4)).toEqual(coded);
  });
});
