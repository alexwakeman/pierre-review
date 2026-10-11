// Reports → This sprint: the pure folds behind the tab (components/Activity/sprintModel.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sprintModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  SPRINT_WRITE_MAYBE_SENTENCE,
  SPRINT_WRITE_REQUEST_ID_RE,
  SPRINT_WRITE_TEXT_MAX,
  SPRINT_CHECKS_DEFAULT,
  SPRINT_STATUS_ORDER_MAX,
  foldStoryIssues,
  sprintBullets,
  sprintNoWriteSentence,
  type StoryIssue,
  type SprintAssessmentBody,
  type SprintStatusLayout,
  type SprintTicketRow,
  type SprintWriteRecord,
} from '@pierre-review/shared';
import {
  assessButtonLabel,
  assessmentProgressLine,
  changedCheckCount,
  checkTypeChoices,
  toggleCheckType,
  currentTextFor,
  deliveredRuleSentence,
  canMoveStatus,
  moveStatus,
  newWriteRequestId,
  shareWords,
  sprintSections,
  statusEvidenceLine,
  statusOrderSourceLabel,
  statusSettingsToSave,
  statusSplittable,
  proposedDefault,
  replaceCriteriaSection,
  replaceModeLabel,
  writeRecordLine,
  writeTargetSentence,
  writeTextProblem,
} from '../src/components/Activity/sprintModel.js';
import { effectiveInsightsTab } from '../src/components/Activity/bottlenecksModel.js';
import { INSIGHTS_INNER_TABS } from '../src/store/filters.js';

function ticket(over: Partial<SprintTicketRow> = {}): SprintTicketRow {
  return {
    ident: 'jira:https://acme.atlassian.net#ACME-1',
    key: 'ACME-1',
    title: 'T',
    url: null,
    provider: 'jira',
    phase: 'not_started',
    stage: 'not_started',
    status: null,
    issueType: null,
    assignee: null,
    epic: null,
    description: 'Intro\n\n## Acceptance criteria\n\n- old one\n- old two\n\n## Notes\n\nKeep me',
    acceptanceCriteria: '',
    acField: null,
    criteria: { items: ['old one', 'old two'], source: 'description_heading' },
    labels: 'none',
    issues: [],
    specGaps: [],
    flagCount: 0,
    pullRequests: [],
    repos: { accepted: [], suggested: [] },
    assessment: null,
    replaceTarget: { kind: 'description' },
    replaceBase: { hash: '0'.repeat(64), truncated: false },
    lastWrite: null,
    ...over,
  };
}

const UNCLEAR: StoryIssue = {
  id: 'unclear_done',
  criteria: [{ n: 2, reason: 'no expected result' }],
  blockers: [],
  gaps: [],
  total: 2,
  reasons: ['untestable'],
};

const BODY: SprintAssessmentBody = {
  summary: 'Summary.',
  issues: [{ id: 'unclear_done', text: 'Say the export is CSV only.', ref: null }],
  revisedCriteria: ['old one', 'new two', 'added'],
};

function withAssessment(
  t: SprintTicketRow,
  status: 'succeeded' | 'running' | 'failed',
  currency: 'current' | 'stale' | null,
  opts: { body?: SprintAssessmentBody; outdated?: boolean } = {},
): SprintTicketRow {
  return {
    ...t,
    assessment: {
      currency,
      record: {
        id: 9,
        workspaceId: 1,
        ident: t.ident,
        model: 'claude-sonnet-5',
        status,
        phase: status === 'running' ? 'reading' : null,
        repos: [],
        body: status === 'succeeded' && opts.outdated !== true ? (opts.body ?? BODY) : null,
        outdated: status === 'succeeded' && opts.outdated === true,
        dropped: null,
        error: status === 'failed' ? 'failed' : null,
        costUsd: null,
        numTurns: null,
        createdAt: '2026-10-01T00:00:00Z',
        completedAt: null,
      },
    },
  };
}

describe('tab', () => {
  it('"sprint" is a Reports tab and survives the derive', () => {
    expect(INSIGHTS_INNER_TABS).toContain('sprint');
    expect(effectiveInsightsTab('sprint')).toBe('sprint');
  });
});

function layout(over: Partial<SprintStatusLayout> = {}): SprintStatusLayout {
  return {
    order: [
      { name: 'To Do', category: 'new', count: 1, auto: true, stage: 'not_started' },
      { name: 'In Development', category: 'indeterminate', count: 2, auto: true, stage: 'writing' },
      { name: 'Ready for QA', category: 'indeterminate', count: 1, auto: true, stage: 'writing' },
      { name: 'In PO Review', category: 'indeterminate', count: 1, auto: true, stage: 'delivered' },
      { name: 'Done', category: 'done', count: 0, auto: true, stage: 'done' },
    ],
    orderSource: 'jira_board',
    deliveredFrom: 'In PO Review',
    deliveredFromAuto: 'In PO Review',
    evidence: [
      { status: 'In Development', withPrs: 9, allMerged: 2 },
      { status: 'Ready for QA', withPrs: 6, allMerged: 4 },
      { status: 'In PO Review', withPrs: 11, allMerged: 11 },
    ],
    settings: { order: null, deliveredFrom: null },
    ...over,
  };
}

const st = (name: string, category: 'new' | 'indeterminate' | 'done' = 'indeterminate') => ({ name, category });

describe('sections by status', () => {
  it('Not started, Writing code, Code delivered — sections in layout order, server order within', () => {
    const rows = [
      ticket({ ident: 'a', stage: 'writing', status: st('Ready for QA') }),
      ticket({ ident: 'b', stage: 'not_started', status: st('To Do', 'new') }),
      ticket({ ident: 'c', stage: 'writing', status: st('In Development') }),
      ticket({ ident: 'd', stage: 'delivered', status: st('In PO Review') }),
      ticket({ ident: 'e', stage: 'writing', status: st('in development') }),
      ticket({ ident: 'f', stage: 'done', status: st('Done', 'done') }),
    ];
    const g = sprintSections(rows, layout());
    expect(g.map((x) => [x.stage, x.heading])).toEqual([
      ['not_started', 'Not started'],
      ['writing', 'Writing code'],
      ['delivered', 'Code delivered'],
    ]);
    expect(g[0]!.sections).toEqual([{ status: null, tickets: [rows[1]] }]);
    expect(g[1]!.sections.map((s) => [s.status, s.tickets.map((t) => t.ident)])).toEqual([
      ['In Development', ['c', 'e']],
      ['Ready for QA', ['a']],
    ]);
    expect(g[2]!.sections.map((s) => s.status)).toEqual(['In PO Review']);
    // Done is never listed.
    expect(g.flatMap((x) => x.sections.flatMap((s) => s.tickets)).some((t) => t.ident === 'f')).toBe(false);
  });

  it('nothing splits → one "In progress" heading; empty stages dropped', () => {
    const rows = [ticket({ ident: 'a', stage: 'writing', status: st('In Development') })];
    const g = sprintSections(rows, layout({ deliveredFrom: null }));
    expect(g.map((x) => x.heading)).toEqual(['In progress']);
    expect(sprintSections([], layout())).toEqual([]);
  });

  it('a status the layout does not list goes after the listed ones', () => {
    const rows = [
      ticket({ ident: 'x', stage: 'writing', status: st('Blocked by legal') }),
      ticket({ ident: 'y', stage: 'writing', status: st('Ready for QA') }),
    ];
    expect(sprintSections(rows, layout())[0]!.sections.map((s) => s.status)).toEqual(['Ready for QA', 'Blocked by legal']);
    // No layout at all: grouping still works, by first seen.
    expect(sprintSections(rows, null)[0]!.sections.map((s) => s.status)).toEqual(['Blocked by legal', 'Ready for QA']);
  });

  it('the stage is the row\'s own (category beats position is the server\'s rule)', () => {
    // A row the server put in Not started stays there whatever its status name is.
    const g = sprintSections([ticket({ ident: 'n', stage: 'not_started', status: st('In PO Review') })], layout());
    expect(g.map((x) => x.stage)).toEqual(['not_started']);
  });
});

describe('status settings', () => {
  it('only in-progress statuses can be the split', () => {
    expect(statusSplittable({ category: 'indeterminate' })).toBe(true);
    expect(statusSplittable({ category: null })).toBe(true);
    expect(statusSplittable({ category: 'new' })).toBe(false);
    expect(statusSplittable({ category: 'done' })).toBe(false);
  });

  it('move up / down, ends are no-ops', () => {
    expect(moveStatus(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveStatus(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveStatus(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveStatus(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('a move never crosses into another category (the server would snap it back)', () => {
    const cat: Record<string, string | null> = { 'To Do': 'new', Coding: 'indeterminate', Review: null, Done: 'done' };
    const of = (n: string) => cat[n] ?? null;
    const names = ['To Do', 'Coding', 'Review', 'Done'];
    expect(canMoveStatus(names, 0, 1, of)).toBe(false);
    expect(moveStatus(names, 0, 1, of)).toEqual(names);
    expect(moveStatus(names, 3, -1, of)).toEqual(names);
    expect(canMoveStatus(names, 1, 1, of)).toBe(true); // null category reads as in progress
    expect(moveStatus(names, 1, 1, of)).toEqual(['To Do', 'Review', 'Coding', 'Done']);
  });

  it('save payload caps the order at the route’s limit', () => {
    const many = Array.from({ length: SPRINT_STATUS_ORDER_MAX + 1 }, (_, i) => `S${i}`);
    const l = layout({ order: many.map((name) => ({ name, category: 'indeterminate', count: 0, auto: true, stage: 'writing' })) });
    const moved = moveStatus(many, 1, -1);
    const out = statusSettingsToSave(l, { order: moved, deliveredFrom: null, deliveredTouched: false });
    expect(out.order).toHaveLength(SPRINT_STATUS_ORDER_MAX);
    expect(out.order?.[0]).toBe('S1');
  });

  it('the source label keeps proper nouns mid-sentence', () => {
    expect(statusOrderSourceLabel('linear_states', { inSentence: true })).toBe('Linear’s workflow');
    expect(statusOrderSourceLabel('jira_board', { inSentence: true })).toBe('your board’s columns');
  });

  it('save payload: nothing moved → order null; untouched split → stored value', () => {
    const l = layout();
    const names = l.order.map((o) => o.name);
    expect(statusSettingsToSave(l, { order: names, deliveredFrom: 'In PO Review', deliveredTouched: false })).toEqual({
      order: null,
      deliveredFrom: null,
    });
  });

  it('save payload: moved → every name; picked → the name; picked the automatic answer → null', () => {
    const l = layout();
    const moved = moveStatus(l.order.map((o) => o.name), 2, -1);
    expect(statusSettingsToSave(l, { order: moved, deliveredFrom: 'Ready for QA', deliveredTouched: true })).toEqual({
      order: moved,
      deliveredFrom: 'Ready for QA',
    });
    expect(
      statusSettingsToSave(l, { order: l.order.map((o) => o.name), deliveredFrom: 'in po review', deliveredTouched: true }),
    ).toEqual({ order: null, deliveredFrom: null });
  });

  it('save payload keeps an existing override the reader did not touch', () => {
    const l = layout({
      orderSource: 'override',
      deliveredFrom: 'Ready for QA',
      settings: { order: ['To Do', 'In Development', 'Ready for QA', 'In PO Review', 'Done'], deliveredFrom: 'Ready for QA' },
    });
    expect(statusSettingsToSave(l, { order: l.order.map((o) => o.name), deliveredFrom: 'Ready for QA', deliveredTouched: false })).toEqual(
      l.settings,
    );
  });

  it('ⓘ words come from the shared constants', () => {
    expect(shareWords(0.6)).toBe('3 in 5');
    expect(shareWords(0.5)).toBe('1 in 2');
    expect(shareWords(0.37)).toBe('37%');
    expect(deliveredRuleSentence()).toBe(
      'The first in-progress status where at least 3 in 5 tickets with pull requests have them all merged, and at least 2 do.',
    );
    expect(statusEvidenceLine({ status: 'Ready for QA', withPrs: 6, allMerged: 4 })).toBe('Ready for QA · 4 of 6 merged');
    expect(statusOrderSourceLabel('jira_board')).toBe('Your board’s columns');
    expect(statusOrderSourceLabel('fallback')).toBe('Status category, then name');
  });
});

describe('assessment button and progress', () => {
  it('Check against code / Check again / nothing', () => {
    expect(assessButtonLabel(ticket())).toBe('Check against code');
    expect(assessButtonLabel(withAssessment(ticket(), 'succeeded', 'current'))).toBeNull();
    expect(assessButtonLabel(withAssessment(ticket(), 'succeeded', 'stale'))).toBe('Check again');
    expect(assessButtonLabel(withAssessment(ticket(), 'running', null))).toBeNull();
    expect(assessButtonLabel(withAssessment(ticket(), 'failed', null))).toBe('Check against code');
    // An old-format run is offered a fresh check, not "again".
    expect(assessButtonLabel(withAssessment(ticket(), 'succeeded', 'stale', { outdated: true }))).toBe('Check against code');
  });

  it('progress line per phase', () => {
    expect(assessmentProgressLine('queued', null)).toBe('Waiting for a free slot…');
    expect(assessmentProgressLine('running', 'checking_out')).toBe('Checking out the repos…');
    expect(assessmentProgressLine('running', 'reading')).toBe('Reading the code…');
    expect(assessmentProgressLine('running', 'writing')).toBe('Writing the assessment…');
  });
});

describe('update panel', () => {
  it('the current text follows the replace target', () => {
    const t = ticket({ acceptanceCriteria: 'AC' });
    expect(currentTextFor(t, { kind: 'description' })).toBe(t.description);
    expect(currentTextFor(t, { kind: 'ac_field', fieldId: 'f', fieldName: 'AC field' })).toBe('AC');
    expect(replaceModeLabel({ kind: 'ac_field', fieldId: 'f', fieldName: 'Acceptance Criteria' })).toBe('Replace Acceptance Criteria');
    expect(replaceModeLabel({ kind: 'description' })).toBe('Replace description');
  });

  it('the dialog names the target and the ticket', () => {
    expect(writeTargetSentence('ACME-1', 'comment', { kind: 'description' })).toBe('Adds a comment to ACME-1.');
    expect(writeTargetSentence('ACME-1', 'replace', { kind: 'description' })).toBe('Replaces the description of ACME-1.');
    expect(writeTargetSentence('ACME-1', 'replace', { kind: 'ac_field', fieldId: 'f', fieldName: 'AC' })).toBe('Replaces AC on ACME-1.');
  });

  it('replaces the criteria section and keeps the rest of the description', () => {
    const out = replaceCriteriaSection(ticket().description, '- a\n- b');
    expect(out).toBe('Intro\n\n## Acceptance criteria\n\n- a\n- b\n\n## Notes\n\nKeep me');
  });

  it('appends a section when the description has none', () => {
    expect(replaceCriteriaSection('Just text', '- a')).toBe('Just text\n\n## Acceptance criteria\n\n- a');
    expect(replaceCriteriaSection('', '- a')).toBe('## Acceptance criteria\n\n- a');
  });

  it('a bold label line counts as the heading', () => {
    expect(replaceCriteriaSection('**Acceptance criteria:**\n- x\n\nOther:\nmore', '- y')).toBe(
      '**Acceptance criteria:**\n\n- y\n\nOther:\nmore',
    );
  });

  it('proposed defaults without an assessment: the templated bullets / the current text', () => {
    const t = ticket({ criteria: { items: [], source: 'none' }, issues: foldStoryIssues({ criteria: [], label: null }) });
    expect(proposedDefault(t, 'comment', SPRINT_CHECKS_DEFAULT)).toBe(
      '- Add acceptance criteria: outcomes a tester could check, one per line.',
    );
    expect(proposedDefault(t, 'replace', SPRINT_CHECKS_DEFAULT)).toBe(t.description);
  });

  it('proposed defaults from a succeeded assessment', () => {
    const t = withAssessment(ticket({ issues: [UNCLEAR] }), 'succeeded', 'current');
    expect(proposedDefault(t, 'comment', SPRINT_CHECKS_DEFAULT)).toBe(
      'Summary.\n\n- Say the export is CSV only.\n\n**Proposed acceptance criteria**\n\n- old one\n- new two\n- added',
    );
    // description target: only the criteria section changes
    expect(proposedDefault(t, 'replace', SPRINT_CHECKS_DEFAULT)).toBe(
      'Intro\n\n## Acceptance criteria\n\n- old one\n- new two\n- added\n\n## Notes\n\nKeep me',
    );
    // AC field target: just the list
    const ac = withAssessment(
      ticket({ acceptanceCriteria: '- old one\n- old two', replaceTarget: { kind: 'ac_field', fieldId: 'f', fieldName: 'AC' } }),
      'succeeded',
      'current',
    );
    expect(proposedDefault(ac, 'replace', SPRINT_CHECKS_DEFAULT)).toBe('- old one\n- new two\n- added');
    // No revised criteria: Replace starts from the current text.
    const keep = withAssessment(ticket(), 'succeeded', 'current', { body: { ...BODY, revisedCriteria: [] } });
    expect(proposedDefault(keep, 'replace', SPRINT_CHECKS_DEFAULT)).toBe(keep.description);
  });

  it('⚠ a stale run feeds nothing: no bullets of its own, no summary, no revised criteria', () => {
    // The author fixed the criterion since: code no longer raises unclear_done.
    const stale = withAssessment(ticket({ issues: [] }), 'succeeded', 'stale');
    expect(sprintBullets(stale, SPRINT_CHECKS_DEFAULT)).toEqual([]);
    expect(proposedDefault(stale, 'comment', SPRINT_CHECKS_DEFAULT)).toBe('');
    expect(proposedDefault(stale, 'replace', SPRINT_CHECKS_DEFAULT)).toBe(stale.description);
    // Still raised by code: the TEMPLATED bullet, never the stale sentence.
    const still = withAssessment(ticket({ issues: [UNCLEAR] }), 'succeeded', 'stale');
    expect(sprintBullets(still, SPRINT_CHECKS_DEFAULT)).toEqual([
      { id: 'unclear_done', text: 'Criterion 2: no expected result', source: 'code', ref: null },
    ]);
    const old = withAssessment(ticket(), 'succeeded', 'stale', { outdated: true });
    expect(proposedDefault(old, 'comment', SPRINT_CHECKS_DEFAULT)).toBe('');
    expect(proposedDefault(old, 'replace', SPRINT_CHECKS_DEFAULT)).toBe(old.description);
  });

  it("⚠ Claude's sentence only REPLACES a bullet for an issue code raised; it never adds one", () => {
    const body = { ...BODY, issues: [{ id: 'blocked' as const, text: 'Waits on the billing API.', ref: null }, ...BODY.issues] };
    const t = withAssessment(ticket({ issues: [UNCLEAR] }), 'succeeded', 'current', { body });
    expect(sprintBullets(t, SPRINT_CHECKS_DEFAULT)).toEqual([
      { id: 'unclear_done', text: 'Say the export is CSV only.', source: 'claude', ref: null },
    ]);
    // A ticket with no issues stays "Nothing flagged" when expanded, whatever Claude said.
    expect(sprintBullets(withAssessment(ticket({ issues: [] }), 'succeeded', 'current', { body }), SPRINT_CHECKS_DEFAULT)).toEqual([]);
  });

  it('spec gaps: their own section in the comment default, Claude’s current sentence included, never a bullet', () => {
    const body = { ...BODY, issues: [...BODY.issues, { id: 'spec_gaps' as const, text: 'No limit on rows.', ref: null }] };
    const t = withAssessment(
      ticket({ issues: [UNCLEAR], specGaps: [{ type: 'edge_case', text: 'No behaviour when the export is empty' }] }),
      'succeeded',
      'current',
      { body },
    );
    expect(sprintBullets(t, SPRINT_CHECKS_DEFAULT).map((b) => b.id)).toEqual(['unclear_done']);
    expect(proposedDefault(t, 'comment', SPRINT_CHECKS_DEFAULT)).toBe(
      'Summary.\n\n- Say the export is CSV only.\n\n**Spec gaps**\n\n- Edge case: No behaviour when the export is empty\n- No limit on rows.\n\n**Proposed acceptance criteria**\n\n- old one\n- new two\n- added',
    );
    // The switch hides the section.
    expect(proposedDefault(t, 'comment', { off: ['spec_gaps'], issueTypes: [] })).not.toContain('Spec gaps');
  });

  it('text problems mirror the server cap', () => {
    expect(writeTextProblem('  ')).toBe('Nothing to write.');
    expect(writeTextProblem('ok')).toBeNull();
    expect(writeTextProblem('x'.repeat(SPRINT_WRITE_TEXT_MAX + 1))).toMatch(/^Too long/);
  });

  it('a request id matches the server pattern and is fresh', () => {
    const a = newWriteRequestId();
    const b = newWriteRequestId();
    expect(SPRINT_WRITE_REQUEST_ID_RE.test(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('write record lines', () => {
    const base: SprintWriteRecord = {
      id: 1,
      ident: 'x',
      mode: 'comment',
      target: null,
      status: 'written',
      error: null,
      message: null,
      url: null,
      createdAt: '2026-10-01T00:00:00Z',
      completedAt: '2026-10-01T00:00:01Z',
    };
    expect(writeRecordLine(base, 'jira')).toEqual({ tone: 'ok', text: 'Comment added in Jira.' });
    expect(writeRecordLine({ ...base, mode: 'replace' }, 'linear').text).toBe('Updated in Linear.');
    expect(writeRecordLine({ ...base, status: 'maybe_written', message: null }, 'jira')).toEqual({ tone: 'warn', text: SPRINT_WRITE_MAYBE_SENTENCE });
    expect(
      writeRecordLine({ ...base, status: 'failed', error: 'no_write_permission', message: sprintNoWriteSentence('github') }, 'github'),
    ).toEqual({ tone: 'bad', text: 'This token can’t write to GitHub.' });
    expect(writeRecordLine({ ...base, status: 'writing' }, 'jira').tone).toBe('busy');
  });
});

describe('checks', () => {
  it('counts each switched-off issue, plus one for a type list', () => {
    expect(changedCheckCount(SPRINT_CHECKS_DEFAULT)).toBe(0);
    expect(changedCheckCount({ off: ['blocked'], issueTypes: [] })).toBe(1);
    expect(changedCheckCount({ off: ['blocked', 'spec_gaps'], issueTypes: ['Story', 'Bug'] })).toBe(3);
  });

  it("type choices: the sprint's types plus saved ones, once each, sorted", () => {
    expect(checkTypeChoices(['Story', 'Bug'], ['story', 'Spike'])).toEqual(['Bug', 'Spike', 'Story']);
    expect(checkTypeChoices([], [])).toEqual([]);
  });

  it('toggling a type matches case-insensitively', () => {
    expect(toggleCheckType([], 'Story')).toEqual(['Story']);
    expect(toggleCheckType(['story', 'Bug'], 'Story')).toEqual(['Bug']);
  });
});
