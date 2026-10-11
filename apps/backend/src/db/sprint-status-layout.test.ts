// Reports → This sprint — the PURE status-layout fold (db/sprint-status-layout.ts). No database: the
// DB half imports db/client lazily, so importing this module opens nothing. Pinned:
//   • the automatic order: the tracker's order first, then statuses only the tickets carry, placed
//     by category; no tracker order → category then name;
//   • an override: its names in its order, every unnamed status after its automatic predecessor, a
//     named status nobody has seen kept (count 0);
//   • "code delivered from": the first in-progress status at ≥ 60% fully-merged with ≥ 2 such
//     tickets — exactly 60% counts, 1 ticket never does, category new/done never qualifies; an
//     override naming an absent status is ignored;
//   • stage: category beats position; the section index; the evidence fold (closed-unmerged PRs
//     ignored, the sprint ticket's status beats a stored row's, the freshest stored row otherwise).
import { describe, expect, it } from 'vitest';
import { SPRINT_STATUS_SETTINGS_DEFAULT, type SprintStatusAutoOrder } from '@pierre-review/shared';
import {
  applyOrderOverride,
  automaticStatusOrder,
  foldSprintStatusEvidence,
  inferDeliveredFrom,
  resolveSprintStatusLayout,
  sprintStageOf,
  sprintStatusSectionIndex,
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
const t = (statusName: string | null, statusCategory: string | null) => ({ statusName, statusCategory });
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);

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

describe('applyOrderOverride', () => {
  const auto = automaticStatusOrder(BOARD, []);
  it('override names first-class; unnamed statuses follow their automatic predecessor; unknown names kept', () => {
    const o = applyOrderOverride(auto, ['In PO Review', 'ready for qa', 'Parked']);
    expect(o.map((s) => `${s.name}:${s.auto ? 'auto' : 'set'}`)).toEqual([
      'To Do:auto',
      'In Development:auto',
      'In PO Review:set',
      'Ready for QA:set',
      'Parked:set',
      'Done:auto',
    ]);
  });

  it('null or empty override → the automatic order', () => {
    expect(names(applyOrderOverride(auto, null))).toEqual(names(auto));
    expect(names(applyOrderOverride(auto, []))).toEqual(names(auto));
  });
});

describe('inferDeliveredFrom', () => {
  const order = automaticStatusOrder(BOARD, []);
  const ev = (o: Record<string, [number, number]>) => new Map(Object.entries(o).map(([k, [w, m]]) => [k, { withPrs: w, allMerged: m }]));

  it('the first in-progress status at ≥ 60% with ≥ 2 fully merged (the dev data: Ready for QA 4/6)', () => {
    expect(inferDeliveredFrom(order, ev({ 'In Development': [9, 2], 'Ready for QA': [6, 4], 'In PO Review': [11, 11] }))).toBe('Ready for QA');
  });

  it('exactly 60% counts; 1 fully-merged ticket never does; matching is case-insensitive', () => {
    expect(inferDeliveredFrom(order, ev({ 'in development': [5, 3] }))).toBe('In Development');
    expect(inferDeliveredFrom(order, ev({ 'In Development': [1, 1], 'Ready for QA': [10, 5] }))).toBeNull();
  });

  it('new and done statuses never qualify', () => {
    expect(inferDeliveredFrom(order, ev({ 'To Do': [4, 4], Done: [8, 8] }))).toBeNull();
  });
});

describe('resolveSprintStatusLayout', () => {
  const tickets = [t('To Do', 'new'), t('In Development', 'indeterminate'), t('In Development', 'indeterminate'), t('In PO Review', 'indeterminate'), t('Done', 'done')];
  const evidence = new Map([['In PO Review', { withPrs: 3, allMerged: 3 }]]);

  it('counts listed tickets per status, infers delivered-from, stages each status', () => {
    const l = resolveSprintStatusLayout({ autoOrder: BOARD, settings: SPRINT_STATUS_SETTINGS_DEFAULT, tickets, evidence });
    expect(l.orderSource).toBe('jira_board');
    expect(l.deliveredFrom).toBe('In PO Review');
    expect(l.deliveredFromAuto).toBe('In PO Review');
    expect(l.order.map((o) => `${o.name}:${o.count}:${o.stage}`)).toEqual([
      'To Do:1:not_started',
      'In Development:2:writing',
      'Ready for QA:0:writing',
      'In PO Review:1:delivered',
      'Done:0:done',
    ]);
    expect(l.evidence.map((e) => `${e.status}:${e.allMerged}/${e.withPrs}`)).toEqual(['In Development:0/0', 'Ready for QA:0/0', 'In PO Review:3/3']);
  });

  it('an override wins; one naming an absent status is ignored for delivered-from', () => {
    const set = resolveSprintStatusLayout({ autoOrder: BOARD, settings: { order: null, deliveredFrom: 'ready for qa' }, tickets, evidence });
    expect(set.deliveredFrom).toBe('Ready for QA');
    expect(set.deliveredFromAuto).toBe('In PO Review');
    const absent = resolveSprintStatusLayout({ autoOrder: BOARD, settings: { order: null, deliveredFrom: 'Shipped' }, tickets, evidence });
    expect(absent.deliveredFrom).toBe('In PO Review');
    const ordered = resolveSprintStatusLayout({ autoOrder: BOARD, settings: { order: ['In PO Review', 'In Development'], deliveredFrom: null }, tickets, evidence });
    expect(ordered.orderSource).toBe('override');
  });

  it('the automatic split follows the reader’s saved order, not the tracker’s', () => {
    const ev = new Map([
      ['Ready for QA', { withPrs: 4, allMerged: 4 }],
      ['In PO Review', { withPrs: 3, allMerged: 3 }],
    ]);
    const auto = resolveSprintStatusLayout({ autoOrder: BOARD, settings: SPRINT_STATUS_SETTINGS_DEFAULT, tickets, evidence: ev });
    expect(auto.deliveredFromAuto).toBe('Ready for QA');
    const moved = resolveSprintStatusLayout({
      autoOrder: BOARD,
      settings: { order: ['To Do', 'In Development', 'In PO Review', 'Ready for QA', 'Done'], deliveredFrom: null },
      tickets,
      evidence: ev,
    });
    expect(moved.deliveredFromAuto).toBe('In PO Review');
    expect(moved.deliveredFrom).toBe('In PO Review');
  });

  it('category beats position for the stage; unknown status → after all sections', () => {
    const l = resolveSprintStatusLayout({ autoOrder: BOARD, settings: SPRINT_STATUS_SETTINGS_DEFAULT, tickets, evidence });
    expect(sprintStageOf(l, { name: 'In PO Review', category: 'done' })).toBe('done');
    expect(sprintStageOf(l, { name: 'In PO Review', category: 'new' })).toBe('not_started');
    expect(sprintStageOf(l, null)).toBe('not_started');
    expect(sprintStageOf(l, { name: 'Somewhere else', category: 'indeterminate' })).toBe('writing');
    expect(sprintStageOf({ ...l, deliveredFrom: null }, { name: 'In PO Review', category: 'indeterminate' })).toBe('writing');
    expect(sprintStatusSectionIndex(l, 'in development')).toBe(1);
    expect(sprintStatusSectionIndex(l, 'Nope')).toBe(l.order.length);
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
