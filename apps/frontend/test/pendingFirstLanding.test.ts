import { describe, expect, it } from 'vitest';
import type { PendingOwnPr, PendingTab, PendingTabKey } from '@pierre-review/shared';
import { ownPrVerdict, pendingBoardEmpty, pendingSummaryParts } from '../src/lib/pendingFirstLanding.js';
import { tabBadgeCount } from '../src/components/Activity/pendingTabs.js';

// Pending on the first landing: the summary line's figures ARE the tabs' own counts, the empty-board
// test reads the totals, and an own PR's line is the plain mergeVerdict() over synced fields.

const tab = (key: PendingTabKey, total: number, people = total, automation = 0): PendingTab => ({
  key,
  total,
  kindTotals: {},
  cardIds: [],
  authorTotals: { people, automation },
});

const TABS: PendingTab[] = [
  tab('my_turn', 3, 3, 0),
  tab('claude', 1, 1, 0),
  tab('fixing', 2, 1, 1),
  tab('review', 0),
  tab('threads', 1, 1, 0),
  tab('land', 0),
  tab('deps', 4, 0, 4),
];

describe('pendingSummaryParts', () => {
  it('one part per non-empty tab, in tab order, each figure the tab badge', () => {
    const parts = pendingSummaryParts(TABS, null);
    expect(parts.map((p) => p.tab)).toEqual(['my_turn', 'claude', 'fixing', 'threads', 'deps']);
    for (const p of parts) expect(p.count).toBe(tabBadgeCount(TABS.find((t) => t.key === p.tab)!, null));
    expect(parts.map((p) => p.text)).toEqual([
      '3 waiting on you',
      '1 AI review to read',
      '2 to fix',
      '1 unanswered thread',
      '4 dependency updates',
    ]);
  });

  it('under the author lens each figure is that side of its tab — the badge on screen', () => {
    const parts = pendingSummaryParts(TABS, 'automation');
    expect(parts.map((p) => [p.tab, p.count])).toEqual([
      ['fixing', 1],
      ['deps', 4],
    ]);
    for (const p of parts) expect(p.count).toBe(tabBadgeCount(TABS.find((t) => t.key === p.tab)!, 'automation'));
  });

  it('says nothing when every tab is empty', () => {
    expect(pendingSummaryParts(TABS.map((t) => ({ ...t, total: 0, authorTotals: { people: 0, automation: 0 } })), null)).toEqual([]);
  });
});

describe('pendingBoardEmpty', () => {
  it('reads the totals', () => {
    expect(pendingBoardEmpty(TABS)).toBe(false);
    expect(pendingBoardEmpty(TABS.map((t) => ({ ...t, total: 0 })))).toBe(true);
    expect(pendingBoardEmpty([])).toBe(false);
  });
});

const PR: PendingOwnPr = {
  prId: 1,
  repoId: 1,
  repoFullName: 'acme/api',
  number: 7,
  title: 'Add audit log',
  githubUrl: 'https://github.com/acme/api/pull/7',
  isDraft: false,
  mergeable: 'mergeable',
  mergeStateStatus: 'blocked',
  inMergeQueue: false,
  openedAt: '2026-10-30T10:00:00.000Z',
};

describe('ownPrVerdict', () => {
  it('a blocked PR reads the plain verdict — never the ranked blockers (PR detail only)', () => {
    const { verdict, lines } = ownPrVerdict(PR);
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.label).toBe('blocked');
    expect(verdict.blockers).toBeUndefined();
    // The generic sentence mergeVerdict gives without facts, and nothing else.
    expect(lines).toEqual([verdict.detail]);
  });

  it('a draft, a conflict, a behind and a failing-checks PR say so; a clean PR has no line', () => {
    expect(ownPrVerdict({ ...PR, isDraft: true }).verdict.verdict).toBe('draft');
    expect(ownPrVerdict({ ...PR, mergeStateStatus: 'dirty', mergeable: 'conflicting' }).verdict.label).toBe('conflicts');
    expect(ownPrVerdict({ ...PR, mergeStateStatus: 'behind' }).verdict.label).toBe('behind base');
    expect(ownPrVerdict({ ...PR, mergeStateStatus: 'unstable' }).verdict.label).toBe('checks failing');
    const clean = ownPrVerdict({ ...PR, mergeStateStatus: 'clean' });
    expect(clean.verdict.verdict).toBe('clean');
    expect(clean.verdict.label).toBe('ready to merge');
    expect(clean.lines).toEqual([]);
  });
});
