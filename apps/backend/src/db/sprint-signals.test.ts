import { describe, expect, it } from 'vitest';
import { SPRINT_VISIT_GAP_MS, type SprintGraphEdge, type SprintGraphNode, type SprintGraphPr, type SprintStage } from '@pierre-review/shared';
import {
  blockedOutsideSignal,
  outOfStepSignal,
  paceSignal,
  parseSprintViewSnapshot,
  rollSprintViewSlots,
  sinceLastLookedSignal,
  sinceTitle,
  sprintViewSnapshotOf,
} from './sprint-signals.js';

// The strip's CODE cards (db/sprint-signals.ts): every fold, its empty case, and the visit-gap roll of
// the "since you last looked" baseline. Pure — no DB.

const pr = (prId: number, state: SprintGraphPr['state'], draft = false): SprintGraphPr => ({
  prId,
  number: prId,
  repoFullName: 'o/r',
  title: 't',
  state,
  draft,
  ciState: null,
  url: 'u',
  author: null,
});
const N = (key: string, stage: SprintStage | null, o: Partial<SprintGraphNode> = {}): SprintGraphNode => ({
  ident: `jira:x#${key}`,
  key,
  title: `Title of ${key}`,
  url: null,
  provider: 'jira',
  ghost: false,
  depth: 0,
  status: null,
  stage,
  issueType: null,
  assignee: null,
  epic: null,
  brief: { state: 'current', summary: null, criteriaCount: 0, criteriaDerived: false },
  prs: [],
  degree: 0,
  theme: null,
  ...o,
});
const I = (k: string) => `jira:x#${k}`;
const dep = (from: string, to: string, kind: SprintGraphEdge['kind'] = 'depends_on'): SprintGraphEdge =>
  ({ from: I(from), to: I(to), kind, source: 'tracker', quote: null }) as SprintGraphEdge;

describe('out of step', () => {
  it('in review with no open PR (merged code said apart), complete with one open, not started with one open (draft said apart)', () => {
    const s = outOfStepSignal([
      N('A-1', 'in_review'),
      N('A-2', 'in_review', { prs: [pr(1, 'merged')] }),
      N('A-3', 'done', { prs: [pr(2, 'open')] }),
      N('A-4', 'not_started', { prs: [pr(3, 'open')] }),
      N('A-5', 'not_started', { prs: [pr(4, 'open', true)] }),
      // In step: in review with an open PR, done with only merged ones, in progress anything.
      N('A-6', 'in_review', { prs: [pr(5, 'open')] }),
      N('A-7', 'done', { prs: [pr(6, 'merged')] }),
      N('A-8', 'in_progress'),
      // A ghost is never the sprint's.
      N('Z-1', 'in_review', { ghost: true }),
    ]);
    expect(s).toEqual({
      kind: 'out_of_step',
      title: 'Tracker and code disagree',
      sentence:
        '5 tickets: 1 in review with no pull request, 1 in review with its code already merged, 1 complete with a pull request still open, 1 not started with a pull request open, 1 not started with a draft pull request open.',
      idents: [I('A-1'), I('A-2'), I('A-3'), I('A-4'), I('A-5')],
    });
    expect(outOfStepSignal([N('A-1', 'done', { prs: [pr(1, 'open')] })])?.sentence).toBe('1 ticket: 1 complete with a pull request still open.');
    expect(outOfStepSignal([N('A-1', 'in_review', { prs: [pr(1, 'merged')] }), N('A-2', 'in_review', { prs: [pr(2, 'merged'), pr(3, 'closed')] })])?.sentence).toBe(
      '2 tickets: 2 in review with their code already merged.',
    );
  });
  it('none → no card', () => {
    expect(outOfStepSignal([N('A-1', 'in_progress'), N('A-2', 'done')])).toBeNull();
    expect(outOfStepSignal([])).toBeNull();
  });
});

describe('pace', () => {
  const ns = [N('A-1', 'done'), N('A-2', 'done'), N('A-3', 'in_progress'), N('A-4', 'not_started'), N('Z-1', 'in_progress', { ghost: true })];
  it('days gone beside tickets complete; idents = the unfinished sprint tickets', () => {
    expect(paceSignal(ns, { day: 9, days: 14, daysLeft: 5 })).toEqual({
      kind: 'pace',
      title: 'Day 9 of 14',
      sentence: "64% of the sprint's time has gone and 50% of its tickets are complete (2 of 4).",
      idents: [I('A-3'), I('A-4')],
    });
  });
  it('no sprint dates or no sprint ticket → no card', () => {
    expect(paceSignal(ns, null)).toBeNull();
    expect(paceSignal([N('Z-1', 'done', { ghost: true })], { day: 1, days: 14, daysLeft: 13 })).toBeNull();
  });
});

describe('blocked outside the sprint', () => {
  it('unfinished sprint tickets on an unfinished ghost; how many of those have not started', () => {
    const ns = [
      N('A-1', 'in_progress'),
      N('A-2', 'not_started'),
      N('A-3', 'done'),
      N('A-4', 'in_progress'),
      N('Z-1', 'not_started', { ghost: true }),
      N('Z-2', 'in_review', { ghost: true }),
      N('Z-3', 'done', { ghost: true }),
      N('Z-4', null, { ghost: true }),
    ];
    const edges = [
      dep('A-1', 'Z-1'),
      dep('A-2', 'Z-2'),
      dep('A-2', 'Z-1'),
      dep('A-3', 'Z-1'), // a done sprint ticket waits on nothing
      dep('A-4', 'Z-3'), // a done ghost blocks nothing
      dep('A-4', 'A-1'), // inside the sprint: the model's risk, not this card
      dep('A-1', 'Z-4', 'concurrent'), // not a dependency
    ];
    expect(blockedOutsideSignal(ns, edges)).toEqual({
      kind: 'blocked_outside',
      title: '2 tickets waiting',
      sentence: '2 sprint tickets wait on 2 tickets outside the sprint that are not complete; 1 of them has not started.',
      idents: [I('A-1'), I('A-2'), I('Z-1'), I('Z-2')],
    });
    // Status unknown counts as not complete; one outside ticket reads "it".
    expect(blockedOutsideSignal(ns, [dep('A-1', 'Z-4')])?.sentence).toBe('1 sprint ticket waits on 1 ticket outside the sprint that is not complete; it has started.');
    expect(blockedOutsideSignal(ns, [dep('A-1', 'Z-1')])?.sentence).toBe('1 sprint ticket waits on 1 ticket outside the sprint that is not complete; it has not started.');
    expect(blockedOutsideSignal(ns, [dep('A-1', 'Z-2'), dep('A-2', 'Z-4')])?.sentence).toBe(
      '2 sprint tickets wait on 2 tickets outside the sprint that are not complete; all of them have started.',
    );
  });
  it('none → no card', () => {
    expect(blockedOutsideSignal([N('A-1', 'in_progress'), N('Z-1', 'done', { ghost: true })], [dep('A-1', 'Z-1')])).toBeNull();
    expect(blockedOutsideSignal([N('A-1', 'in_progress')], [])).toBeNull();
  });
});

describe('since you last looked', () => {
  const T = Date.parse('2026-10-14T12:00:00Z');
  const then = [N('A-1', 'not_started'), N('A-2', 'in_progress', { prs: [pr(7, 'open')] }), N('A-3', 'in_review', { prs: [pr(8, 'merged')] }), N('A-4', 'in_review')];
  const base = sprintViewSnapshotOf([...then, N('Z-1', 'done', { ghost: true })]);

  it('the snapshot: sprint tickets only, merged PR ids', () => {
    expect(base).toEqual({ v: 1, stages: { [I('A-1')]: 'not_started', [I('A-2')]: 'in_progress', [I('A-3')]: 'in_review', [I('A-4')]: 'in_review' }, merged: [8] });
    expect(parseSprintViewSnapshot(JSON.parse(JSON.stringify(base)))).toEqual(base);
    expect(parseSprintViewSnapshot({ stages: { x: 'weird' }, merged: [1, 'a'] })).toEqual({ v: 1, stages: { x: null }, merged: [1] });
    expect(parseSprintViewSnapshot(null)).toBeNull();
    expect(parseSprintViewSnapshot({ stages: [] , merged: [] })).toBeNull();
  });

  it('stage moves (grouped, Complete first), tickets added, pull requests merged', () => {
    const now = [
      N('A-1', 'in_review'),
      N('A-2', 'done', { prs: [pr(7, 'merged')] }),
      N('A-3', 'done', { prs: [pr(8, 'merged')] }),
      N('A-4', 'in_review'),
      N('A-5', 'not_started'),
      N('A-6', 'not_started', { prs: [pr(9, 'merged'), pr(10, 'merged')] }),
    ];
    expect(sinceLastLookedSignal(base, new Date(T), now, T + 3 * 3_600_000)).toEqual({
      kind: 'since_last',
      title: 'Since 3 hours ago',
      sentence: '2 tickets moved to Complete, 1 to In review; 2 tickets added to the sprint; 3 pull requests merged.',
      idents: [I('A-2'), I('A-3'), I('A-1'), I('A-5'), I('A-6')],
    });
  });

  it('no card: no baseline, nothing moved, or a new sprint (no ticket in common)', () => {
    expect(sinceLastLookedSignal(null, null, then, T)).toBeNull();
    expect(sinceLastLookedSignal(base, new Date(T), then, T + 60_000)).toBeNull();
    expect(sinceLastLookedSignal(base, new Date(T), [N('B-1', 'done'), N('B-2', 'not_started')], T + 60_000)).toBeNull();
    // A status that became unknown is not a move.
    expect(sinceLastLookedSignal(base, new Date(T), then.map((n) => (n.key === 'A-1' ? { ...n, stage: null } : n)), T)).toBeNull();
  });

  it('⚠ the roll: CURRENT becomes the BASELINE only after a visit gap; refetches never erase the diff', () => {
    const s1 = sprintViewSnapshotOf(then);
    const first = rollSprintViewSlots(null, s1, T);
    expect(first).toEqual({ current: s1, currentAt: new Date(T), baseline: null, baselineAt: null });
    // Refetches inside the visit: CURRENT moves, there is still no baseline.
    const moved = sprintViewSnapshotOf(then.map((n) => (n.key === 'A-1' ? { ...n, stage: 'done' as const } : n)));
    const refetch = rollSprintViewSlots(first, moved, T + 5_000);
    expect(refetch.baseline).toBeNull();
    expect(refetch.currentAt).toEqual(new Date(T + 5_000));
    // Come back after the gap: the previous visit's LAST view is the baseline.
    const back = rollSprintViewSlots(refetch, moved, T + 5_000 + SPRINT_VISIT_GAP_MS);
    expect(back.baseline).toEqual(moved);
    expect(back.baselineAt).toEqual(new Date(T + 5_000));
    // Refetches during the new visit keep that baseline, whatever moves.
    const later = rollSprintViewSlots(back, s1, T + 5_000 + SPRINT_VISIT_GAP_MS + 10_000);
    expect(later.baseline).toEqual(moved);
    expect(later.baselineAt).toEqual(new Date(T + 5_000));
    expect(later.current).toEqual(s1);
    // Just under the gap is still the same visit.
    expect(rollSprintViewSlots(first, moved, T + SPRINT_VISIT_GAP_MS - 1).baseline).toBeNull();
  });

  it('sinceTitle', () => {
    expect(sinceTitle(T, T + 10_000)).toBe('Since 1 minute ago');
    expect(sinceTitle(T, T + 40 * 60_000)).toBe('Since 40 minutes ago');
    expect(sinceTitle(T, T + 3 * 3_600_000)).toBe('Since 3 hours ago');
    expect(sinceTitle(T, T + 26 * 3_600_000)).toBe('Since yesterday');
    expect(sinceTitle(T, T + 4 * 86_400_000)).toBe('Since 4 days ago');
  });
});
