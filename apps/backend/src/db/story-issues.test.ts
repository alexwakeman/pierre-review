import { describe, expect, it } from 'vitest';
import {
  STORY_ISSUES,
  applyStoryIssueChecks,
  foldStoryIssues,
  isBlockingRelation,
  isRealStoryBlocker,
  isStoryIssueId,
  joinCapped,
  parseTicketLinkBlockers,
  STORY_CHIP_ISSUE_IDS,
  storyBlockerPhrase,
  storyIssueBullet,
  storyIssueChipText,
  storyIssueMeasure,
  storyIssueRateUnits,
  storyIssueStates,
  storyIssueTypeChecked,
  storyUnclearCriteriaShown,
  storyReferencesByKey,
  type KnownTicket,
  type SprintAssessmentRecord,
  type StoryCriterionLabel,
  type StoryDependencyKind,
  type StoryIssueInput,
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
        dependencies: [{ kind: 'decision', what: 'pricing sign-off', owner: 'Payments team', ticketKey: null }],
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
      'Waits on pricing sign-off, Payments team, no ticket',
      'No behaviour when the upload fails',
    ]);
  });

  it('links come first and win a key collision; a done link is dropped, never raised', () => {
    const l = clean(2, { dependencies: [{ kind: 'ticket', what: 'banner', owner: 'UCD team', ticketKey: 'bmd-568' }] });
    const out = foldStoryIssues({
      criteria: items(2),
      label: l,
      links: [link('BMD-568', { title: 'cookie banner' }), link('BMD-12', { status: 'Done', category: 'done' })],
    });
    const blocked = out.find((i) => i.id === 'blocked')!;
    expect(blocked.reasons).toEqual(['linked']);
    expect(blocked.blockers.map((b) => [b.source, b.ticketKey, b.resolved])).toEqual([['link', 'BMD-568', false]]);
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

describe('the blocker rule (isRealStoryBlocker)', () => {
  const dep = (kind: StoryDependencyKind, ticketKey: string | null = null) => ({ kind, what: `${kind} thing`, owner: null, ticketKey });
  const fold = (deps: ReturnType<typeof dep>[], o: Partial<StoryIssueInput> = {}) =>
    foldStoryIssues({ criteria: items(2), label: clean(2, { dependencies: deps }), ...o }).find((i) => i.id === 'blocked');

  it('keeps an unfinished ticket and an open decision; drops inputs with no ticket', () => {
    const b = fold([dep('design'), dep('data'), dep('api'), dep('environment'), dep('other'), dep('decision'), dep('ticket', 'BMD-3')])!;
    expect(b.blockers.map((x) => [x.kind, x.ticketKey])).toEqual([
      ['decision', null],
      ['ticket', 'BMD-3'],
    ]);
    // Inputs alone are not a blocked issue at all — no chip, not counted.
    expect(fold([dep('design'), dep('data'), dep('other')])).toBeUndefined();
  });

  it('a text item of any kind that names a ticket is kept while the ticket is not done', () => {
    expect(fold([dep('design', 'UX-4')])!.blockers.map((x) => x.ticketKey)).toEqual(['UX-4']);
    const done = new Map<string, KnownTicket>([['UX-4', { title: 'Map design', status: 'Done', category: 'done', url: null }]]);
    expect(fold([dep('design', 'UX-4')], { knownTickets: done })).toBeUndefined();
  });

  it('an unknown status counts as not done and says "status unknown"', () => {
    const b = fold([], { links: [link('BMD-7', { title: null, status: null, category: null })] })!;
    expect(storyBlockerPhrase(b.blockers[0]!)).toBe('BMD-7 (status unknown)');
    expect(storyIssueBullet(fold([dep('ticket', 'BMD-8')])!)).toBe('Waits on BMD-8 ticket thing (status unknown)');
    expect(isRealStoryBlocker(b.blockers[0]!)).toBe(true);
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
    const textOnly = { criteria: items(2), label: clean(2, { dependencies: [{ kind: 'decision', what: 'pricing decision', owner: null, ticketKey: null }] }) };
    expect(storyIssueMeasure(textOnly).blocked).toBe(true);
    // An input (a design, data) is not a dependency, as written either.
    const input = { criteria: items(2), label: clean(2, { dependencies: [{ kind: 'design', what: 'Figma node', owner: null, ticketKey: null }] }) };
    expect(storyIssueMeasure(input).blocked).toBe(false);
    expect(storyIssueMeasure({ criteria: items(2), label: null, links: [link('X-1')] })).toEqual({ unclear_done: null, blocked: null, spec_gaps: null });
    // No criteria is never folded in: it can never be labelled.
    expect(storyIssueMeasure({ criteria: [], label: null }).unclear_done).toBeNull();
  });
});

describe('storyIssueRateUnits (the rate rule)', () => {
  it('unclear_done counts CRITERIA of a usable label; out without one or without criteria', () => {
    const label: StoryIssueLabel = {
      criteria: [
        { n: 1, testable: false, reason: 'vague' },
        { n: 2, testable: true, reason: null },
        { n: 3, testable: false, reason: 'no result' },
      ],
      story: { dependencies: [], gaps: [] },
    };
    expect(storyIssueRateUnits({ criteria: items(3), label }).unclear_done).toEqual({ num: 2, den: 3 });
    expect(storyIssueRateUnits({ criteria: items(3), label: clean(3) }).unclear_done).toEqual({ num: 0, den: 3 });
    expect(storyIssueRateUnits({ criteria: items(2), label }).unclear_done).toBeNull(); // count mismatch
    expect(storyIssueRateUnits({ criteria: [], label: null }).unclear_done).toBeNull();
  });
  it('blocked is CODE: a blocking link of any status counts, text-only does not, links not read is out', () => {
    expect(storyIssueRateUnits({ criteria: [], label: null, links: [link('A-1', { category: 'done' })] }).blocked).toEqual({ num: 1, den: 1 });
    expect(storyIssueRateUnits({ criteria: [], label: null, links: [] }).blocked).toEqual({ num: 0, den: 1 });
    const textOnly = clean(2, { dependencies: [{ kind: 'decision', what: 'pricing decision', owner: null, ticketKey: null }] });
    expect(storyIssueRateUnits({ criteria: items(2), label: textOnly, links: [] }).blocked).toEqual({ num: 0, den: 1 });
    expect(storyIssueRateUnits({ criteria: items(2), label: textOnly }).blocked).toBeNull();
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
  it('unclear when done lists the first two criteria, then "and N more"; the chip keeps the count', () => {
    const four = issue({
      id: 'unclear_done',
      total: 9,
      reasons: ['untestable'],
      criteria: [
        { n: 2, reason: 'vague' },
        { n: 4, reason: null },
        { n: 5, reason: 'no result' },
        { n: 8, reason: 'x' },
      ],
    });
    expect(storyIssueBullet(four)).toBe('Criterion 2: vague · Criterion 4: can’t be checked and 2 more');
    expect(storyUnclearCriteriaShown(four)).toEqual({ shown: four.criteria.slice(0, 2), more: 2 });
    expect(storyIssueChipText(four)).toBe('Unclear when done · 4 of 9 criteria');
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

describe('spec gaps leave the chips', () => {
  it('only unclear_done and blocked are chips', () => {
    expect(STORY_CHIP_ISSUE_IDS).toEqual(['unclear_done', 'blocked']);
  });
});

describe('rubric 4: only a depends_on reference can block', () => {
  const dep = (ticketKey: string) => ({ kind: 'ticket' as StoryDependencyKind, what: ticketKey, owner: null, ticketKey });
  const ref = (ticketKey: string, relation: 'depends_on' | 'concurrent' | 'builds_on' | 'supersedes' | 'out_of_scope' | 'context') => ({
    ticketKey,
    relation,
    quote: null,
    owner: null,
  });
  const known = new Map<string, KnownTicket>([
    ['ABC-343', { title: 'Upload page', status: 'Done', category: 'done', url: null }],
    ['ABC-1066', { title: 'Lost habitats', status: 'In Development', category: 'indeterminate', url: null }],
    ['ABC-20', { title: 'Endpoint', status: 'Done', category: 'done', url: null }],
  ]);
  const input = (story: Partial<StoryIssueLabel['story']>): StoryIssueInput => ({
    criteria: items(1),
    label: clean(1, story),
    links: null,
    knownTickets: known,
  });

  it('out of scope, build alongside, builds on, supersedes and context never block; depends_on does, unknown status included', () => {
    const issues = foldStoryIssues(
      input({
        // The old rubric's habit: every named ticket listed as a dependency.
        dependencies: [dep('ABC-1066'), dep('ABC-343'), dep('ABC-850'), dep('ABC-12')],
        references: [
          ref('ABC-1066', 'out_of_scope'),
          ref('ABC-1066', 'concurrent'),
          ref('ABC-343', 'builds_on'),
          ref('ABC-850', 'supersedes'),
          ref('ABC-12', 'depends_on'),
          ref('ABC-20', 'depends_on'),
          ref('ABC-30', 'context'),
        ],
      }),
    );
    const blocked = issues.find((i) => i.id === 'blocked')!;
    expect(blocked.blockers.map((b) => [b.ticketKey, b.status])).toEqual([['ABC-12', null]]);
    expect(storyIssueBullet(blocked)).toBe('Waits on ABC-12 (status unknown)');
  });

  it('a depends_on reference the dependencies forgot still blocks; a done one is resolved', () => {
    const issues = foldStoryIssues(input({ references: [ref('ABC-1066', 'depends_on'), ref('ABC-20', 'depends_on')] }));
    expect(issues.find((i) => i.id === 'blocked')!.blockers.map((b) => [b.ticketKey, b.what, b.status])).toEqual([
      ['ABC-1066', 'Lost habitats', 'In Development'],
    ]);
  });

  it('nothing blocks when every reference is something else', () => {
    const issues = foldStoryIssues(input({ dependencies: [dep('ABC-1066')], references: [ref('ABC-1066', 'concurrent')] }));
    expect(issues.some((i) => i.id === 'blocked')).toBe(false);
  });

  it('a tracker link still blocks whatever the text says', () => {
    const issues = foldStoryIssues({ ...input({ references: [ref('ABC-5', 'out_of_scope')] }), links: [link('ABC-5')] });
    expect(issues.find((i) => i.id === 'blocked')!.blockers.map((b) => [b.source, b.ticketKey])).toEqual([['link', 'ABC-5']]);
  });

  it('one relation per key: depends_on, then concurrent, … win', () => {
    const m = storyReferencesByKey([ref('abc-1', 'out_of_scope'), ref('ABC-1', 'concurrent'), ref('ABC-2', 'context'), ref('ABC-2', 'depends_on')]);
    expect([...m].map(([k, r]) => [k, r.relation])).toEqual([
      ['ABC-1', 'concurrent'],
      ['ABC-2', 'depends_on'],
    ]);
  });
});
