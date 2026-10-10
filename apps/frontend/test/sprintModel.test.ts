// Reports → This sprint: the pure folds behind the tab (components/Activity/sprintModel.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sprintModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  SPRINT_WRITE_MAYBE_SENTENCE,
  SPRINT_WRITE_REQUEST_ID_RE,
  SPRINT_WRITE_TEXT_MAX,
  SPRINT_CHECKS_DEFAULT,
  foldStoryIssues,
  sprintBullets,
  sprintNoWriteSentence,
  type StoryIssue,
  type SprintAssessmentBody,
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
  groupSprintTickets,
  newWriteRequestId,
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

const SCOPE: StoryIssue = { id: 'scope_unstated', criteria: [], total: 2, reasons: ['no_out_of_scope'] };

const BODY: SprintAssessmentBody = {
  summary: 'Summary.',
  issues: [{ id: 'scope_unstated', text: 'Say the export is CSV only.', ref: null }],
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

describe('grouping keeps the server order', () => {
  it('Not started then In progress; order within kept; empty groups dropped', () => {
    const a = ticket({ ident: 'a', phase: 'in_progress' });
    const b = ticket({ ident: 'b', phase: 'not_started' });
    const c = ticket({ ident: 'c', phase: 'in_progress' });
    const g = groupSprintTickets([a, b, c]);
    expect(g.map((x) => x.phase)).toEqual(['not_started', 'in_progress']);
    expect(g[1]!.tickets.map((t) => t.ident)).toEqual(['a', 'c']);
    expect(groupSprintTickets([a]).map((x) => x.phase)).toEqual(['in_progress']);
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
    const t = withAssessment(ticket({ issues: [SCOPE] }), 'succeeded', 'current');
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
    // The author added an "Out of scope" line since: code no longer raises scope_unstated.
    const stale = withAssessment(ticket({ issues: [] }), 'succeeded', 'stale');
    expect(sprintBullets(stale, SPRINT_CHECKS_DEFAULT)).toEqual([]);
    expect(proposedDefault(stale, 'comment', SPRINT_CHECKS_DEFAULT)).toBe('');
    expect(proposedDefault(stale, 'replace', SPRINT_CHECKS_DEFAULT)).toBe(stale.description);
    // Still raised by code: the TEMPLATED bullet, never the stale sentence.
    const still = withAssessment(ticket({ issues: [SCOPE] }), 'succeeded', 'stale');
    expect(sprintBullets(still, SPRINT_CHECKS_DEFAULT)).toEqual([
      { id: 'scope_unstated', text: 'Add an “Out of scope” line saying what this story will not do.', source: 'code', ref: null },
    ]);
    const old = withAssessment(ticket(), 'succeeded', 'stale', { outdated: true });
    expect(proposedDefault(old, 'comment', SPRINT_CHECKS_DEFAULT)).toBe('');
    expect(proposedDefault(old, 'replace', SPRINT_CHECKS_DEFAULT)).toBe(old.description);
  });

  it("⚠ Claude's sentence only REPLACES a bullet for an issue code raised; it never adds one", () => {
    const body = { ...BODY, issues: [{ id: 'waits_on_work' as const, text: 'Waits on the billing API.', ref: null }, ...BODY.issues] };
    const t = withAssessment(ticket({ issues: [SCOPE] }), 'succeeded', 'current', { body });
    expect(sprintBullets(t, SPRINT_CHECKS_DEFAULT)).toEqual([
      { id: 'scope_unstated', text: 'Say the export is CSV only.', source: 'claude', ref: null },
    ]);
    // A ticket with no issues stays "Nothing flagged" when expanded, whatever Claude said.
    expect(sprintBullets(withAssessment(ticket({ issues: [] }), 'succeeded', 'current', { body }), SPRINT_CHECKS_DEFAULT)).toEqual([]);
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
    expect(changedCheckCount({ off: ['too_big'], issueTypes: [] })).toBe(1);
    expect(changedCheckCount({ off: ['too_big', 'scope_unstated'], issueTypes: ['Story', 'Bug'] })).toBe(3);
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
