// The Pending board's TABS, as the SPA folds them — `pendingTabs.ts`.
//
// WHAT THIS PINS, and why each is worth a test rather than a comment:
//
//   1. THE TAB ON SCREEN IS DERIVED. A daily-brief line seats only a KIND; its tab follows from it.
//      Clicking a tab seats the tab and clears the kind. Writing the derived tab back would make
//      the two disagree the first time either changed.
//   2. THE ORDER IS THE SERVER'S. The view filters and caps; it never re-sorts. Do next is the
//      first `PENDING_DO_NEXT_SIZE` of whatever is on screen.
//   3. EVERY VIEW'S COUNT IS ITS OWN POPULATION. The whole tab says `tab.total`, a kind chip says
//      that kind's total, "Only yours" says the personal total — and "Showing X of Y" pairs the
//      list on screen with exactly that figure. One view borrowing another's denominator is the
//      two-populations-in-one-row defect.
//   4. THE WHOLE-TAB VIEW IS CAPPED TO THE TAB'S TRUE TOP. The server lists up to `boardListCap`
//      PER KIND, so beyond the first `boardListCap` of the union the list has gaps.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  PENDING_DO_NEXT_SIZE,
  PENDING_LIMITS,
  type AttentionCardsResponse,
  type DailyBriefCounts,
  type InsightCard,
  type PendingTab,
} from '@pierre-review/shared';
import { shouldShowDivider } from '../src/components/Activity/AttentionCards.js';
import {
  buildPendingView,
  effectivePendingTab,
  offerOnlyYours,
  tabsOf,
} from '../src/components/Activity/pendingTabs.js';
import {
  activeWorkspaceBadge,
  workspaceCapDisclosure,
  type WorkspaceMyTurnLine,
} from '../src/hooks/useMyTurnByWorkspace.js';

const card = (id: string, kind: InsightCard['kind'], over: Record<string, unknown> = {}): InsightCard =>
  ({ id, kind, severity: 'info', ...over }) as unknown as InsightCard;

function tab(over: Partial<PendingTab> & Pick<PendingTab, 'key'>): PendingTab {
  return { total: 0, kindTotals: {}, cardIds: [], ...over };
}

function response(cards: InsightCard[], tabs: PendingTab[]): AttentionCardsResponse {
  return { cards, users: [], tabs };
}

describe('the tab on screen', () => {
  it('is My turn by default', () => {
    expect(effectivePendingTab(null, null)).toBe('my_turn');
  });

  it('is the tab the reader picked', () => {
    expect(effectivePendingTab(null, 'land')).toBe('land');
  });

  it('is the kind filter’s own tab, whatever was picked — a brief line seats only the kind', () => {
    expect(effectivePendingTab('stalled_review', null)).toBe('review');
    expect(effectivePendingTab('reviewer_routing', 'land')).toBe('review');
    expect(effectivePendingTab('conflicts', null)).toBe('fixing');
    expect(effectivePendingTab('my_turn', 'threads')).toBe('my_turn');
  });

  it('ignores a kind that belongs to no tab', () => {
    expect(effectivePendingTab('bot_signal', 'threads')).toBe('threads');
  });
});

describe('a tab’s list', () => {
  const cards = [
    card('s1', 'stalled_review'),
    card('r1', 'reviewer_routing'),
    card('s2', 'stalled_review'),
    card('r2', 'reviewer_routing'),
    card('r3', 'reviewer_routing'),
    card('r4', 'reviewer_routing'),
    card('r5', 'reviewer_routing'),
    card('r6', 'reviewer_routing'),
    card('load', 'reviewer_load'),
  ];
  const data = response(cards, [
    tab({
      key: 'review',
      total: 90,
      kindTotals: { stalled_review: 2, reviewer_routing: 88 },
      // Score order, as the server sends it.
      cardIds: ['s1', 'r1', 's2', 'r2', 'r3', 'r4', 'r5', 'r6'],
      peopleCardIds: ['load'],
    }),
  ]);

  it('keeps the server’s order and marks the first few as Do next', () => {
    const v = buildPendingView(data, 'review', null, null);
    expect(v.cards.map((c) => c.id)).toEqual(['s1', 'r1', 's2', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(v.doNextCount).toBe(PENDING_DO_NEXT_SIZE);
  });

  it('pairs the whole-tab list with the tab’s own total', () => {
    const v = buildPendingView(data, 'review', null, null);
    expect([v.shown, v.total]).toEqual([8, 90]);
  });

  it('narrows to a kind chip, keeping order, with THAT kind’s total', () => {
    const v = buildPendingView(data, 'review', 'reviewer_routing', null);
    expect(v.kind).toBe('reviewer_routing');
    expect(v.cards.map((c) => c.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect([v.shown, v.total]).toEqual([6, 88]);
    // Do next is the top of what is ON SCREEN, not of the unfiltered tab.
    expect(v.doNextCount).toBe(PENDING_DO_NEXT_SIZE);
    const s = buildPendingView(data, 'review', 'stalled_review', null);
    expect(s.cards.map((c) => c.id)).toEqual(['s1', 's2']);
    expect(s.doNextCount).toBe(2);
  });

  it('offers a chip per kind, with each kind’s total, and puts review load in the people strip', () => {
    const v = buildPendingView(data, 'review', null, null);
    expect(v.chips).toEqual([
      { kind: 'stalled_review', total: 2 },
      { kind: 'reviewer_routing', total: 88 },
    ]);
    expect(v.people.map((c) => c.id)).toEqual(['load']);
    expect(v.cards.some((c) => c.kind === 'reviewer_load')).toBe(false);
  });

  it('ignores a kind filter that belongs to another tab', () => {
    const v = buildPendingView(data, 'review', 'merge', null);
    expect(v.kind).toBeNull();
    expect(v.shown).toBe(8);
  });

  it(`caps the whole-tab list at the tab’s true top ${PENDING_LIMITS.boardListCap}`, () => {
    const many = Array.from({ length: PENDING_LIMITS.boardListCap + 10 }, (_, i) =>
      card(`m${i}`, i % 2 === 0 ? 'merge' : 'update_branch'),
    );
    const d = response(many, [
      tab({
        key: 'land',
        total: 200,
        kindTotals: { merge: 100, update_branch: 100 },
        cardIds: many.map((c) => c.id),
      }),
    ]);
    const all = buildPendingView(d, 'land', null, null);
    expect(all.shown).toBe(PENDING_LIMITS.boardListCap);
    expect(all.cards[0]!.id).toBe('m0');
    // A chip shows every card the server listed of that kind.
    expect(buildPendingView(d, 'land', 'merge', null).shown).toBe(30);
  });
});

describe('My turn’s “Only yours”', () => {
  const cards = [
    card('a', 'my_turn', { personal: true, relevance: 'direct' }),
    card('b', 'my_turn', { personal: false, relevance: 'none' }),
    card('c', 'my_turn', { personal: true, relevance: 'maintained' }),
  ];
  const myTurn = tab({
    key: 'my_turn',
    total: 120,
    kindTotals: { my_turn: 120 },
    cardIds: ['a', 'b', 'c'],
    relevanceTotals: { mine: 70, others: 50 },
  });
  const data = response(cards, [myTurn]);

  it('narrows to the personal items with the PERSONAL total', () => {
    const v = buildPendingView(data, 'my_turn', null, 'mine');
    expect(v.cards.map((c) => c.id)).toEqual(['a', 'c']);
    expect(v.total).toBe(70);
  });

  it('and the complement to the others, with ITS total', () => {
    const v = buildPendingView(data, 'my_turn', null, 'others');
    expect(v.cards.map((c) => c.id)).toEqual(['b']);
    expect(v.total).toBe(50);
  });

  it('never narrows another tab', () => {
    const d = response([card('x', 'merge')], [tab({ key: 'land', total: 1, kindTotals: { merge: 1 }, cardIds: ['x'] })]);
    expect(buildPendingView(d, 'land', null, 'mine').shown).toBe(1);
  });

  it('is offered only when it would change the list — or is already on', () => {
    expect(offerOnlyYours(myTurn, null)).toBe(true);
    expect(offerOnlyYours({ ...myTurn, relevanceTotals: { mine: 0, others: 9 } }, null)).toBe(false);
    expect(offerOnlyYours({ ...myTurn, relevanceTotals: { mine: 9, others: 0 } }, null)).toBe(false);
    expect(offerOnlyYours({ ...myTurn, relevanceTotals: { mine: 0, others: 9 } }, 'mine')).toBe(true);
  });
});

describe('a response from a server that predates tabs', () => {
  it('still gets five tabs, built from its cards by kind, in the order sent', () => {
    const cards = [card('m', 'merge'), card('t', 'my_turn'), card('u', 'update_branch'), card('l', 'reviewer_load')];
    const tabs = tabsOf({ cards, users: [] });
    expect(tabs.map((t) => t.key)).toEqual(['my_turn', 'fixing', 'review', 'threads', 'land']);
    expect(tabs.find((t) => t.key === 'land')!.cardIds).toEqual(['m', 'u']);
    expect(tabs.find((t) => t.key === 'review')!.peopleCardIds).toEqual(['l']);
  });
});

describe('the divider', () => {
  it('renders between Do next and the rest, only when both are non-empty', () => {
    expect(shouldShowDivider(5, 8)).toBe(true);
    expect(shouldShowDivider(5, 5)).toBe(false);
    expect(shouldShowDivider(0, 8)).toBe(false);
    expect(shouldShowDivider(undefined, 8)).toBe(false);
  });
});

// ── THE WORKSPACE PICKER'S COLLAPSED BADGE ───────────────────────────────────────────────────
//
// THE BUG: that badge rendered `elsewhereCount` — the sum over the OTHER workspaces — six pixels
// from the ACTIVE workspace's name. Standing in Default with ten items waiting in BNG, the control
// read "Default 10" and the reader took the 10 for Default's. A number against a name has to be
// that name's number, so the badge is now the active line's own figure.
//
//   ⚠ IT IS THE CAPPED CARD COUNT. `count` is what the board paints (50); `cap.total` is the
//     uncapped population (180). Printing 180 beside a board of 50 is the silent-cap defect from
//     the other direction, so the badge shows 50 with a "+" and the exact pair in its title.
//   ⚠ AND IT STAYS ON THE PERSONAL POPULATION, because this badge NOTIFIES — the rule the brief's
//     broad count and this narrow one have always split on.
const counts = (over: Partial<DailyBriefCounts>): DailyBriefCounts =>
  ({ myTurn: 0, ...over }) as DailyBriefCounts;

const activeLine = (c: DailyBriefCounts, name = 'Platform'): WorkspaceMyTurnLine => ({
  workspaceId: 3,
  name,
  isActive: true,
  count: c.myTurnPersonal ?? c.myTurn,
  cap: workspaceCapDisclosure(c, true, name),
  split: null,
  fresh: true,
});

describe('the active-Workspace badge', () => {
  it('renders the capped count with a “+” when the fold is capped', () => {
    const badge = activeWorkspaceBadge(
      activeLine(counts({ myTurn: 50, myTurnTotal: 180, myTurnPersonal: 50, myTurnPersonalTotal: 180 })),
    );
    expect(badge).toEqual({ count: 50, cappedTotal: 180 });
  });

  it('renders a bare number when nothing was capped', () => {
    const badge = activeWorkspaceBadge(
      activeLine(counts({ myTurn: 4, myTurnTotal: 4, myTurnPersonal: 4, myTurnPersonalTotal: 4 })),
    );
    expect(badge).toEqual({ count: 4, cappedTotal: null });
  });

  it('⚠ COUNTS THE PERSONAL SUBSET, not the board’s broad population', () => {
    // The shape of a real workspace: 50 my-turn cards on the board, none of them tied to the
    // reader. The board still paints all fifty — they do need a review — but nothing here summons
    // anybody, so the badge is absent rather than showing a 50 nobody asked to be interrupted by.
    const badge = activeWorkspaceBadge(
      activeLine(counts({ myTurn: 50, myTurnTotal: 180, myTurnPersonal: 0, myTurnPersonalTotal: 0 })),
    );
    expect(badge).toBeNull();
  });

  it('renders nothing at zero, and nothing before the brief lands', () => {
    expect(activeWorkspaceBadge(activeLine(counts({ myTurn: 0 })))).toBeNull();
    // ⚠ "not counted yet" is not "counted, and it is none" — but both render nothing, and only the
    // dropdown's per-row "—" distinguishes them, where the distinction is about another workspace.
    expect(activeWorkspaceBadge(null)).toBeNull();
  });
});
