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
  sprintCommentMarkdown,
  sprintCurrentAssessmentBodyOf,
  sprintSpecGapLines,
  type SprintChecks,
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
  assessmentProgressPct,
  elapsedLabel,
  changedCheckCount,
  checkTypeChoices,
  toggleCheckType,
  reviewRuleSentence,
  canMoveInSections,
  codingBoundsOf,
  moveInSections,
  moveStatusTo,
  statusDraftChanged,
  statusPlaceOf,
  newWriteRequestId,
  shareWords,
  sprintSections,
  statusEvidenceLine,
  statusOrderSourceLabel,
  statusSectionsOf,
  statusSettingsToSave,
  proposedCriteriaDraft,
  replaceCriteriaSection,
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
    repos: { accepted: [], suggested: [], defaulted: false },
    assessment: null,
    replaceTarget: { kind: 'description' },
    replaceBases: { description: { hash: '0'.repeat(64), truncated: false }, acceptanceCriteria: null },
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
  findings: [{ issue: 'unclear_done', rule: 'no_expected_result', quote: null, where: null, text: 'Say the export is CSV only.', suggestion: null, ref: null }],
  revisedCriteria: ['old one', 'new two', 'added'],
  revisedDescription: null,
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
      { name: 'In Development', category: 'indeterminate', count: 2, auto: true, stage: 'in_progress' },
      { name: 'Ready for QA', category: 'indeterminate', count: 1, auto: true, stage: 'in_review' },
      { name: 'In PO Review', category: 'indeterminate', count: 1, auto: true, stage: 'in_review' },
      { name: 'Done', category: 'done', count: 0, auto: true, stage: 'done' },
    ],
    orderSource: 'jira_board',
    codingBegins: 'In Development',
    codingEnds: 'Ready for QA',
    evidence: [
      { status: 'In Development', withPrs: 9, allMerged: 2 },
      { status: 'Ready for QA', withPrs: 6, allMerged: 4 },
      { status: 'In PO Review', withPrs: 11, allMerged: 11 },
    ],
    settings: { sections: null },
    ...over,
  };
}

const st = (name: string, category: 'new' | 'indeterminate' | 'done' = 'indeterminate') => ({ name, category });

describe('sections by status', () => {
  it('the four stages in order — sections in layout order, server order within; Done listed', () => {
    const rows = [
      ticket({ ident: 'a', stage: 'in_review', status: st('Ready for QA') }),
      ticket({ ident: 'b', stage: 'not_started', status: st('To Do', 'new') }),
      ticket({ ident: 'c', stage: 'in_progress', status: st('In Development') }),
      ticket({ ident: 'd', stage: 'in_review', status: st('In PO Review') }),
      ticket({ ident: 'e', stage: 'in_progress', status: st('in development') }),
      ticket({ ident: 'f', stage: 'done', status: st('Done', 'done') }),
    ];
    const g = sprintSections(rows, layout());
    expect(g.map((x) => [x.stage, x.heading])).toEqual([
      ['not_started', 'Not started'],
      ['in_progress', 'In progress'],
      ['in_review', 'In review'],
      ['done', 'Done'],
    ]);
    expect(g[0]!.sections).toEqual([{ status: null, tickets: [rows[1]] }]);
    expect(g[1]!.sections.map((s) => [s.status, s.tickets.map((t) => t.ident)])).toEqual([['In Development', ['c', 'e']]]);
    expect(g[2]!.sections.map((s) => s.status)).toEqual(['Ready for QA', 'In PO Review']);
    expect(g[3]!.sections.map((s) => s.tickets.map((t) => t.ident))).toEqual([['f']]);
  });

  it('empty stages dropped', () => {
    const rows = [ticket({ ident: 'a', stage: 'in_progress', status: st('In Development') })];
    expect(sprintSections(rows, layout()).map((x) => x.heading)).toEqual(['In progress']);
    expect(sprintSections([], layout())).toEqual([]);
  });

  it('a status the layout does not list goes after the listed ones', () => {
    const rows = [
      ticket({ ident: 'x', stage: 'in_review', status: st('Blocked by legal') }),
      ticket({ ident: 'y', stage: 'in_review', status: st('Ready for QA') }),
    ];
    expect(sprintSections(rows, layout())[0]!.sections.map((s) => s.status)).toEqual(['Ready for QA', 'Blocked by legal']);
    // No layout at all: grouping still works, by first seen.
    expect(sprintSections(rows, null)[0]!.sections.map((s) => s.status)).toEqual(['Blocked by legal', 'Ready for QA']);
  });

  it('the stage is the row\'s own (the server\'s placement)', () => {
    const g = sprintSections([ticket({ ident: 'n', stage: 'not_started', status: st('In PO Review') })], layout());
    expect(g.map((x) => x.stage)).toEqual(['not_started']);
  });
});

describe('status settings', () => {
  it('the draft is the layout’s placement', () => {
    expect(statusSectionsOf(layout())).toEqual({
      not_started: ['To Do'],
      in_progress: ['In Development'],
      in_review: ['Ready for QA', 'In PO Review'],
      done: ['Done'],
    });
  });

  it('move up / down within a stage, and across a stage boundary; the two ends are no-ops', () => {
    const d = statusSectionsOf(layout());
    expect(moveInSections(d, 'in_review', 1, -1).in_review).toEqual(['In PO Review', 'Ready for QA']);
    const up = moveInSections(d, 'in_review', 0, -1);
    expect([up.in_progress, up.in_review]).toEqual([['In Development', 'Ready for QA'], ['In PO Review']]);
    const down = moveInSections(d, 'in_progress', 0, 1);
    expect([down.in_progress, down.in_review]).toEqual([[], ['In Development', 'Ready for QA', 'In PO Review']]);
    expect(canMoveInSections(d, 'not_started', 0, -1)).toBe(false);
    expect(canMoveInSections(d, 'done', 0, 1)).toBe(false);
    expect(moveInSections(d, 'not_started', 0, -1)).toEqual(d);
    expect(canMoveInSections(d, 'done', 0, -1)).toBe(true);
  });

  it('drag: insert at a slot of any list — within a list, across stages, into an empty list', () => {
    const d = statusSectionsOf(layout());
    // Within a list: slot counted before the move.
    expect(moveStatusTo(d, { stage: 'in_review', index: 0 }, 'in_review', 2).in_review).toEqual(['In PO Review', 'Ready for QA']);
    expect(moveStatusTo(d, { stage: 'in_review', index: 1 }, 'in_review', 0).in_review).toEqual(['In PO Review', 'Ready for QA']);
    // The slots just above and below the row itself are no-ops.
    expect(moveStatusTo(d, { stage: 'in_review', index: 0 }, 'in_review', 0)).toEqual(d);
    expect(moveStatusTo(d, { stage: 'in_review', index: 0 }, 'in_review', 1)).toEqual(d);
    // Across stages, at any slot.
    const x = moveStatusTo(d, { stage: 'not_started', index: 0 }, 'in_review', 1);
    expect([x.not_started, x.in_review]).toEqual([[], ['Ready for QA', 'To Do', 'In PO Review']]);
    // Into an empty list.
    const y = moveStatusTo(x, { stage: 'done', index: 0 }, 'not_started', 0);
    expect([y.not_started, y.done]).toEqual([['Done'], []]);
    // Bad indexes leave it unchanged, and the input is never mutated.
    expect(moveStatusTo(d, { stage: 'done', index: 5 }, 'in_review', 0)).toEqual(d);
    expect(moveStatusTo(d, { stage: 'done', index: 0 }, 'in_review', 9)).toEqual(d);
    expect(d.in_review).toEqual(['Ready for QA', 'In PO Review']);
  });

  it('coding begins / ends read off the draft; where a status sits; changed or not', () => {
    const d = statusSectionsOf(layout());
    expect(codingBoundsOf(d)).toEqual({ begins: 'In Development', ends: 'Ready for QA' });
    const moved = moveStatusTo(d, { stage: 'in_progress', index: 0 }, 'in_review', 0);
    expect(codingBoundsOf(moved)).toEqual({ begins: null, ends: 'In Development' });
    expect(statusPlaceOf(moved, 'In PO Review')).toEqual({ stage: 'in_review', index: 2 });
    expect(statusPlaceOf(moved, 'Nope')).toBeNull();
    expect(statusDraftChanged(layout(), d)).toBe(false);
    expect(statusDraftChanged(layout(), moved)).toBe(true);
  });

  it('save payload: nothing moved → the stored override as it was; moved → every name per stage', () => {
    const l = layout();
    expect(statusSettingsToSave(l, statusSectionsOf(l))).toEqual({ sections: null });
    const moved = moveInSections(statusSectionsOf(l), 'in_review', 0, -1);
    expect(statusSettingsToSave(l, moved)).toEqual({ sections: moved });
  });

  it('save payload caps the names at the route’s limit', () => {
    const many = Array.from({ length: SPRINT_STATUS_ORDER_MAX + 1 }, (_, i) => `S${i}`);
    const l = layout({ order: many.map((name) => ({ name, category: 'indeterminate', count: 0, auto: true, stage: 'in_progress' })) });
    const out = statusSettingsToSave(l, moveInSections(statusSectionsOf(l), 'in_progress', 1, -1));
    const all = Object.values(out.sections ?? {}).flat();
    expect(all).toHaveLength(SPRINT_STATUS_ORDER_MAX);
    expect(all[0]).toBe('S1');
  });

  it('the source label keeps proper nouns mid-sentence', () => {
    expect(statusOrderSourceLabel('linear_states', { inSentence: true })).toBe('Linear’s workflow');
    expect(statusOrderSourceLabel('jira_board', { inSentence: true })).toBe('your board’s columns');
  });

  it('ⓘ words come from the shared constants', () => {
    expect(shareWords(0.6)).toBe('3 in 5');
    expect(shareWords(0.5)).toBe('1 in 2');
    expect(shareWords(0.37)).toBe('37%');
    expect(reviewRuleSentence()).toBe(
      'In review starts at a status whose name reads as review or QA, or the first in-progress status where at least 3 in 5 tickets with pull requests have them all merged, and at least 2 do.',
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
    // In the run's own mode.
    expect(assessmentProgressLine('running', 'reading', 'plan')).toBe('Reading the code to plan the work…');
    expect(assessmentProgressLine('running', 'reading', 'verify')).toBe('Checking each criterion against the code…');
    expect(assessmentProgressLine('running', 'writing', 'verify')).toBe('Writing up the check…');
  });

  it('progress bar: phase-based, monotone within a phase, never 100 while running', () => {
    const q = assessmentProgressPct('queued', null, 10_000);
    const c = assessmentProgressPct('running', 'checking_out', 10_000);
    const r0 = assessmentProgressPct('running', 'reading', 0);
    const r1 = assessmentProgressPct('running', 'reading', 60_000);
    const r2 = assessmentProgressPct('running', 'reading', 3_600_000);
    const w = assessmentProgressPct('running', 'writing', 0);
    expect(q).toBeLessThanOrEqual(5);
    expect(c).toBeGreaterThan(5);
    expect(c).toBeLessThanOrEqual(20);
    expect(r0).toBe(20);
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeLessThanOrEqual(85);
    expect(w).toBe(90);
    expect(elapsedLabel(45_400)).toBe('45s');
    expect(elapsedLabel(125_000)).toBe('2m 05s');
    expect(elapsedLabel(-5)).toBe('0s');
  });
});

/** The templated comment composition (shared folds) — what Copy all and the comment text are built from. */
const commentDefault = (t: SprintTicketRow, checks: SprintChecks): string =>
  sprintCommentMarkdown(sprintBullets(t, checks), sprintCurrentAssessmentBodyOf(t), sprintSpecGapLines(t, checks));

describe('update panel', () => {
  it('the dialog names the field and the ticket', () => {
    expect(writeTargetSentence('ACME-1', { kind: 'description' })).toBe('Replaces the description of ACME-1.');
    expect(writeTargetSentence('ACME-1', { kind: 'ac_field', fieldId: 'f', fieldName: 'AC' })).toBe('Replaces AC on ACME-1.');
  });

  it('"Apply to draft" for proposed criteria: the criteria field alone, else the description’s criteria section', () => {
    const t = ticket();
    expect(proposedCriteriaDraft({ description: t.description, criteria: '- old' }, ['new one', 'new two'])).toEqual({
      field: 'criteria',
      text: '- new one\n- new two',
    });
    expect(proposedCriteriaDraft({ description: t.description, criteria: null }, ['a'])).toEqual({
      field: 'description',
      text: 'Intro\n\n## Acceptance criteria\n\n- a\n\n## Notes\n\nKeep me',
    });
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

  it('the comment composition without an assessment: the templated bullets', () => {
    const t = ticket({ criteria: { items: [], source: 'none' }, issues: foldStoryIssues({ criteria: [], label: null }) });
    expect(commentDefault(t, SPRINT_CHECKS_DEFAULT)).toBe(
      '- Add acceptance criteria: outcomes a tester could check, one per line.',
    );
  });

  it('the comment composition from a succeeded assessment', () => {
    const t = withAssessment(ticket({ issues: [UNCLEAR] }), 'succeeded', 'current');
    expect(commentDefault(t, SPRINT_CHECKS_DEFAULT)).toBe(
      'Summary.\n\n- Say the export is CSV only.\n\n**Proposed acceptance criteria**\n\n- old one\n- new two\n- added',
    );
  });

  it('⚠ a stale run feeds nothing: no bullets of its own, no summary, no revised criteria', () => {
    // The author fixed the criterion since: code no longer raises unclear_done.
    const stale = withAssessment(ticket({ issues: [] }), 'succeeded', 'stale');
    expect(sprintBullets(stale, SPRINT_CHECKS_DEFAULT)).toEqual([]);
    expect(commentDefault(stale, SPRINT_CHECKS_DEFAULT)).toBe('');
    // Still raised by code: the TEMPLATED bullet, never the stale sentence.
    const still = withAssessment(ticket({ issues: [UNCLEAR] }), 'succeeded', 'stale');
    expect(sprintBullets(still, SPRINT_CHECKS_DEFAULT)).toEqual([
      { id: 'unclear_done', text: 'Criterion 2: no expected result', source: 'code', ref: null },
    ]);
    const old = withAssessment(ticket(), 'succeeded', 'stale', { outdated: true });
    expect(commentDefault(old, SPRINT_CHECKS_DEFAULT)).toBe('');
  });

  it("⚠ Claude's sentence only REPLACES a bullet for an issue code raised; it never adds one", () => {
    const body = { ...BODY, findings: [{ issue: 'blocked' as const, rule: 'waits_on_external' as const, quote: null, where: null, text: 'Waits on the billing API.', suggestion: null, ref: null }, ...BODY.findings] };
    const t = withAssessment(ticket({ issues: [UNCLEAR] }), 'succeeded', 'current', { body });
    expect(sprintBullets(t, SPRINT_CHECKS_DEFAULT)).toEqual([
      { id: 'unclear_done', text: 'Say the export is CSV only.', source: 'claude', ref: null },
    ]);
    // A ticket with no issues stays "Nothing flagged" when expanded, whatever Claude said.
    expect(sprintBullets(withAssessment(ticket({ issues: [] }), 'succeeded', 'current', { body }), SPRINT_CHECKS_DEFAULT)).toEqual([]);
  });

  it('spec gaps: their own section in the comment default, Claude’s current sentence replacing the first gap, never a bullet', () => {
    const body = { ...BODY, findings: [...BODY.findings, { issue: 'spec_gaps' as const, rule: 'edge_case' as const, quote: null, where: null, text: 'No limit on rows.', suggestion: null, ref: null }] };
    const gaps = [
      { type: 'edge_case' as const, text: 'No behaviour when the export is empty' },
      { type: 'rule' as const, text: 'No rule for duplicates' },
    ];
    const t = withAssessment(
      ticket({ issues: [UNCLEAR], specGaps: gaps }),
      'succeeded',
      'current',
      { body },
    );
    expect(sprintBullets(t, SPRINT_CHECKS_DEFAULT).map((b) => b.id)).toEqual(['unclear_done']);
    expect(commentDefault(t, SPRINT_CHECKS_DEFAULT)).toBe(
      'Summary.\n\n- Say the export is CSV only.\n\n**Spec gaps**\n\n- No limit on rows.\n\n**Proposed acceptance criteria**\n\n- old one\n- new two\n- added',
    );
    // Without a current run: the FIRST gap only.
    expect(commentDefault(ticket({ issues: [UNCLEAR], specGaps: gaps }), SPRINT_CHECKS_DEFAULT)).toContain(
      '**Spec gaps**\n\n- Edge case: No behaviour when the export is empty',
    );
    expect(commentDefault(ticket({ issues: [UNCLEAR], specGaps: gaps }), SPRINT_CHECKS_DEFAULT)).not.toContain('duplicates');
    // A ticket under way shows no spec gaps at all.
    expect(commentDefault({ ...t, stage: 'in_progress' }, SPRINT_CHECKS_DEFAULT)).not.toContain('Spec gaps');
    // The switch hides the section.
    expect(commentDefault(t, { off: ['spec_gaps'], issueTypes: [] })).not.toContain('Spec gaps');
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
