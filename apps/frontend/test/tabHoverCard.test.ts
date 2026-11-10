// The open-tabs hover card's facts (lib/tabHoverCard.ts). What this pins:
//   1. ONE key for the shared summary read: the PR tabs' ids, sorted and unique, whatever the order.
//   2. Between the batched summary and the cached detail, the NEWER read wins.
//   3. A lean Open PRs row knows approved / changes requested only: anything else is UNKNOWN
//      (`undefined`, the row is left out), never "Reviews optional".
//   4. With nothing cached, the tab's own label meta is all the card claims.
//   5. Thread states are listed most urgent first, and only those with threads.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/tabHoverCard.test.ts
import { describe, expect, it } from 'vitest';
import type { PrDetail, PrTabSummary, TimelinePr } from '@pierre-review/shared';
import { prTabFacts, prTabIds, reviewDecisionWords, threadStateParts } from '../src/lib/tabHoverCard.js';
import type { Tab, TabMeta } from '../src/store/pinnedTabs.js';

const meta: TabMeta = {
  id: 7,
  number: 12,
  title: 'From the tab',
  repoFullName: 'acme/web',
  authorLogin: 'robin-dev',
  authorDisplayName: null,
  authorAvatarUrl: null,
};

const summary: PrTabSummary = {
  id: 7,
  repoFullName: 'acme/web',
  number: 12,
  title: 'From the summary',
  authorLogin: 'robin-dev',
  authorDisplayName: 'Robin',
  state: 'open',
  isDraft: false,
  ciStatus: 'failure',
  mergeable: 'mergeable',
  mergeStateStatus: 'blocked',
  reviewDecision: 'review_required',
  inMergeQueue: false,
  threadCounts: { resolved: 1, likely_addressed: 0, replied_unresolved: 0, untouched: 2 },
};

const detail = {
  id: 7,
  repoFullName: 'acme/web',
  number: 12,
  title: 'From the detail',
  authorId: 3,
  users: [{ id: 3, githubLogin: 'robin-dev', displayName: 'Robin D', avatarUrl: null, isBot: false }],
  state: 'open',
  isDraft: false,
  ciStatus: 'success',
  mergeable: 'mergeable',
  mergeStateStatus: 'clean',
  reviewDecision: null,
  inMergeQueue: null,
  threads: [{ derivedState: 'likely_addressed' }, { derivedState: 'resolved' }],
} as unknown as PrDetail;

describe('prTabIds', () => {
  it('lists the PR tabs once, sorted', () => {
    const tabs = [
      { kind: 'pr-detail', prId: 9 },
      { kind: 'search', prId: 0 },
      { kind: 'pr-focus', prId: 3 },
      { kind: 'pr-detail', prId: 3 },
      { kind: 'ticket', prId: 0 },
    ] as Array<Pick<Tab, 'kind' | 'prId'>>;
    expect(prTabIds(tabs)).toEqual([3, 9]);
  });
});

describe('prTabFacts', () => {
  it('takes the newer of the summary and the detail', () => {
    const fromSummary = prTabFacts({ meta, summary: { data: summary, at: 200 }, detail: { data: detail, at: 100 } });
    expect(fromSummary).toMatchObject({ title: 'From the summary', ciStatus: 'failure', reviewDecision: 'review_required' });
    expect(fromSummary.threadCounts).toEqual(summary.threadCounts);

    const fromDetail = prTabFacts({ meta, summary: { data: summary, at: 100 }, detail: { data: detail, at: 200 } });
    expect(fromDetail).toMatchObject({
      title: 'From the detail',
      authorDisplayName: 'Robin D',
      ciStatus: 'success',
      reviewDecision: null,
      inMergeQueue: false,
    });
    expect(fromDetail.threadCounts).toEqual({ resolved: 1, likely_addressed: 1, replied_unresolved: 0, untouched: 0 });
  });

  it('reads a lean Open PRs row without inventing a review decision', () => {
    const row = {
      id: 7,
      number: 12,
      title: 'From the list',
      state: 'open',
      isDraft: true,
      ciStatus: 'pending',
      mergeable: 'unknown',
      mergeStateStatus: 'unknown',
      isApproved: false,
      isChangesRequested: false,
      threadCounts: { resolved: 0, likely_addressed: 0, replied_unresolved: 1, untouched: 0 },
    } as unknown as TimelinePr;
    const f = prTabFacts({ meta, openPr: row });
    expect(f).toMatchObject({ repoFullName: 'acme/web', title: 'From the list', isDraft: true, reviewDecision: undefined });
    expect(prTabFacts({ meta, openPr: { ...row, isApproved: true } }).reviewDecision).toBe('approved');
    expect(prTabFacts({ meta, openPr: { ...row, isApproved: true, isChangesRequested: true } }).reviewDecision).toBe(
      'changes_requested',
    );
  });

  it('claims only the label meta when nothing is cached', () => {
    const f = prTabFacts({ meta });
    expect(f).toMatchObject({ repoFullName: 'acme/web', number: 12, authorLogin: 'robin-dev', state: null, ciStatus: null, threadCounts: null });
    expect(f.reviewDecision).toBeUndefined();
  });
});

describe('words', () => {
  it("names GitHub's decision as the PR header does", () => {
    expect(reviewDecisionWords('approved')).toBe('Approved');
    expect(reviewDecisionWords('changes_requested')).toBe('Changes requested');
    expect(reviewDecisionWords('review_required')).toBe('Review required');
    expect(reviewDecisionWords(null)).toBe('Reviews optional');
  });

  it('lists thread states most urgent first, skipping empty ones', () => {
    expect(
      threadStateParts({ resolved: 4, likely_addressed: 1, replied_unresolved: 0, untouched: 2 }).map((p) => [p.label, p.count]),
    ).toEqual([
      ['Untouched', 2],
      ['Likely addressed', 1],
      ['Resolved', 4],
    ]);
    expect(threadStateParts({ resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 })).toEqual([]);
  });
});
