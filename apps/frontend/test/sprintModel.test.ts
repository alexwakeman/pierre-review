// Activity → This Sprint: the pure folds behind the tab (components/Activity/sprintModel.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sprintModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  SPRINT_STATUS_ORDER_MAX,
  type SprintAssessmentBody,
  type SprintAssessmentCurrency,
  type SprintAssessmentRecord,
  type SprintStatusLayout,
} from '@pierre-review/shared';
import {
  assessButtonLabel,
  assessmentProgressLine,
  assessmentProgressPct,
  elapsedLabel,
  reviewRuleSentence,
  canMoveInSections,
  codingBoundsOf,
  moveInSections,
  moveStatusTo,
  statusDraftChanged,
  statusPlaceOf,
  shareWords,
  statusEvidenceLine,
  statusOrderSourceLabel,
  statusSectionsOf,
  statusSettingsToSave,
} from '../src/components/Activity/sprintModel.js';
import { effectiveInsightsTab } from '../src/components/Activity/bottlenecksModel.js';
import { INSIGHTS_INNER_TABS, SPRINT_INNER_TABS } from '../src/store/filters.js';
import { effectiveSprintTab, SPRINT_RAIL_TABS } from '../src/components/Activity/sprintRailModel.js';

type Assessed = { assessment: { record: SprintAssessmentRecord; currency: SprintAssessmentCurrency } | null };

function ticket(): Assessed {
  return { assessment: null };
}

const BODY: SprintAssessmentBody = { mode: 'plan', summary: 'Summary.', plan: [], criterionChecks: [], coverage: null };

function withAssessment(
  t: Assessed,
  status: 'succeeded' | 'running' | 'failed',
  currency: 'current' | 'stale' | null,
  opts: { body?: SprintAssessmentBody; outdated?: boolean } = {},
): Assessed {
  return {
    ...t,
    assessment: {
      currency,
      record: {
        id: 9,
        workspaceId: 1,
        ident: 'jira:https://acme.atlassian.net#ACME-1',
        model: 'claude-sonnet-5',
        status,
        mode: 'plan',
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
  // The sprint graph LEFT Reports for the free This Sprint rail line: it is no Reports tab, and a stray
  // 'sprint' / 'merged' reaching the Reports derive is an unknown member (Overview). Legacy links are
  // mapped onto the rail line by useUrlState, never here.
  it('"sprint" and "merged" are no longer Reports tabs', () => {
    expect(INSIGHTS_INNER_TABS).not.toContain('sprint');
    expect(INSIGHTS_INNER_TABS).not.toContain('merged');
    expect(effectiveInsightsTab('sprint')).toBe('overview');
    expect(effectiveInsightsTab('merged')).toBe('overview');
  });

  it('This Sprint opens on the graph; "merged" is its second tab; anything else derives to the graph', () => {
    expect(SPRINT_INNER_TABS).toEqual(['graph', 'merged']);
    expect(SPRINT_RAIL_TABS.map((t) => t.label)).toEqual(['Sprint graph', 'Merged so far']);
    expect(effectiveSprintTab('merged')).toBe('merged');
    expect(effectiveSprintTab('graph')).toBe('graph');
    expect(effectiveSprintTab('nonsense')).toBe('graph');
    expect(effectiveSprintTab(null)).toBe('graph');
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
