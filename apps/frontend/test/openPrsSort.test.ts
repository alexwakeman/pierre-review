// THE OPEN PRs CARDS' SORT MENU — the pure half (lib/openPrsSort.ts). The cards carry no column
// headings, so every order the old headers offered must still be reachable from the menu, the
// trigger must say the order on screen, and a Claude order must not outlive Claude Review.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/openPrsSort.test.ts
import { describe, expect, it } from 'vitest';
import type { ClaudeReviewPrState, TimelinePr, User } from '@pierre-review/shared';
import {
  OPEN_PRS_SORT_OPTIONS,
  effectiveSort,
  pickSort,
  reverseSort,
  sortLabel,
  sortOpenPrs,
  sortOptionsFor,
} from '../src/lib/openPrsSort.js';

const pr = (over: Partial<TimelinePr>): TimelinePr =>
  ({
    id: 1,
    repoId: 1,
    number: 1,
    title: 't',
    authorId: null,
    state: 'open',
    isDraft: false,
    openedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    threadCounts: { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 },
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ciStatus: 'success',
    isApproved: false,
    isChangesRequested: false,
    ...over,
  }) as TimelinePr;

const ctx = {
  usersById: new Map<number, User>(),
  repoNameById: new Map<number, string>(),
  claudeStates: new Map<number, ClaudeReviewPrState>(),
};

describe('the menu', () => {
  it('offers every key the old column headers did', () => {
    expect(OPEN_PRS_SORT_OPTIONS.map((o) => o.key).sort()).toEqual(
      ['age', 'approval', 'author', 'ci', 'claude', 'findings', 'loc', 'pr', 'repo', 'threads', 'updated'],
    );
  });
  it('hides the Claude keys without Claude Review, and drops a stale Claude order', () => {
    expect(sortOptionsFor(false).some((o) => o.key === 'claude' || o.key === 'findings')).toBe(false);
    expect(sortOptionsFor(true).some((o) => o.key === 'findings')).toBe(true);
    expect(effectiveSort({ key: 'findings', dir: 'desc' }, false)).toBeNull();
    expect(effectiveSort({ key: 'findings', dir: 'desc' }, true)).toEqual({ key: 'findings', dir: 'desc' });
    expect(effectiveSort({ key: 'age', dir: 'asc' }, false)).toEqual({ key: 'age', dir: 'asc' });
  });
  it('the trigger says the order on screen, both ways round', () => {
    expect(sortLabel(null)).toBe('Recent activity');
    expect(sortLabel(pickSort('age'))).toBe('Opened, oldest first');
    expect(sortLabel(reverseSort(pickSort('age')))).toBe('Opened, newest first');
    expect(sortLabel(pickSort('ci'))).toBe('CI, failing first');
  });
});

describe('the order', () => {
  it('sorts by the key and breaks ties on the highest PR number', () => {
    const a = pr({ id: 1, number: 5, additions: 10 });
    const b = pr({ id: 2, number: 9, additions: 300 });
    const c = pr({ id: 3, number: 7, additions: 10 });
    expect(sortOpenPrs([a, b, c], pickSort('loc'), ctx).map((p) => p.number)).toEqual([9, 7, 5]);
    expect(sortOpenPrs([a, b, c], reverseSort(pickSort('loc')), ctx).map((p) => p.number)).toEqual([7, 5, 9]);
  });
  it('failing CI and requested changes lead their natural orders', () => {
    const ok = pr({ id: 1, number: 1 });
    const red = pr({ id: 2, number: 2, ciStatus: 'failure', isChangesRequested: true });
    expect(sortOpenPrs([ok, red], pickSort('ci'), ctx)[0]).toBe(red);
    expect(sortOpenPrs([ok, red], pickSort('approval'), ctx)[0]).toBe(red);
  });
  it('a PR with no finished run sorts below a clean one on findings', () => {
    const none = pr({ id: 1, number: 1 });
    const clean = pr({ id: 2, number: 2 });
    const claudeStates = new Map<number, ClaudeReviewPrState>([
      [2, { prId: 2, reviewId: 1, status: 'succeeded', verdict: 'APPROVE', reviewedHeadSha: 'a', finishedAt: null, ticket: null, headMoved: false, summary: { findings: { blocker: 0, warning: 0, nit: 0, question: 0, praise: 0 }, lenses: {}, postedFindings: 0, reviewPosted: false, tickets: [], followUp: null } }],
    ]);
    expect(sortOpenPrs([none, clean], pickSort('findings'), { ...ctx, claudeStates })[0]).toBe(clean);
  });
});
