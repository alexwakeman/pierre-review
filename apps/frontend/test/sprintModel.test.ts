// Activity → This Sprint: the pure folds behind the tab (components/Activity/sprintModel.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sprintModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  SPRINT_BUCKETS_MAX,
  SPRINT_STAGE_LABEL,
  SPRINT_STATUS_ORDER_MAX,
  type SprintStage,
  type SprintStatusLayoutEntry,
  type SprintStatusLayout,
} from '@pierre-review/shared';
import {
  reviewRuleSentence,
  addBucket,
  bucketsDraftChanged,
  bucketsDraftOf,
  bucketsDraftProblem,
  bucketsToSave,
  canMoveStatusStep,
  codingBoundsOf,
  moveBucket,
  moveStatusStep,
  moveStatusTo,
  newBucketId,
  removeBucket,
  renameBucket,
  setBucketMeaning,
  statusPlaceOf,
  statusesLeftOutOnSave,
  shareWords,
  statusEvidenceLine,
  statusOrderSourceLabel,
  unplacedStatuses,
} from '../src/components/Activity/sprintModel.js';
import { effectiveInsightsTab } from '../src/components/Activity/bottlenecksModel.js';
import { INSIGHTS_INNER_TABS, SPRINT_INNER_TABS, sprintTabFromUrl } from '../src/store/filters.js';
import { effectiveSprintTab, SPRINT_RAIL_TABS } from '../src/components/Activity/sprintRailModel.js';

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

  it('This Sprint opens on Critical path; Theme, People and Merged so far follow; anything else derives to Critical path', () => {
    expect(SPRINT_INNER_TABS).toEqual(['paths', 'themes', 'people', 'merged']);
    expect(SPRINT_RAIL_TABS.map((t) => t.label)).toEqual(['Critical path', 'Theme', 'People', 'Merged so far']);
    expect(effectiveSprintTab('merged')).toBe('merged');
    expect(effectiveSprintTab('themes')).toBe('themes');
    expect(effectiveSprintTab('people')).toBe('people');
    // The retired force graph, a hand-edited value and nothing at all: the landing view.
    expect(effectiveSprintTab('graph')).toBe('paths');
    expect(effectiveSprintTab('nonsense')).toBe('paths');
    expect(effectiveSprintTab(null)).toBe('paths');
  });

  it('?sprintTab= seats a member as itself and the retired graph as Critical path; anything else seats nothing', () => {
    expect(sprintTabFromUrl('people')).toBe('people');
    expect(sprintTabFromUrl('themes')).toBe('themes');
    expect(sprintTabFromUrl('merged')).toBe('merged');
    expect(sprintTabFromUrl('paths')).toBe('paths');
    expect(sprintTabFromUrl('graph')).toBe('paths');
    expect(sprintTabFromUrl('nonsense')).toBeNull();
    expect(sprintTabFromUrl(null)).toBeNull();
  });
});

const E = (name: string, stage: SprintStage, count = 0, auto = true, bucketId: string = stage): SprintStatusLayoutEntry => ({
  name,
  category: stage === 'not_started' ? 'new' : stage === 'done' ? 'done' : 'indeterminate',
  count,
  auto,
  stage,
  bucketId,
});

/** A layout with the four automatic buckets (or `order`'s own bucket ids, in first-seen order). */
function layout(over: Partial<SprintStatusLayout> = {}): SprintStatusLayout {
  const order = over.order ?? [
    E('To Do', 'not_started', 1),
    E('In Development', 'in_progress', 2),
    E('Ready for QA', 'in_review', 1),
    E('In PO Review', 'in_review', 1),
    E('Done', 'done', 0),
  ];
  const ids = [...new Set(order.map((o) => o.bucketId))];
  const buckets =
    over.buckets ??
    ids.map((id) => {
      const st = order.find((o) => o.bucketId === id)!.stage;
      return { id, name: SPRINT_STAGE_LABEL[st], meaning: st, statuses: order.filter((o) => o.bucketId === id) };
    });
  return {
    order,
    buckets,
    columns: [],
    orderSource: 'jira_board',
    codingBegins: 'In Development',
    codingEnds: 'Ready for QA',
    evidence: [
      { status: 'In Development', withPrs: 9, allMerged: 2 },
      { status: 'Ready for QA', withPrs: 6, allMerged: 4 },
      { status: 'In PO Review', withPrs: 11, allMerged: 11 },
    ],
    settings: { buckets: null, mergedColumn: true },
    ...over,
  };
}

const lists = (d: ReturnType<typeof bucketsDraftOf>) => d.buckets.map((b) => b.statuses);

describe('status buckets', () => {
  it('the draft is the layout’s buckets, every status in place, and the switch', () => {
    const d = bucketsDraftOf(layout());
    expect(d.buckets.map((b) => `${b.id}:${b.name}:${b.meaning}`)).toEqual([
      'not_started:Not started:not_started',
      'in_progress:In progress:in_progress',
      'in_review:In review:in_review',
      'done:Complete:done',
    ]);
    expect(lists(d)).toEqual([['To Do'], ['In Development'], ['Ready for QA', 'In PO Review'], ['Done']]);
    expect(d.mergedColumn).toBe(true);
  });

  it('move up / down within a bucket, and across a bucket boundary; the two ends are no-ops', () => {
    const d = bucketsDraftOf(layout());
    expect(lists(moveStatusStep(d, 2, 1, -1))[2]).toEqual(['In PO Review', 'Ready for QA']);
    expect(lists(moveStatusStep(d, 2, 0, -1)).slice(1, 3)).toEqual([['In Development', 'Ready for QA'], ['In PO Review']]);
    expect(lists(moveStatusStep(d, 1, 0, 1)).slice(1, 3)).toEqual([[], ['In Development', 'Ready for QA', 'In PO Review']]);
    expect(canMoveStatusStep(d, 0, 0, -1)).toBe(false);
    expect(canMoveStatusStep(d, 3, 0, 1)).toBe(false);
    expect(moveStatusStep(d, 0, 0, -1)).toEqual(d);
    expect(canMoveStatusStep(d, 3, 0, -1)).toBe(true);
  });

  it('drag: insert at a slot of any bucket — within one, across buckets, into an empty one', () => {
    const d = bucketsDraftOf(layout());
    expect(lists(moveStatusTo(d, { bucket: 2, index: 0 }, 2, 2))[2]).toEqual(['In PO Review', 'Ready for QA']);
    expect(lists(moveStatusTo(d, { bucket: 2, index: 1 }, 2, 0))[2]).toEqual(['In PO Review', 'Ready for QA']);
    expect(moveStatusTo(d, { bucket: 2, index: 0 }, 2, 0)).toEqual(d);
    expect(moveStatusTo(d, { bucket: 2, index: 0 }, 2, 1)).toEqual(d);
    const x = moveStatusTo(d, { bucket: 0, index: 0 }, 2, 1);
    expect([lists(x)[0], lists(x)[2]]).toEqual([[], ['Ready for QA', 'To Do', 'In PO Review']]);
    const y = moveStatusTo(x, { bucket: 3, index: 0 }, 0, 0);
    expect([lists(y)[0], lists(y)[3]]).toEqual([['Done'], []]);
    expect(moveStatusTo(d, { bucket: 3, index: 5 }, 2, 0)).toEqual(d);
    expect(moveStatusTo(d, { bucket: 3, index: 0 }, 2, 9)).toEqual(d);
    expect(moveStatusTo(d, { bucket: 9, index: 0 }, 2, 0)).toEqual(d);
    expect(d.buckets[2]!.statuses).toEqual(['Ready for QA', 'In PO Review']);
  });

  it('add, rename, set the meaning, reorder and delete buckets', () => {
    const d = bucketsDraftOf(layout());
    const added = addBucket(d);
    expect(added.buckets[4]).toEqual({ id: 'b1', name: 'New bucket', meaning: 'done', statuses: [] });
    expect(addBucket(added).buckets[5]).toMatchObject({ id: 'b2', name: 'New bucket 2' });
    let full = d;
    while (full.buckets.length < SPRINT_BUCKETS_MAX) full = addBucket(full);
    expect(addBucket(full)).toEqual(full);
    expect(newBucketId({ mergedColumn: true, buckets: [{ id: 'b1', name: 'x', meaning: 'done', statuses: [] }] })).toBe('b2');

    // Two review stages: split In review, rename.
    const two = renameBucket(setBucketMeaning(moveBucket(addBucket(d), 4, -1), 'b1', 'in_review'), 'b1', 'PO review');
    const split = moveStatusTo(two, { bucket: 2, index: 1 }, 3, 0);
    expect(split.buckets.map((b) => `${b.name}:${b.meaning}:${b.statuses.join('|')}`)).toEqual([
      'Not started:not_started:To Do',
      'In progress:in_progress:In Development',
      'In review:in_review:Ready for QA',
      'PO review:in_review:In PO Review',
      'Complete:done:Done',
    ]);
    expect(bucketsDraftProblem(layout(), split)).toBeNull();

    // Delete: statuses move to the first other bucket of the same meaning, else the one before.
    expect(lists(removeBucket(split, 'b1'))).toEqual([['To Do'], ['In Development'], ['Ready for QA', 'In PO Review'], ['Done']]);
    expect(lists(removeBucket(split, 'in_progress'))).toEqual([['To Do', 'In Development'], ['Ready for QA'], ['In PO Review'], ['Done']]);
    expect(lists(removeBucket(split, 'not_started'))[0]).toEqual(['In Development', 'To Do']);
    const one = { mergedColumn: true, buckets: [split.buckets[0]!] };
    expect(removeBucket(one, 'not_started')).toEqual(one);
    expect(moveBucket(d, 0, -1)).toEqual(d);
  });

  it('Won’t do moves into the Complete bucket; plain-English problems block Save', () => {
    const l = layout({ order: [...layout().order, E('Won’t do', 'not_started', 3)] });
    const d = bucketsDraftOf(l);
    const moved = moveStatusTo(d, statusPlaceOf(d, 'Won’t do') as { bucket: number; index: number }, 3, 1);
    expect(lists(moved)[3]).toEqual(['Done', 'Won’t do']);
    expect(bucketsDraftProblem(l, moveBucket(d, 3, -1))).toBe(
      '“In review” means In review, so it cannot come after a bucket that means Complete.',
    );
    expect(bucketsDraftProblem(l, renameBucket(d, 'done', '  '))).toBe('Give every bucket a name.');
    expect(bucketsDraftProblem(l, renameBucket(d, 'done', 'in review'))).toBe('Two buckets are called “in review”.');
  });

  it('coding begins / ends read off the draft; where a status sits; changed or not', () => {
    const d = bucketsDraftOf(layout());
    expect(codingBoundsOf(d)).toEqual({ begins: 'In Development', ends: 'Ready for QA' });
    const moved = moveStatusTo(d, { bucket: 1, index: 0 }, 2, 0);
    expect(codingBoundsOf(moved)).toEqual({ begins: null, ends: 'In Development' });
    expect(statusPlaceOf(moved, 'In PO Review')).toEqual({ bucket: 2, index: 2 });
    expect(statusPlaceOf(moved, 'Nope')).toBeNull();
    expect(bucketsDraftChanged(layout(), d)).toBe(false);
    expect(bucketsDraftChanged(layout(), moved)).toBe(true);
    expect(bucketsDraftChanged(layout(), { ...d, mergedColumn: false })).toBe(true);
    expect(bucketsDraftChanged(layout(), renameBucket(d, 'done', 'Complete '))).toBe(false);
  });

  it('save payload: buckets untouched → the stored buckets (automatic stays automatic); changed → every bucket, names trimmed', () => {
    const l = layout();
    const d = bucketsDraftOf(l);
    expect(bucketsToSave(l, d)).toEqual({ buckets: null, mergedColumn: true });
    expect(bucketsToSave(l, { ...d, mergedColumn: false })).toEqual({ buckets: null, mergedColumn: false });
    const moved = renameBucket(moveStatusStep(d, 2, 0, -1), 'done', ' Shipped ');
    const out = bucketsToSave(l, moved);
    expect(out.buckets?.map((b) => `${b.id}:${b.name}:${b.statuses.join('|')}`)).toEqual([
      'not_started:Not started:To Do',
      'in_progress:In progress:In Development|Ready for QA',
      'in_review:In review:In PO Review',
      'done:Shipped:Done',
    ]);
  });

  it('over the route’s limit: Save leaves out 0-count statuses first, then the last ones; it is never blocked by the cap', () => {
    // 61 statuses with tickets: the last is left out, and Save is open.
    const many = Array.from({ length: SPRINT_STATUS_ORDER_MAX + 1 }, (_, i) => E(`S${i}`, 'in_progress', 1));
    const l = layout({ order: many });
    const moved = moveStatusStep(bucketsDraftOf(l), 0, 1, -1);
    const all = (bucketsToSave(l, moved).buckets ?? []).flatMap((b) => b.statuses);
    expect(all).toHaveLength(SPRINT_STATUS_ORDER_MAX);
    expect(all[0]).toBe('S1');
    expect([...statusesLeftOutOnSave(l, moved)]).toEqual([`S${SPRINT_STATUS_ORDER_MAX}`]);
    expect(bucketsDraftProblem(l, moved)).toBeNull();

    // 58 with tickets and 5 retired (0 tickets) — 63: three retired ones go, every live one stays.
    const live = Array.from({ length: 58 }, (_, i) => E(`L${i}`, 'in_progress', 2));
    const dead = Array.from({ length: 5 }, (_, i) => E(`Old${i}`, 'in_progress', 0));
    const l2 = layout({ order: [...dead, ...live] });
    const d2 = renameBucket(bucketsDraftOf(l2), 'in_progress', 'Building');
    expect([...statusesLeftOutOnSave(l2, d2)].sort()).toEqual(['Old2', 'Old3', 'Old4']);
    const kept = (bucketsToSave(l2, d2).buckets ?? []).flatMap((b) => b.statuses);
    expect(kept).toHaveLength(SPRINT_STATUS_ORDER_MAX);
    expect(live.every((e) => kept.includes(e.name))).toBe(true);
    expect(bucketsDraftProblem(l2, d2)).toBeNull();
    expect(statusesLeftOutOnSave(layout(), bucketsDraftOf(layout())).size).toBe(0);
  });

  it('"not placed yet" only once buckets are set', () => {
    expect(unplacedStatuses(layout()).size).toBe(0);
    const set = layout({
      order: [E('To Do', 'not_started', 1, false), E('Blocked', 'in_progress', 2, true)],
      settings: { buckets: [{ id: 'not_started', name: 'To do', meaning: 'not_started', statuses: ['To Do'] }], mergedColumn: true },
    });
    expect([...unplacedStatuses(set)]).toEqual(['Blocked']);
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
    expect(statusOrderSourceLabel('override')).toBe('Your buckets');
  });
});
