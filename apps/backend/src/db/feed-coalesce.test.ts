import { describe, expect, it } from 'vitest';
import type { ConsolidatedFeedItem } from '@pierre-review/shared';
import { coalesceReviewComments } from './queries.js';

// Minimal ConsolidatedFeedItem factory — only the fields the coalescing pass reads matter;
// everything else is filled with an inert default so the shape stays exhaustive.
function item(over: Partial<ConsolidatedFeedItem> & Pick<ConsolidatedFeedItem, 'id' | 'kind'>): ConsolidatedFeedItem {
  return {
    isMyTurn: false,
    myTurnReasons: [],
    occurredAt: '2026-07-07T00:00:00.000Z',
    repoId: 1,
    repoFullName: 'acme/app',
    prId: 10,
    prNumber: 10,
    prTitle: 'PR',
    prState: 'open',
    actorId: 1,
    content: null,
    threadId: null,
    commentId: null,
    path: null,
    line: null,
    reasonTag: null,
    reviewState: null,
    githubUrl: null,
    mergedById: null,
    reviewers: null,
    ciStatus: null,
    changedFilesCount: null,
    affectedThreads: null,
    commitCount: null,
    changeSummary: null,
    claudeReviewId: null,
    claudeVerdict: null,
    mergedComments: [],
    ...over,
  };
}

function run(items: ConsolidatedFeedItem[]): ConsolidatedFeedItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  coalesceReviewComments(items, byId);
  // byId must stay consistent with the surviving items.
  expect([...byId.keys()].sort()).toEqual(items.map((i) => i.id).sort());
  return items;
}

const T = (min: number): string => new Date(Date.parse('2026-07-07T12:00:00.000Z') + min * 60_000).toISOString();

describe('coalesceReviewComments', () => {
  it('folds a same-actor PR comment posted within 5 min into the review', () => {
    const items = run([
      item({ id: 'r', kind: 'review_submitted', reviewState: 'approved', occurredAt: T(0), content: 'LGTM' }),
      item({ id: 'c', kind: 'pr_comment', commentId: 55, occurredAt: T(2), content: 'nice work!' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['r']);
    const review = items[0]!;
    expect(review.mergedComments).toEqual([
      { commentId: 55, content: 'nice work!', occurredAt: T(2) },
    ]);
  });

  it('does NOT fold a comment outside the window', () => {
    const items = run([
      item({ id: 'r', kind: 'review_submitted', occurredAt: T(0) }),
      item({ id: 'c', kind: 'pr_comment', commentId: 55, occurredAt: T(6) }),
    ]);
    expect(items.map((i) => i.id).sort()).toEqual(['c', 'r']);
    expect(items.find((i) => i.id === 'r')!.mergedComments).toEqual([]);
  });

  it('does NOT fold a comment by a DIFFERENT actor', () => {
    const items = run([
      item({ id: 'r', kind: 'review_submitted', actorId: 1, occurredAt: T(0) }),
      item({ id: 'c', kind: 'pr_comment', actorId: 2, commentId: 55, occurredAt: T(1) }),
    ]);
    expect(items.map((i) => i.id).sort()).toEqual(['c', 'r']);
  });

  it('does NOT fold a comment on a DIFFERENT PR', () => {
    const items = run([
      item({ id: 'r', kind: 'review_submitted', prId: 10, occurredAt: T(0) }),
      item({ id: 'c', kind: 'pr_comment', prId: 11, commentId: 55, occurredAt: T(1) }),
    ]);
    expect(items.map((i) => i.id).sort()).toEqual(['c', 'r']);
  });

  it('folds multiple comments into one review, chronologically', () => {
    const items = run([
      item({ id: 'r', kind: 'review_submitted', occurredAt: T(2) }),
      item({ id: 'c2', kind: 'pr_comment', commentId: 2, occurredAt: T(3), content: 'second' }),
      item({ id: 'c1', kind: 'pr_comment', commentId: 1, occurredAt: T(1), content: 'first' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['r']);
    expect(items[0]!.mergedComments.map((c) => c.commentId)).toEqual([1, 2]);
  });

  it('claims a comment for its NEAREST review when two are in range', () => {
    const items = run([
      item({ id: 'rA', kind: 'review_submitted', occurredAt: T(0) }),
      item({ id: 'rB', kind: 'review_submitted', occurredAt: T(4) }),
      item({ id: 'c', kind: 'pr_comment', commentId: 9, occurredAt: T(3) }), // closer to rB
    ]);
    const rA = items.find((i) => i.id === 'rA')!;
    const rB = items.find((i) => i.id === 'rB')!;
    expect(rA.mergedComments).toEqual([]);
    expect(rB.mergedComments.map((c) => c.commentId)).toEqual([9]);
  });

  it('leaves a standalone comment (no nearby review) as its own row', () => {
    const items = run([
      item({ id: 'c', kind: 'pr_comment', commentId: 9, occurredAt: T(0) }),
      item({ id: 'o', kind: 'pr_opened', occurredAt: T(1) }),
    ]);
    expect(items.map((i) => i.id).sort()).toEqual(['c', 'o']);
  });
});
