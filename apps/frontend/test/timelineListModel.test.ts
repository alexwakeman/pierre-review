import { describe, expect, it } from 'vitest';
import type { TimelineEvent, TimelinePr } from '@pierre-review/shared';
import { timelineListModel } from '../src/components/Timeline/listModel.js';

// The phone's Timeline LIST (components/Timeline/TimelineList.tsx) must show the SAME PRs the board
// draws bars for: the board's payload, narrowed by the two client-side filters its rebuild applies
// (Members → authored only; Threads → an in-window review comment in a selected state), the selected
// PR always kept.

const pr = (id: number, over: Partial<TimelinePr> = {}): TimelinePr =>
  ({
    id,
    repoId: 1,
    number: id,
    title: `PR ${id}`,
    authorId: 10,
    state: 'open',
    isDraft: false,
    isStalled: false,
    openedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...over,
  }) as TimelinePr;

const ev = (id: number, prId: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id,
  repoId: 1,
  actorId: 10,
  prId,
  type: 'commit_pushed',
  occurredAt: '2026-10-05T00:00:00Z',
  threadId: null,
  derivedState: null,
  refId: null,
  reviewState: null,
  ...over,
} as TimelineEvent);

const repos = new Map([
  [1, { fullName: 'acme/web' }],
  [2, { fullName: 'acme/api' }],
]);

const base = { repos, userIds: null, derivedStates: [], selectedPrId: null };

describe('timelineListModel', () => {
  it('groups by repo (by name), most recently active first, with the in-window event count', () => {
    const g = timelineListModel({
      ...base,
      prs: [pr(1), pr(2), pr(3, { repoId: 2 })],
      events: [ev(1, 1, { occurredAt: '2026-10-03T00:00:00Z' }), ev(2, 2, { occurredAt: '2026-10-09T00:00:00Z' }), ev(3, 2)],
    });
    expect(g.map((x) => x.name)).toEqual(['acme/api', 'acme/web']);
    expect(g[1]!.rows.map((r) => [r.pr.id, r.events])).toEqual([
      [2, 2],
      [1, 1],
    ]);
    // No event in the window: the PR's own updatedAt orders it.
    expect(g[0]!.rows[0]!.lastAt).toBe(Date.parse('2026-10-02T00:00:00Z'));
  });

  it('Members keeps only PRs a selected member AUTHORED; the selected PR always stays', () => {
    const prs = [pr(1, { authorId: 10 }), pr(2, { authorId: 11 }), pr(3, { authorId: null })];
    expect(timelineListModel({ ...base, prs, events: [], userIds: [10] }).flatMap((g) => g.rows.map((r) => r.pr.id))).toEqual([1]);
    expect(
      timelineListModel({ ...base, prs, events: [], userIds: [10], selectedPrId: 2 })
        .flatMap((g) => g.rows.map((r) => r.pr.id))
        .sort(),
    ).toEqual([1, 2]);
  });

  it('Threads keeps only PRs with an in-window review comment in a selected state', () => {
    const prs = [pr(1), pr(2)];
    const events = [
      ev(1, 1, { type: 'review_comment', derivedState: 'untouched' }),
      ev(2, 2, { type: 'review_comment', derivedState: 'resolved' }),
    ];
    const ids = timelineListModel({ ...base, prs, events, derivedStates: ['untouched'] }).flatMap((g) => g.rows.map((r) => r.pr.id));
    expect(ids).toEqual([1]);
  });

  it('an unknown repo still lists, under a plain name', () => {
    const g = timelineListModel({ ...base, prs: [pr(1, { repoId: 9 })], events: [] });
    expect(g[0]!.name).toBe('Repository 9');
  });
});
