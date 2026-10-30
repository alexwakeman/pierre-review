// GO TO THE ITEM — where a double-click on a Pending row (and Shift+Enter, Enter on an open panel,
// the panel's Open, ⌘K "Open …") lands, for every card kind on all seven tabs.
//
// What this pins, and why:
//
//   1. ONE MAPPING. `pendingCardEvent` (lib/pendingHeadings.ts) says WHERE; `pendingActivation`
//      (AttentionCards.tsx) turns it into the ONE board call. A second per-surface switch would let
//      the double-click and the panel's Open disagree.
//   2. THE MOST RELEVANT TAB. A review asked of you opens Changes; a thread lands on the thread
//      (Changes, `showThread`); an AI review on the AI Review tab; red CI, conflicts, ready-to-land and
//      dependency PRs on Overview; a red default branch on Open PRs' Default branches strip, that
//      repo's row open.
//   3. NOTHING IN-APP → GITHUB, THROUGH safeExternalUrl. A red head no local PR names opens its
//      checks page in a new tab. A reviewer's load (several PRs) has nowhere to go: undefined, and the
//      board opens its panel instead.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InsightCard } from '@pierre-review/shared';
import { pendingActivation } from '../src/components/Activity/AttentionCards.js';
import { pendingCardEvent, pendingDestinationLabel } from '../src/lib/pendingHeadings.js';

const pr = {
  prId: 352,
  repoId: 6,
  repoFullName: 'acme/web',
  prNumber: 352,
  prTitle: 'Open project summary',
  authorId: 3,
  githubUrl: 'https://github.com/acme/web/pull/352',
  ciStatus: 'success',
  inMergeQueue: false,
  mergeQueueEntryState: null,
  reviewDecision: null,
  reviewApprovals: 0,
  reviewChangesRequested: false,
  reviewers: [],
  reviewerCount: 0,
  severity: 'warn',
  detail: '',
};

const myTurn = (reason: string, over: Record<string, unknown> = {}): InsightCard =>
  ({ ...pr, id: `mt:${reason}`, kind: 'my_turn', reason, threadId: null, since: '2026-10-01T00:00:00Z', ...over }) as unknown as InsightCard;
const card = (kind: string, over: Record<string, unknown> = {}): InsightCard =>
  ({ ...pr, id: `c:${kind}`, kind, ...over }) as unknown as InsightCard;
const trunkCi = (over: Record<string, unknown> = {}): InsightCard =>
  ({
    id: 'ci:trunk',
    kind: 'ci_failing',
    severity: 'high',
    arm: 'trunk',
    repoId: 6,
    repoFullName: 'acme/web',
    ciStatus: 'failure',
    prId: null,
    prNumber: null,
    prTitle: null,
    headSha: 'f48aec5',
    mergedById: null,
    viewerMerged: false,
    githubUrl: 'https://github.com/acme/web/commit/f48aec5',
    detail: '',
    ...over,
  }) as unknown as InsightCard;

function fakeBoard() {
  const calls: unknown[][] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    board: {
      usersById: new Map(),
      openPr: rec('openPr'),
      openMeta: rec('openMeta'),
      openCi: rec('openCi'),
      openThreadOn: rec('openThreadOn'),
      openComment: rec('openComment'),
      openReview: rec('openReview'),
      openTrunk: rec('openTrunk'),
    },
  };
}

/** What a double-click on this card does: [board call, its notable argument]. */
function go(c: InsightCard): { label: string | null; call: unknown[] | null } {
  const { calls, board } = fakeBoard();
  const a = pendingActivation(c, board);
  a?.run();
  const call = calls[0] ?? null;
  return { label: a?.label ?? null, call: call == null ? null : summarise(call) };
}
function summarise([name, ...args]: unknown[]): unknown[] {
  switch (name) {
    case 'openPr':
      return [name, args[1]];
    case 'openThreadOn':
      return [name, args[1]];
    case 'openMeta':
    case 'openCi':
      return [name, (args[0] as { id: number }).id];
    default:
      return [name, ...args.filter((x) => typeof x === 'number')];
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('My turn', () => {
  it('a review asked of you → Changes', () => {
    expect(go(myTurn('review_request'))).toEqual({ label: 'Open changes', call: ['openPr', 'changes'] });
  });
  it('a thread (reply needed, a reply on yours) → Changes with that thread shown', () => {
    for (const r of ['thread', 'thread_reply', 'own_thread']) {
      expect(go(myTurn(r, { threadId: 41 }))).toEqual({ label: 'Open thread', call: ['openThreadOn', 41] });
    }
  });
  it('a comment that names itself lands on it; one that does not, on Comments', () => {
    expect(go(myTurn('mention', { comment: { kind: 'issue_comment', id: 9 } })).call?.[0]).toBe('openComment');
    expect(go(myTurn('mention'))).toEqual({ label: 'Open PR', call: ['openPr', 'comments'] });
  });
  it('red CI on your PR, your ready / conflicting / approved PR → Overview', () => {
    for (const r of ['own_ci_red', 'own_ready', 'own_conflicts', 'pr_approved']) {
      expect(go(myTurn(r))).toEqual({ label: 'Open PR', call: ['openPr', 'overview'] });
    }
  });
  it('new commits on a PR you reviewed → Overview with Activity open', () => {
    expect(go(myTurn('pushed_since')).call).toEqual(['openPr', 'activity']);
  });
  it('a red default branch → Open PRs, that repo’s Default branches row', () => {
    const t = myTurn('trunk_red', { repoId: 6, prId: null, prNumber: null, prTitle: null, githubUrl: 'https://github.com/acme/web/commit/f48aec5' });
    expect(pendingCardEvent(t)).toEqual({ kind: 'trunk', repoId: 6 });
    expect(go(t)).toEqual({ label: 'Open default branch', call: ['openTrunk', 6] });
  });
});

describe('AI reviews', () => {
  it('an AI review → the AI Review tab', () => {
    expect(go(myTurn('claude_review'))).toEqual({ label: 'Open review', call: ['openReview'] });
  });
});

describe('Needs fixing', () => {
  it('main is red → the trunk view, never GitHub', () => {
    expect(go(trunkCi())).toEqual({ label: 'Open default branch', call: ['openTrunk', 6] });
  });
  it('a red PR → its CI check (AI Review tab with Fix with AI; Overview when AI is off)', () => {
    const c = trunkCi({ arm: 'your_pr', prId: 5, prNumber: 5, prTitle: 'Fix it', githubUrl: 'https://github.com/acme/web/pull/5' });
    expect(go(c)).toEqual({ label: 'Open CI check', call: ['openCi', 5] });
  });
  it('a red PR no local PR names → its checks page on GitHub, in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open, location: { origin: 'http://localhost' } });
    const c = trunkCi({ arm: 'your_pr', githubUrl: 'https://github.com/acme/web/pull/5' });
    expect(go(c)).toEqual({ label: 'Open on GitHub', call: null });
    expect(open).toHaveBeenCalledWith('https://github.com/acme/web/pull/5/checks', '_blank', 'noopener,noreferrer');
  });
  it('a hostile URL never reaches window.open', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open, location: { origin: 'http://localhost' } });
    expect(go(trunkCi({ arm: 'your_pr', githubUrl: 'javascript:alert(1)' })).label).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
  it('merge conflicts → Overview', () => {
    expect(go(card('conflicts')).call).toEqual(['openPr', 'overview']);
  });
});

describe('Waiting on review', () => {
  it('a stalled review / nobody asked → Overview', () => {
    expect(go(card('stalled_review')).call).toEqual(['openPr', 'overview']);
    expect(go(card('reviewer_routing')).call).toEqual(['openPr', 'overview']);
  });
  it('a reviewer’s load (several PRs) has nowhere to go — the panel is the destination', () => {
    const c = { id: 'l', kind: 'reviewer_load', severity: 'info', reviewerId: 4, pendingCount: 2, pendingPrs: [] } as unknown as InsightCard;
    expect(pendingDestinationLabel(pendingCardEvent(c))).toBeNull();
    expect(go(c)).toEqual({ label: null, call: null });
  });
});

describe('Unanswered threads', () => {
  it('→ Changes with that thread shown', () => {
    expect(go(card('untouched_thread', { threadId: 11 }))).toEqual({ label: 'Open thread', call: ['openThreadOn', 11] });
  });
});

describe('Ready to land and Dependencies', () => {
  it('→ Overview', () => {
    for (const k of ['merge', 'update_branch', 'security', 'dependency_bump']) {
      expect(go(card(k)).call).toEqual(['openPr', 'overview']);
    }
  });
});
