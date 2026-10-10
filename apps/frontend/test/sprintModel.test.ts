// Reports → This sprint: the pure folds behind the tab (components/Activity/sprintModel.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sprintModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  SPRINT_WRITE_MAYBE_SENTENCE,
  SPRINT_WRITE_REQUEST_ID_RE,
  SPRINT_WRITE_TEXT_MAX,
  sprintChipFix,
  sprintNoWriteSentence,
  type SprintAssessmentBody,
  type SprintTicketRow,
  type SprintWriteRecord,
} from '@pierre-review/shared';
import {
  assessButtonLabel,
  assessmentProgressLine,
  currentTextFor,
  groupSprintTickets,
  newWriteRequestId,
  proposedDefault,
  replaceCriteriaSection,
  replaceModeLabel,
  splitChips,
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
    chips: [],
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

const BODY: SprintAssessmentBody = {
  criteria: [],
  gaps: { unnamedDependencies: [], unstatedBehaviourChanges: [], dataOrMigrationImpact: [], edgeCases: [] },
  suggestion: {
    rewrittenCriteria: [{ n: 2, text: 'new two' }],
    addedCriteria: ['added'],
    split: null,
    questionsForOwner: ['Why?'],
    summary: 'Summary.',
  },
};

function withAssessment(t: SprintTicketRow, status: 'succeeded' | 'running' | 'failed', currency: 'current' | 'stale' | null): SprintTicketRow {
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
        body: status === 'succeeded' ? BODY : null,
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

  it('splits code chips from label chips', () => {
    const s = splitChips([
      { id: 'criterion_bundled', criterion: { n: 1, text: 'x' }, fix: '' },
      { id: 'no_criteria', criterion: null, fix: '' },
    ]);
    expect(s.code.map((c) => c.id)).toEqual(['no_criteria']);
    expect(s.label.map((c) => c.id)).toEqual(['criterion_bundled']);
  });
});

describe('assessment button and progress', () => {
  it('Assess / Re-assess / nothing', () => {
    expect(assessButtonLabel(ticket())).toBe('Assess with code');
    expect(assessButtonLabel(withAssessment(ticket(), 'succeeded', 'current'))).toBeNull();
    expect(assessButtonLabel(withAssessment(ticket(), 'succeeded', 'stale'))).toBe('Re-assess');
    expect(assessButtonLabel(withAssessment(ticket(), 'running', null))).toBeNull();
    expect(assessButtonLabel(withAssessment(ticket(), 'failed', null))).toBe('Assess with code');
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

  it('proposed defaults: chip fixes / current text without an assessment', () => {
    const t = ticket({ chips: [{ id: 'no_criteria', criterion: null, fix: sprintChipFix('no_criteria', null) }] });
    expect(proposedDefault(t, 'comment')).toContain('**No criteria**');
    expect(proposedDefault(t, 'replace')).toBe(t.description);
  });

  it('proposed defaults from a succeeded assessment', () => {
    const t = withAssessment(ticket(), 'succeeded', 'current');
    const comment = proposedDefault(t, 'comment');
    expect(comment).toContain('Summary.');
    expect(comment).toContain('- old one\n- new two\n- added');
    expect(comment).toContain('**Questions for the owner**');
    // description target: only the criteria section changes
    expect(proposedDefault(t, 'replace')).toBe('Intro\n\n## Acceptance criteria\n\n- old one\n- new two\n- added\n\n## Notes\n\nKeep me');
    // AC field target: just the list
    const ac = withAssessment(
      ticket({ acceptanceCriteria: '- old one\n- old two', replaceTarget: { kind: 'ac_field', fieldId: 'f', fieldName: 'AC' } }),
      'succeeded',
      'current',
    );
    expect(proposedDefault(ac, 'replace')).toBe('- old one\n- new two\n- added');
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
