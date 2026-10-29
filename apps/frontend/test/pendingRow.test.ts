// The Pending inbox's one-line row — `components/Activity/pendingRow.ts`.
//
// WHAT THIS PINS:
//   1. THE COLOUR RULE. A row's mark is red only when the item BLOCKS (a failing build, a merge
//      conflict, a security alert), green only when it can LAND, amber only for an urgent item that
//      does neither, grey otherwise — never red for "draft", never green for "comment".
//   2. THE ROW SAYS WHICH PR. The title is the PR's (the card's own heading for a branch or a
//      person), with `repo#N`, the size, the author and the heading's own clock.
//   3. THE KEYS ACT ONLY WHERE THEY MAY. `e` only on My turn; `a` only on a review asked of the
//      reader, never on their own PR.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { InsightCard } from '@pierre-review/shared';
import {
  approveOffered,
  dismissTargetOf,
  pendingRowSummary,
  pendingRowTone,
  reasonColumnShown,
} from '../src/components/Activity/pendingRow.js';

const pr = {
  prId: 7,
  repoId: 1,
  repoFullName: 'acme/api',
  prNumber: 12,
  prTitle: 'Retry the upload',
  authorId: 2,
  githubUrl: 'https://github.com/acme/api/pull/12',
  ciStatus: 'success',
  changedFiles: 3,
  additions: 40,
  deletions: 8,
  openedAt: '2026-10-01T00:00:00Z',
  authorIsBot: false,
  authorBotKind: null,
  automation: null,
  inMergeQueue: null,
  mergeQueueEntryState: null,
  reviewDecision: null,
  reviewApprovals: 0,
  reviewChangesRequested: false,
  reviewers: [],
  reviewerCount: 0,
};

const card = (o: Record<string, unknown>): InsightCard => ({ id: 'c', severity: 'info', ...pr, ...o }) as unknown as InsightCard;
const myTurn = (reason: string, o: Record<string, unknown> = {}): InsightCard =>
  card({ kind: 'my_turn', reason, threadId: null, since: '2026-10-28T00:00:00Z', ...o });
const ctx = { nameOf: (id: number | null | undefined) => (id === 2 ? 'Priya Nair' : null), sharedOwner: 'acme' };

describe('the colour rule', () => {
  it('red for what blocks', () => {
    expect(pendingRowTone(card({ kind: 'conflicts' }))).toBe('blocked');
    expect(pendingRowTone(card({ kind: 'ci_failing', arm: 'your_pr' }))).toBe('blocked');
    expect(pendingRowTone(myTurn('own_ci_red'))).toBe('blocked');
    expect(pendingRowTone(myTurn('own_conflicts'))).toBe('blocked');
    expect(pendingRowTone(card({ kind: 'security', fix: null, dependencyUpdate: false, depState: null }))).toBe('blocked');
    expect(pendingRowTone(card({ kind: 'dependency_bump', depState: 'ci_red' }))).toBe('blocked');
  });
  it('green for what can land', () => {
    expect(pendingRowTone(card({ kind: 'merge' }))).toBe('ready');
    expect(pendingRowTone(myTurn('pr_approved'))).toBe('ready');
    expect(pendingRowTone(myTurn('own_ready', { own: { kind: 'ready', forward: 'merge' } }))).toBe('ready');
    expect(pendingRowTone(card({ kind: 'dependency_bump', depState: 'ready' }))).toBe('ready');
  });
  it('behind trunk is neither: it needs an update first', () => {
    expect(pendingRowTone(card({ kind: 'update_branch' }))).toBe('neutral');
    expect(pendingRowTone(myTurn('own_ready', { own: { kind: 'ready', forward: 'update_branch' } }))).toBe('neutral');
  });
  it('amber only for an urgent item that neither blocks nor lands; grey otherwise', () => {
    expect(pendingRowTone(myTurn('review_request', { severity: 'high' }))).toBe('urgent');
    expect(pendingRowTone(myTurn('review_request', { severity: 'warn' }))).toBe('neutral');
    expect(pendingRowTone(card({ kind: 'conflicts', severity: 'high' }))).toBe('blocked');
    expect(pendingRowTone(card({ kind: 'merge', severity: 'high' }))).toBe('ready');
  });
});

describe('the row', () => {
  it('names the PR, its size, its author and the heading’s clock', () => {
    const s = pendingRowSummary(myTurn('review_request'), ctx);
    expect(s.title).toBe('Retry the upload');
    expect(s.ref).toBe('api#12');
    expect(s.size).toBe('+40 −8');
    expect(s.author).toBe('Priya Nair');
    expect(s.reason).toBe('Review requested');
  });
  it('drops the reason column when every row shares one', () => {
    expect(reasonColumnShown(['Ready to merge', 'Ready to merge'])).toBe(false);
    expect(reasonColumnShown(['Ready to merge', 'Behind trunk'])).toBe(true);
  });
});

describe('the keys', () => {
  it('`e` dismisses only from My turn, a branch card by its repo', () => {
    expect(dismissTargetOf(myTurn('review_request'))).toEqual({ target: { kind: 'pr', id: 7 }, label: 'acme/api #12' });
    expect(dismissTargetOf(myTurn('trunk_red'))).toEqual({ target: { kind: 'repo', id: 1 }, label: 'acme/api' });
    expect(dismissTargetOf(card({ kind: 'merge' }))).toBeNull();
  });
  it('`a` approves only a review asked of the reader, never their own PR', () => {
    expect(approveOffered(myTurn('review_request'), 9)).toBe(true);
    expect(approveOffered(myTurn('pushed_since'), 9)).toBe(true);
    expect(approveOffered(myTurn('review_request'), 2)).toBe(false);
    expect(approveOffered(myTurn('thread'), 9)).toBe(false);
    expect(approveOffered(card({ kind: 'stalled_review' }), 9)).toBe(false);
  });
});
