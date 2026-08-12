import { describe, expect, it } from 'vitest';
import type { ConsolidatedFeedItem } from '@pierre-review/shared';
import { coalesceEventComments, computeFeedCounts } from './queries.js';

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
  coalesceEventComments(items, byId);
  // byId must stay consistent with the surviving items.
  expect([...byId.keys()].sort()).toEqual(items.map((i) => i.id).sort());
  return items;
}

const T = (min: number): string => new Date(Date.parse('2026-07-07T12:00:00.000Z') + min * 60_000).toISOString();

describe('coalesceEventComments', () => {
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

  it('leaves a standalone comment as its own row when the only nearby event is not a host', () => {
    // pr_opened is NOT a fold host — "Comment" alone doesn't create it — so the comment stays.
    const items = run([
      item({ id: 'c', kind: 'pr_comment', commentId: 9, occurredAt: T(0) }),
      item({ id: 'o', kind: 'pr_opened', occurredAt: T(1) }),
    ]);
    expect(items.map((i) => i.id).sort()).toEqual(['c', 'o']);
  });

  it('folds a "Comment and close" comment into the pr_closed card', () => {
    const items = run([
      item({ id: 'x', kind: 'pr_closed', occurredAt: T(0) }),
      item({ id: 'c', kind: 'pr_comment', commentId: 7, occurredAt: T(0), content: 'closing — superseded' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['x']);
    expect(items[0]!.mergedComments).toEqual([
      { commentId: 7, content: 'closing — superseded', occurredAt: T(0) },
    ]);
  });

  it('folds a "Comment and merge" comment into the pr_merged card', () => {
    const items = run([
      item({ id: 'm', kind: 'pr_merged', occurredAt: T(1) }),
      item({ id: 'c', kind: 'pr_comment', commentId: 8, occurredAt: T(0), content: 'merging, thanks!' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['m']);
    expect(items[0]!.mergedComments.map((c) => c.commentId)).toEqual([8]);
  });

  it('prefers a review over a lifecycle host when a comment is equidistant from both', () => {
    const items = run([
      item({ id: 'x', kind: 'pr_closed', occurredAt: T(0) }),
      item({ id: 'r', kind: 'review_submitted', occurredAt: T(4) }),
      item({ id: 'c', kind: 'pr_comment', commentId: 9, occurredAt: T(2) }), // 2 min from each
    ]);
    expect(items.find((i) => i.id === 'x')!.mergedComments).toEqual([]);
    expect(items.find((i) => i.id === 'r')!.mergedComments.map((c) => c.commentId)).toEqual([9]);
  });
});

describe('computeFeedCounts', () => {
  it('tallies each facet over the whole stream; total == length', () => {
    const items = [
      item({ id: 'a', kind: 'pr_opened', isMyTurn: true, actorId: 1 }),
      item({ id: 'b', kind: 'review_comment', actorId: 2, threadId: 5, derivedState: 'untouched' }),
      item({ id: 'c', kind: 'pr_comment', actorId: 3 }),
      item({ id: 'd', kind: 'claude_review', actorId: 1 }),
      item({ id: 'e', kind: 'pr_merged', actorId: 9 }), // actor 9 is the only bot
      item({ id: 'f', kind: 'review_comment', actorId: 2, threadId: 6, derivedState: 'untouched' }),
    ];
    const counts = computeFeedCounts(items, new Set([9]), false);
    expect(counts.total).toBe(6);
    expect(counts.myTurn).toBe(1);
    expect(counts.claude).toBe(1);
    expect(counts.comments).toBe(3); // b, c, f
    expect(counts.prEvents).toBe(2); // a (pr_opened) + e (pr_merged)
    expect(counts.bots).toBe(1); // only e's actor 9 is in the global bot set
    expect(counts.byThreadState).toEqual({ untouched: 2 });
    expect(counts.byBotActor).toEqual({}); // not the bot-only feed
  });

  it('populates byBotActor only in the bot-only feed, grouped by actor', () => {
    const items = [
      item({ id: 'a', kind: 'review_submitted', actorId: 7 }),
      item({ id: 'b', kind: 'review_comment', actorId: 7, threadId: 1, derivedState: 'likely_addressed' }),
      item({ id: 'c', kind: 'review_comment', actorId: 8, threadId: 2, derivedState: 'resolved' }),
    ];
    const counts = computeFeedCounts(items, new Set<number>(), true);
    expect(counts.total).toBe(3);
    expect(counts.byBotActor).toEqual({ '7': 2, '8': 1 });
    expect(counts.byThreadState).toEqual({ likely_addressed: 1, resolved: 1 });
  });

  it('is all-zero / empty on an empty stream', () => {
    const counts = computeFeedCounts([], new Set<number>(), false);
    expect(counts).toEqual({
      total: 0,
      myTurn: 0,
      claude: 0,
      comments: 0,
      prEvents: 0,
      commits: 0,
      awaitingReview: 0,
      bots: 0,
      byBotActor: {},
      byThreadState: {},
    });
  });

  it('counts awaitingReview as DISTINCT PRs for pr_opened/pr_ready_for_review flagged prAwaitingReview', () => {
    const items = [
      // A draft-first PR has BOTH kinds in the window (same prId 10, the factory default) —
      // the badge reads as a PR count, so the pair dedupes to one.
      item({ id: 'a', kind: 'pr_opened', prAwaitingReview: true }),
      item({ id: 'b', kind: 'pr_ready_for_review', prAwaitingReview: true }),
      item({ id: 'b2', kind: 'pr_opened', prId: 11, prAwaitingReview: true }),
      item({ id: 'c', kind: 'pr_opened', prId: 12, prAwaitingReview: false }), // reviewed since
      item({ id: 'd', kind: 'pr_opened', prId: 13 }), // no flag attached (stale feed) — not counted
      item({ id: 'e', kind: 'pr_merged', prId: 14, prAwaitingReview: true }), // non-matching kind
    ];
    const counts = computeFeedCounts(items, new Set<number>(), false);
    expect(counts.awaitingReview).toBe(2); // PR 10 (deduped) + PR 11
    expect(counts.prEvents).toBe(6); // the facet stays independent of the flag
  });
});
