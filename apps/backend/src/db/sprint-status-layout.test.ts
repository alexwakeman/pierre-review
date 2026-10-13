// Activity → This Sprint — the PURE status-layout fold (db/sprint-status-layout.ts). No database: the
// DB half imports db/client lazily, so importing this module opens nothing. Pinned:
//   • the automatic order: the tracker's order first, then statuses only the tickets carry, placed
//     by category; no tracker order → category then name;
//   • the automatic STAGE: new → Not started, done → Complete; a review / QA name → In review; the PR
//     evidence boundary (first in-progress status at ≥ 60% fully merged with ≥ 2 such tickets) and
//     every in-progress status after it → In review; the rest In progress;
//   • the override: placement beats category, unnamed statuses keep their automatic stage after their
//     automatic predecessor, a named status nobody has seen kept (count 0); a stored RETIRED
//     {order, deliveredFrom} value reads into the four sections;
//   • coding begins / ends; the stage of a ticket; the section index; the evidence fold (closed-
//     unmerged PRs ignored, the sprint ticket's status beats a stored row's, the freshest otherwise).
import { describe, expect, it } from 'vitest';
import { SPRINT_STATUS_SETTINGS_DEFAULT, type SprintStage, type SprintStatusAutoOrder } from '@pierre-review/shared';
import {
  applySectionsOverride,
  automaticStages,
  automaticStatusOrder,
  foldSprintStatusEvidence,
  inferReviewFrom,
  isReviewStatusName,
  resolveSprintStatusLayout,
  sprintStageOf,
  sprintStatusSectionIndex,
  storedSettingsFor,
} from './sprint-status-layout.js';

const BOARD: SprintStatusAutoOrder = {
  source: 'jira_board',
  readAt: '2026-10-10T00:00:00.000Z',
  statuses: [
    { id: '1', name: 'To Do', category: 'new' },
    { id: '3', name: 'In Development', category: 'indeterminate' },
    { id: '4', name: 'Ready for QA', category: 'indeterminate' },
    { id: '5', name: 'In PO Review', category: 'indeterminate' },
    { id: '6', name: 'Done', category: 'done' },
  ],
};
// A board whose names say nothing about review: only the PR evidence can split it.
const PLAIN: SprintStatusAutoOrder = {
  source: 'linear_states',
  readAt: '2026-10-10T00:00:00.000Z',
  statuses: [
    { id: '1', name: 'Todo', category: 'new' },
    { id: '2', name: 'Building', category: 'indeterminate' },
    { id: '3', name: 'Checking', category: 'indeterminate' },
    { id: '4', name: 'Polishing', category: 'indeterminate' },
    { id: '5', name: 'Shipped', category: 'done' },
  ],
};
const t = (statusName: string | null, statusCategory: string | null) => ({ statusName, statusCategory });
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);
const ev = (o: Record<string, [number, number]>) => new Map(Object.entries(o).map(([k, [w, m]]) => [k, { withPrs: w, allMerged: m }]));
const noSections = (): Record<SprintStage, string[]> => ({ not_started: [], in_progress: [], in_review: [], done: [] });

describe('automaticStatusOrder', () => {
  it('keeps the tracker order and places statuses only the tickets carry by category', () => {
    const o = automaticStatusOrder(BOARD, [t('Blocked', 'indeterminate'), t('Backlog', 'new'), t('Won’t do', 'done'), t('in development', 'indeterminate')]);
    expect(names(o)).toEqual(['To Do', 'Backlog', 'In Development', 'Ready for QA', 'In PO Review', 'Blocked', 'Done', 'Won’t do']);
  });

  it('no tracker order → category, then name', () => {
    const o = automaticStatusOrder(null, [t('Review', 'indeterminate'), t('Done', 'done'), t('Coding', 'indeterminate'), t('To Do', 'new'), t(null, null)]);
    expect(names(o)).toEqual(['To Do', 'Coding', 'Review', 'Done']);
  });
});

describe('isReviewStatusName', () => {
  it('reads real review / QA / release names as In review', () => {
    for (const n of [
      'Code Review',
      'In Review',
      'Ready for QA',
      'QA',
      'In QA',
      'In Test',
      'Testing',
      'Awaiting Deployment',
      'Ready to deploy',
      'UAT',
      'Verification',
      'Sign-off',
      'Signoff',
      'Staging',
      'Demo',
      'Release',
      'Acceptance',
      'In PO Review',
    ]) {
      expect([n, isReviewStatusName(n)]).toEqual([n, true]);
    }
  });

  it('leaves building statuses alone', () => {
    for (const n of ['In Development', 'In Progress', 'Doing', 'To Do', 'Blocked', 'Coding', 'Contested', 'Protest', 'Qualified']) {
      expect([n, isReviewStatusName(n)]).toEqual([n, false]);
    }
  });
});

describe('inferReviewFrom', () => {
  const order = automaticStatusOrder(BOARD, []);

  it('the first in-progress status at ≥ 60% with ≥ 2 fully merged (the dev data: Ready for QA 4/6)', () => {
    expect(inferReviewFrom(order, ev({ 'In Development': [9, 2], 'Ready for QA': [6, 4], 'In PO Review': [11, 11] }))).toBe('Ready for QA');
  });

  it('exactly 60% counts; 1 fully-merged ticket never does; matching is case-insensitive', () => {
    expect(inferReviewFrom(order, ev({ 'in development': [5, 3] }))).toBe('In Development');
    expect(inferReviewFrom(order, ev({ 'In Development': [1, 1], 'Ready for QA': [10, 5] }))).toBeNull();
  });

  it('new and done statuses never qualify', () => {
    expect(inferReviewFrom(order, ev({ 'To Do': [4, 4], Done: [8, 8] }))).toBeNull();
  });
});

describe('automaticStages', () => {
  it('category first, then the review vocabulary', () => {
    expect(automaticStages(automaticStatusOrder(BOARD, []), new Map())).toEqual(['not_started', 'in_progress', 'in_review', 'in_review', 'done']);
  });

  it('with neutral names, the PR evidence boundary and everything after it is In review', () => {
    const order = automaticStatusOrder(PLAIN, []);
    expect(automaticStages(order, new Map())).toEqual(['not_started', 'in_progress', 'in_progress', 'in_progress', 'done']);
    expect(automaticStages(order, ev({ Checking: [3, 3] }))).toEqual(['not_started', 'in_progress', 'in_review', 'in_review', 'done']);
  });
});

describe('applySectionsOverride', () => {
  const auto = automaticStatusOrder(BOARD, []);
  const staged = auto.map((s, i) => ({ ...s, stage: automaticStages(auto, new Map())[i]! }));

  it('null → the automatic placement, grouped by stage', () => {
    expect(applySectionsOverride(staged, null).map((s) => `${s.name}:${s.stage}:${s.auto ? 'auto' : 'set'}`)).toEqual([
      'To Do:not_started:auto',
      'In Development:in_progress:auto',
      'Ready for QA:in_review:auto',
      'In PO Review:in_review:auto',
      'Done:done:auto',
    ]);
  });

  it('placement beats category; unnamed statuses keep their automatic stage after their predecessor; unknown names kept', () => {
    const sections = { ...noSections(), in_progress: ['ready for qa'], in_review: ['Done', 'Parked'] };
    expect(applySectionsOverride(staged, sections).map((s) => `${s.name}:${s.stage}:${s.auto ? 'auto' : 'set'}`)).toEqual([
      'To Do:not_started:auto',
      'In Development:in_progress:auto',
      'Ready for QA:in_progress:set',
      'In PO Review:in_review:auto',
      'Done:in_review:set',
      'Parked:in_review:set',
    ]);
  });
});

describe('resolveSprintStatusLayout', () => {
  const tickets = [t('To Do', 'new'), t('In Development', 'indeterminate'), t('In Development', 'indeterminate'), t('In PO Review', 'indeterminate'), t('Done', 'done')];

  it('counts every ticket per status (done too), stages each status, names coding begins / ends', () => {
    const l = resolveSprintStatusLayout({ autoOrder: BOARD, settings: SPRINT_STATUS_SETTINGS_DEFAULT, tickets, evidence: ev({ 'In PO Review': [3, 3] }) });
    expect(l.orderSource).toBe('jira_board');
    expect(l.order.map((o) => `${o.name}:${o.count}:${o.stage}`)).toEqual([
      'To Do:1:not_started',
      'In Development:2:in_progress',
      'Ready for QA:0:in_review',
      'In PO Review:1:in_review',
      'Done:1:done',
    ]);
    expect([l.codingBegins, l.codingEnds]).toEqual(['In Development', 'Ready for QA']);
    expect(l.evidence.map((e) => `${e.status}:${e.allMerged}/${e.withPrs}`)).toEqual(['In Development:0/0', 'Ready for QA:0/0', 'In PO Review:3/3']);
  });

  it('an override is the source; an empty stage has no coding status', () => {
    const l = resolveSprintStatusLayout({
      autoOrder: BOARD,
      settings: { sections: { ...noSections(), in_progress: ['In PO Review', 'Ready for QA', 'In Development'] } },
      tickets,
      evidence: new Map(),
    });
    expect(l.orderSource).toBe('override');
    expect([l.codingBegins, l.codingEnds]).toEqual(['In PO Review', null]);
  });

  it('a ticket’s stage is the layout’s placement; an unknown status falls back to category / name', () => {
    const l = resolveSprintStatusLayout({
      autoOrder: BOARD,
      settings: { sections: { ...noSections(), in_review: ['Done'] } },
      tickets,
      evidence: new Map(),
    });
    expect(sprintStageOf(l, { name: 'done', category: 'done' })).toBe('in_review');
    expect(sprintStageOf(l, { name: 'In Development', category: 'indeterminate' })).toBe('in_progress');
    expect(sprintStageOf(l, null)).toBe('not_started');
    expect(sprintStageOf(l, { name: 'Somewhere else', category: 'indeterminate' })).toBe('in_progress');
    expect(sprintStageOf(l, { name: 'Code Review', category: 'indeterminate' })).toBe('in_review');
    expect(sprintStageOf(l, { name: 'Won’t do', category: 'done' })).toBe('done');
    expect(sprintStatusSectionIndex(l, 'in development')).toBe(1);
    expect(sprintStatusSectionIndex(l, 'Nope')).toBe(l.order.length);
  });
});

describe('storedSettingsFor (the retired {order, deliveredFrom} shape)', () => {
  it('keeps the order: new → Not started, done → Complete, before deliveredFrom → In progress, from it → In review', () => {
    const s = storedSettingsFor(
      { order: ['To Do', 'In Development', 'Ready for QA', 'In PO Review', 'Done'], deliveredFrom: 'ready for qa' },
      BOARD,
      [],
    );
    expect(s.sections).toEqual({
      not_started: ['To Do'],
      in_progress: ['In Development'],
      in_review: ['Ready for QA', 'In PO Review'],
      done: ['Done'],
    });
  });

  it('no deliveredFrom → every in-progress status In progress; an empty order → automatic', () => {
    expect(storedSettingsFor({ order: ['In Development', 'Ready for QA'], deliveredFrom: null }, BOARD, []).sections).toEqual({
      ...noSections(),
      in_progress: ['In Development', 'Ready for QA'],
    });
    expect(storedSettingsFor({ order: null, deliveredFrom: 'Ready for QA' }, BOARD, [])).toEqual({ sections: null });
  });
});

describe('foldSprintStatusEvidence', () => {
  const at = (d: number) => new Date(Date.UTC(2026, 9, d));
  const pair = (issueKey: string, prId: number, prState: string, statusName: string | null, day = 1, rowId = prId) => ({
    issueKey,
    statusName,
    fetchedAt: at(day),
    rowId,
    prId,
    prState,
  });

  it('withPrs ignores closed-unmerged PRs; allMerged needs ≥ 1 merged and none open', () => {
    const m = foldSprintStatusEvidence(
      [
        pair('ENG-1', 1, 'merged', 'Ready for QA'),
        pair('ENG-1', 2, 'closed', 'Ready for QA'),
        pair('ENG-2', 3, 'merged', 'Ready for QA'),
        pair('ENG-2', 4, 'open', 'Ready for QA'),
        pair('ENG-3', 5, 'closed', 'Ready for QA'),
      ],
      [],
    );
    expect(m.get('Ready for QA')).toEqual({ withPrs: 2, allMerged: 1 });
  });

  it('the sprint ticket’s status beats the stored rows; else the freshest stored row', () => {
    const m = foldSprintStatusEvidence(
      [pair('ENG-1', 1, 'merged', 'In Development', 1), pair('ENG-1', 2, 'merged', 'In PO Review', 3, 9), pair('eng-2', 3, 'merged', 'In Development')],
      [{ issueKey: 'ENG-2', statusName: 'in po review' }],
    );
    // ENG-1: the freshest stored row says In PO Review; ENG-2: the sprint says so (spelling: first seen).
    expect([...m.entries()]).toEqual([['In PO Review', { withPrs: 2, allMerged: 2 }]]);
  });

  it('a status read BEFORE the ticket’s last merge does not count; an out-of-sprint row read after it does', () => {
    const merged = (issueKey: string, prId: number, statusName: string, fetchedDay: number, mergedDay: number) => ({
      ...pair(issueKey, prId, 'merged', statusName, fetchedDay),
      mergedAt: at(mergedDay),
    });
    const m = foldSprintStatusEvidence(
      [
        merged('ENG-1', 1, 'In Code Review', 2, 5), // stale: read on the 2nd, merged on the 5th
        merged('ENG-2', 2, 'In Code Review', 2, 5), // stale here, but a later out-of-sprint sprint row
        merged('ENG-3', 3, 'Ready for QA', 6, 5), // read after the merge: counts
      ],
      [{ issueKey: 'ENG-2', statusName: 'Ready for QA', fetchedAt: at(7) }],
    );
    expect([...m.entries()]).toEqual([['Ready for QA', { withPrs: 2, allMerged: 2 }]]);
  });
});
