// Activity → This Sprint — the PURE status-layout fold (db/sprint-status-layout.ts). No database: the
// DB half imports db/client lazily, so importing this module opens nothing. Pinned:
//   • the automatic order: the tracker's order first, then statuses only the tickets carry, placed
//     by category; no tracker order → category then name;
//   • the automatic STAGE: new → Not started, done → Complete; a review / QA name → In review; the PR
//     evidence boundary (first in-progress status at ≥ 60% fully merged with ≥ 2 such tickets) and
//     every in-progress status after it → In review; the rest In progress;
//   • the buckets: placement beats category, an unnamed status joins the first bucket of its automatic
//     stage (else the nearest meaning's, auto) after its automatic predecessor, a named status nobody
//     has seen kept (count 0); a stored RETIRED {sections} / {order, deliveredFrom} value reads into
//     four buckets;
//   • the columns (the merged column's place) and a ticket's column (all merged / some open / none);
//   • coding begins / ends; the stage of a ticket; the section index; the evidence fold (closed-
//     unmerged PRs ignored, the sprint ticket's status beats a stored row's, the freshest otherwise).
import { describe, expect, it } from 'vitest';
import { SPRINT_STATUS_SETTINGS_DEFAULT, type SprintBucket, type SprintStage, type SprintStatusAutoOrder } from '@pierre-review/shared';
import {
  applyBuckets,
  automaticStages,
  automaticStatusOrder,
  foldSprintStatusEvidence,
  inferReviewFrom,
  isReviewStatusName,
  bucketForStage,
  resolveSprintStatusLayout,
  sprintColumnOf,
  sprintColumnsOf,
  sprintPlacementOf,
  sprintStageOf,
  sprintStatusSectionIndex,
  storedSettingsFor,
} from './sprint-status-layout.js';
import { sectionsToBuckets } from './sprint-status-settings.js';

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
const B = (id: string, name: string, meaning: SprintStage, statuses: string[]): SprintBucket => ({ id, name, meaning, statuses });

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

describe('applyBuckets', () => {
  const auto = automaticStatusOrder(BOARD, []);
  const staged = auto.map((s, i) => ({ ...s, stage: automaticStages(auto, new Map())[i]! }));
  const line = (xs: ReturnType<typeof applyBuckets>) => xs.map((s) => `${s.name}:${s.bucketId}:${s.stage}:${s.auto ? 'auto' : 'set'}`);

  it('null → the four automatic buckets, every status in its automatic stage’s', () => {
    expect(line(applyBuckets(staged, null))).toEqual([
      'To Do:not_started:not_started:auto',
      'In Development:in_progress:in_progress:auto',
      'Ready for QA:in_review:in_review:auto',
      'In PO Review:in_review:in_review:auto',
      'Done:done:done:auto',
    ]);
  });

  it('two review buckets: each holds what it names; the stage is the bucket’s meaning', () => {
    const buckets = [
      B('todo', 'To do', 'not_started', ['To Do']),
      B('dev', 'Building', 'in_progress', ['In Development']),
      B('qa', 'QA', 'in_review', ['Ready for QA']),
      B('po', 'PO review', 'in_review', ['In PO Review']),
      B('done', 'Done', 'done', ['Done']),
    ];
    expect(line(applyBuckets(staged, buckets))).toEqual([
      'To Do:todo:not_started:set',
      'In Development:dev:in_progress:set',
      'Ready for QA:qa:in_review:set',
      'In PO Review:po:in_review:set',
      'Done:done:done:set',
    ]);
  });

  it('placement beats category; an unnamed status joins the FIRST bucket of its stage after its predecessor; unknown names kept', () => {
    const buckets = [
      B('a', 'Waiting', 'not_started', []),
      B('b', 'Building', 'in_progress', ['ready for qa']),
      B('c', 'Checking', 'in_review', ['Done', 'Parked']),
      B('d', 'Checking more', 'in_review', []),
      B('e', 'Finished', 'done', []),
    ];
    expect(line(applyBuckets(staged, buckets))).toEqual([
      'To Do:a:not_started:auto',
      'In Development:b:in_progress:auto',
      'Ready for QA:b:in_progress:set',
      'In PO Review:c:in_review:auto',
      'Done:c:in_review:set',
      'Parked:c:in_review:set',
    ]);
  });

  it('no bucket of its stage → the nearest meaning’s bucket (the earlier on a tie), marked auto', () => {
    const buckets = [B('w', 'Working', 'in_progress', []), B('f', 'Finished', 'done', [])];
    expect(line(applyBuckets(staged, buckets))).toEqual([
      'To Do:w:in_progress:auto',
      'In Development:w:in_progress:auto',
      'Ready for QA:w:in_progress:auto',
      'In PO Review:w:in_progress:auto',
      'Done:f:done:auto',
    ]);
  });
});

describe('bucketForStage', () => {
  const bs = [B('a', 'A', 'not_started', []), B('b', 'B', 'in_review', []), B('c', 'C', 'in_review', [])];
  it('first of the meaning, else the nearest (earlier on a tie)', () => {
    expect(bucketForStage(bs, 'in_review')?.id).toBe('b');
    expect(bucketForStage(bs, 'done')?.id).toBe('b');
    expect(bucketForStage(bs, 'in_progress')?.id).toBe('a');
    expect(bucketForStage([], 'done')).toBeNull();
  });
});

describe('sprintColumnsOf', () => {
  const ids = (cols: ReturnType<typeof sprintColumnsOf>) => cols.map((c) => `${c.id}${c.derived ? '*' : ''}`);
  const four = [B('n', 'N', 'not_started', []), B('p', 'P', 'in_progress', []), B('r', 'R', 'in_review', []), B('d', 'D', 'done', [])];
  it('after the last In review bucket; off → buckets only', () => {
    expect(ids(sprintColumnsOf([...four.slice(0, 3), B('r2', 'R2', 'in_review', []), four[3]!], true))).toEqual(['n', 'p', 'r', 'r2', 'merged*', 'd']);
    expect(ids(sprintColumnsOf(four, false))).toEqual(['n', 'p', 'r', 'd']);
  });
  it('no review bucket → after the last In progress; neither → no merged column (nothing could sit in it)', () => {
    expect(ids(sprintColumnsOf([four[0]!, four[1]!, four[3]!], true))).toEqual(['n', 'p', 'merged*', 'd']);
    expect(ids(sprintColumnsOf([four[0]!, four[3]!, B('d2', 'D2', 'done', [])], true))).toEqual(['n', 'd', 'd2']);
    expect(ids(sprintColumnsOf([four[0]!], true))).toEqual(['n']);
  });
  it('the merged column is named and means In review', () => {
    expect(sprintColumnsOf(four, true).find((c) => c.derived)).toEqual({ id: 'merged', name: 'Merged, not signed off', meaning: 'in_review', derived: true });
  });
});

describe('sprintColumnOf', () => {
  const pr = (state: string) => ({ state });
  const review = { stage: 'in_review' as const, bucketId: 'qa' };
  it('every PR merged (closed unmerged ignored) → merged; one open → its bucket; no PRs → its bucket; off → its bucket', () => {
    expect(sprintColumnOf(review, [pr('merged'), pr('merged')], true)).toBe('merged');
    expect(sprintColumnOf(review, [pr('merged'), pr('closed')], true)).toBe('merged');
    expect(sprintColumnOf(review, [pr('merged'), pr('open')], true)).toBe('qa');
    expect(sprintColumnOf(review, [], true)).toBe('qa');
    expect(sprintColumnOf(review, [pr('closed')], true)).toBe('qa');
    expect(sprintColumnOf(review, [pr('merged')], false)).toBe('qa');
  });
  it('only In progress / In review tickets move; unknown status → null', () => {
    expect(sprintColumnOf({ stage: 'in_progress', bucketId: 'dev' }, [pr('merged')], true)).toBe('merged');
    expect(sprintColumnOf({ stage: 'done', bucketId: 'done' }, [pr('merged')], true)).toBe('done');
    expect(sprintColumnOf({ stage: 'not_started', bucketId: 'todo' }, [pr('merged')], true)).toBe('todo');
    expect(sprintColumnOf(null, [pr('merged')], true)).toBeNull();
  });
});

describe('resolveSprintStatusLayout', () => {
  const tickets = [t('To Do', 'new'), t('In Development', 'indeterminate'), t('In Development', 'indeterminate'), t('In PO Review', 'indeterminate'), t('Done', 'done'), t('Won’t do', 'done')];

  it('counts every ticket per status (done too), stages each status, names coding begins / ends', () => {
    const l = resolveSprintStatusLayout({ autoOrder: BOARD, settings: SPRINT_STATUS_SETTINGS_DEFAULT, tickets, evidence: ev({ 'In PO Review': [3, 3] }) });
    expect(l.orderSource).toBe('jira_board');
    expect(l.order.map((o) => `${o.name}:${o.count}:${o.stage}`)).toEqual([
      'To Do:1:not_started',
      'In Development:2:in_progress',
      'Ready for QA:0:in_review',
      'In PO Review:1:in_review',
      'Done:1:done',
      'Won’t do:1:done',
    ]);
    expect([l.codingBegins, l.codingEnds]).toEqual(['In Development', 'Ready for QA']);
    expect(l.evidence.map((e) => `${e.status}:${e.allMerged}/${e.withPrs}`)).toEqual(['In Development:0/0', 'Ready for QA:0/0', 'In PO Review:3/3']);
  });

  it('automatic → four buckets named by stage, Won’t do in Complete, the merged column after In review', () => {
    const l = resolveSprintStatusLayout({ autoOrder: BOARD, settings: SPRINT_STATUS_SETTINGS_DEFAULT, tickets, evidence: new Map() });
    expect(l.buckets.map((b) => `${b.id}:${b.name}:${names(b.statuses).join('|')}`)).toEqual([
      'not_started:Not started:To Do',
      'in_progress:In progress:In Development',
      'in_review:In review:Ready for QA|In PO Review',
      'done:Complete:Done|Won’t do',
    ]);
    expect(l.columns.map((c) => c.id)).toEqual(['not_started', 'in_progress', 'in_review', 'merged', 'done']);
  });

  it('custom buckets: two review stages, Won’t do moved, the column inserted after the second review bucket', () => {
    const l = resolveSprintStatusLayout({
      autoOrder: BOARD,
      settings: {
        buckets: [
          B('todo', 'To do', 'not_started', ['To Do', 'Won’t do']),
          B('dev', 'Building', 'in_progress', ['In Development']),
          B('qa', 'QA', 'in_review', ['Ready for QA']),
          B('po', 'PO review', 'in_review', ['In PO Review']),
          B('done', 'Done', 'done', ['Done']),
        ],
        mergedColumn: true,
      },
      tickets,
      evidence: new Map(),
    });
    expect(l.orderSource).toBe('override');
    expect(l.columns.map((c) => c.id)).toEqual(['todo', 'dev', 'qa', 'po', 'merged', 'done']);
    expect(l.order.find((o) => o.name === 'Won’t do')).toMatchObject({ bucketId: 'todo', stage: 'not_started', auto: false, count: 1 });
    expect(sprintPlacementOf(l, { name: 'In PO Review', category: 'indeterminate' })).toEqual({ stage: 'in_review', bucketId: 'po' });
    // Unknown to the layout: by category / name, into the first bucket of that stage.
    expect(sprintPlacementOf(l, { name: 'Code Review', category: 'indeterminate' })).toEqual({ stage: 'in_review', bucketId: 'qa' });
  });

  it('an override is the source; an empty stage has no coding status', () => {
    const l = resolveSprintStatusLayout({
      autoOrder: BOARD,
      settings: { buckets: [B('p', 'Doing', 'in_progress', ['In PO Review', 'Ready for QA', 'In Development'])], mergedColumn: false },
      tickets,
      evidence: new Map(),
    });
    expect(l.orderSource).toBe('override');
    // "To Do" has no automatic predecessor in the bucket, so it leads it.
    expect([l.codingBegins, l.codingEnds]).toEqual(['To Do', null]);
    expect(l.columns.map((c) => c.id)).toEqual(['p']);
    // Everything the one bucket does not name lands in it as the nearest meaning, marked auto.
    expect(l.order.filter((o) => o.auto).map((o) => `${o.name}:${o.bucketId}:${o.stage}`)).toEqual([
      'To Do:p:in_progress',
      'Done:p:in_progress',
      'Won’t do:p:in_progress',
    ]);
  });

  it('a ticket’s stage is the layout’s placement; an unknown status falls back to category / name', () => {
    const l = resolveSprintStatusLayout({
      autoOrder: BOARD,
      settings: { buckets: sectionsToBuckets({ ...noSections(), in_review: ['Done'] }), mergedColumn: true },
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

describe('storedSettingsFor (the retired shapes)', () => {
  const sec = (s: { buckets: Array<{ id: string; statuses: string[] }> | null }) =>
    s.buckets == null ? null : Object.fromEntries(s.buckets.map((b) => [b.id, b.statuses]));

  it('{order, deliveredFrom}: new → Not started, done → Complete, before deliveredFrom → In progress, from it → In review', () => {
    const s = storedSettingsFor(
      { order: ['To Do', 'In Development', 'Ready for QA', 'In PO Review', 'Done'], deliveredFrom: 'ready for qa' },
      BOARD,
      [],
    );
    expect(sec(s)).toEqual({
      not_started: ['To Do'],
      in_progress: ['In Development'],
      in_review: ['Ready for QA', 'In PO Review'],
      done: ['Done'],
    });
    expect(s.buckets?.map((b) => b.name)).toEqual(['Not started', 'In progress', 'In review', 'Complete']);
    expect(s.mergedColumn).toBe(true);
  });

  it('no deliveredFrom → every in-progress status In progress; an empty order → automatic', () => {
    expect(sec(storedSettingsFor({ order: ['In Development', 'Ready for QA'], deliveredFrom: null }, BOARD, []))).toEqual({
      ...noSections(),
      in_progress: ['In Development', 'Ready for QA'],
    });
    expect(storedSettingsFor({ order: null, deliveredFrom: 'Ready for QA' }, BOARD, [])).toEqual({ buckets: null, mergedColumn: true });
  });

  it('{sections} → four buckets named by stage; an empty one → automatic', () => {
    const s = storedSettingsFor({ sections: { ...noSections(), in_review: ['Done'], done: ['Won’t do'] } }, BOARD, []);
    expect(sec(s)).toEqual({ ...noSections(), in_review: ['Done'], done: ['Won’t do'] });
    expect(storedSettingsFor({ sections: noSections() }, BOARD, [])).toEqual({ buckets: null, mergedColumn: true });
    expect(storedSettingsFor({ sections: null }, BOARD, [])).toEqual({ buckets: null, mergedColumn: true });
  });

  it('a stored bucket list whose meanings go backwards reads as automatic; mergedColumn kept', () => {
    const back = { buckets: [B('d', 'Done', 'done', []), B('t', 'Todo', 'not_started', [])], mergedColumn: false };
    expect(storedSettingsFor(back, BOARD, [])).toEqual({ buckets: null, mergedColumn: false });
  });

  it('a stored bucket whose name repeats an earlier one (any case) is dropped, its statuses with it', () => {
    const twice = { buckets: [B('a', 'Review', 'in_review', ['Code Review']), B('b', 'review', 'in_review', ['PO Review'])], mergedColumn: true };
    expect(storedSettingsFor(twice, BOARD, [])).toEqual({ buckets: [B('a', 'Review', 'in_review', ['Code Review'])], mergedColumn: true });
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
