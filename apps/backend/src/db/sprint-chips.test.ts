import { describe, expect, it } from 'vitest';
import type { KnownTicket, StoryCriterionLabel, StoryIssueLabel, StoryLevelLabels, TicketLinkBlocker } from '@pierre-review/shared';
import { sprintCriteriaOf, sprintIssuesFor, sprintLabelState, sprintSpecGapsFor, type SprintChipInput } from './sprint-chips.js';

// Reports → This sprint: a ticket's issues (db/sprint-chips.ts) — the three story issues over the
// criteria, the CURRENT label, the stored tracker links and the stored tickets a label names; the label
// gate; and the workspace checks.

const crit = (n: number, o: Partial<StoryCriterionLabel> = {}): StoryCriterionLabel => ({ n, testable: true, reason: null, ...o });
const fine: StoryLevelLabels = { dependencies: [], gaps: [] };
const base = (o: Partial<SprintChipInput> = {}): SprintChipInput => ({
  provider: 'jira',
  description: 'Save the basket.',
  acceptanceCriteria: '- Basket survives a reload\n- Basket expires after 30 days',
  label: null,
  ...o,
});
const ids = (i: SprintChipInput, checks?: Parameters<typeof sprintIssuesFor>[1]) => sprintIssuesFor(i, checks).map((c) => c.id);
const many = (k: number) => Array.from({ length: k }, (_, j) => `- Outcome ${j + 1}`).join('\n');
const link = (key: string, o: Partial<TicketLinkBlocker> = {}): TicketLinkBlocker => ({
  key,
  title: `Title ${key}`,
  status: 'To Do',
  category: 'new',
  relation: 'is blocked by',
  url: `https://acme.atlassian.net/browse/${key}`,
  ...o,
});

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
  it('a ticket with criteria and no label raises nothing — however many criteria', () => {
    expect(ids(base())).toEqual([]);
    // "Too big" is gone: a long list raises nothing on count alone.
    expect(ids(base({ acceptanceCriteria: many(20) }))).toEqual([]);
  });
  it('no criteria is "Unclear when done"', () => {
    const issues = sprintIssuesFor(base({ acceptanceCriteria: '', description: 'Fix the thing' }));
    expect(issues).toEqual([{ id: 'unclear_done', total: 0, reasons: ['no_criteria'], criteria: [], blockers: [], gaps: [] }]);
  });
  it('an open tracker link raises "Blocked" with no label; a done one does not', () => {
    const open = sprintIssuesFor(base({ links: [link('ENG-8')] }));
    expect(open.map((i) => [i.id, i.reasons])).toEqual([['blocked', ['linked']]]);
    expect(open[0]!.blockers[0]).toMatchObject({ source: 'link', ticketKey: 'ENG-8', what: 'Title ENG-8', status: 'To Do', resolved: false });
    expect(ids(base({ links: [link('ENG-6', { status: 'Done', category: 'done' })] }))).toEqual([]);
  });
  it('GitHub Issues (links null) raises only what code knows', () => {
    expect(ids(base({ provider: 'github', links: null }))).toEqual([]);
  });
});

describe('sprintIssuesFor — with a current label', () => {
  it('folds the label into the two chip issues; the spec gaps ride apart', () => {
    const label: StoryIssueLabel = {
      criteria: [crit(1), crit(2, { testable: false, reason: 'no expected result' })],
      story: {
        dependencies: [{ kind: 'design', what: 'map page design', owner: 'UCD team', ticketKey: null }],
        gaps: [{ type: 'edge_case', text: 'No behaviour when the upload fails' }],
      },
    };
    const issues = sprintIssuesFor(base({ label }));
    expect(issues.map((i) => i.id)).toEqual(['unclear_done', 'blocked']);
    expect(issues[0]!.criteria).toEqual([{ n: 2, reason: 'no expected result' }]);
    expect(issues[1]!.blockers).toEqual([
      {
        source: 'text',
        kind: 'design',
        ticketKey: null,
        what: 'map page design',
        owner: 'UCD team',
        status: null,
        category: null,
        relation: null,
        url: null,
        resolved: false,
      },
    ]);
    expect(sprintSpecGapsFor(base({ label }))).toEqual([{ type: 'edge_case', text: 'No behaviour when the upload fails' }]);
  });
  it('a text dependency naming a linked key is shown once, as the link', () => {
    const label: StoryIssueLabel = {
      criteria: [crit(1), crit(2)],
      story: { dependencies: [{ kind: 'ticket', what: 'banner', owner: null, ticketKey: 'eng-8' }], gaps: [] },
    };
    const [blocked] = sprintIssuesFor(base({ label, links: [link('ENG-8')] }));
    expect(blocked!.reasons).toEqual(['linked']);
    expect(blocked!.blockers.map((b) => [b.source, b.ticketKey])).toEqual([['link', 'ENG-8']]);
  });
  it('a named key resolves through the stored tickets; a done one is not raised', () => {
    const label: StoryIssueLabel = {
      criteria: [crit(1), crit(2)],
      story: { dependencies: [{ kind: 'ticket', what: 'banner', owner: null, ticketKey: 'ENG-9' }], gaps: [] },
    };
    const known = (category: KnownTicket['category'], status: string) =>
      new Map<string, KnownTicket>([['ENG-9', { title: 'Cookie banner', status, category, url: null }]]);
    const [open] = sprintIssuesFor(base({ label, knownTickets: known('indeterminate', 'In Progress') }));
    expect(open!.blockers[0]).toMatchObject({ what: 'Cookie banner', status: 'In Progress', resolved: false });
    expect(ids(base({ label, knownTickets: known('done', 'Done') }))).toEqual([]);
  });
  it('a clean label raises nothing', () => {
    expect(ids(base({ label: { criteria: [crit(1), crit(2)], story: fine } }))).toEqual([]);
  });
  it('a label judging a different number of criteria is ignored', () => {
    const label = { criteria: [crit(1, { testable: false, reason: 'vague' })], story: fine };
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
  const label: StoryIssueLabel = {
    criteria: [crit(1), crit(2)],
    story: { dependencies: [], gaps: [{ type: 'rule', text: 'No rule for duplicate baskets' }] },
  };
  const gaps = (i: SprintChipInput, checks?: Parameters<typeof sprintSpecGapsFor>[1]) => sprintSpecGapsFor(i, checks).map((g) => g.text);
  it('spec gaps are never a chip; the switch hides the section', () => {
    expect(ids(base({ label }))).toEqual([]);
    expect(gaps(base({ label }))).toEqual(['No rule for duplicate baskets']);
    expect(gaps(base({ label }), { off: ['spec_gaps'], issueTypes: [] })).toEqual([]);
    // No current label → no gaps.
    expect(gaps(base())).toEqual([]);
  });
  it('a ticket whose type is not listed raises nothing, case-insensitively', () => {
    const storyOnly = { off: [], issueTypes: ['story'] };
    const loose: StoryIssueLabel = { ...label, criteria: [crit(1), crit(2, { testable: false, reason: 'vague' })] };
    expect(ids(base({ label: loose, issueType: 'Bug' }), storyOnly)).toEqual([]);
    expect(gaps(base({ label, issueType: 'Bug' }), storyOnly)).toEqual([]);
    expect(ids(base({ label: loose, issueType: 'Story' }), storyOnly)).toEqual(['unclear_done']);
    expect(gaps(base({ label, issueType: null }), storyOnly)).toEqual(['No rule for duplicate baskets']);
  });
});
