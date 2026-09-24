// The Pending board's TABS, as the SPA folds them — `pendingTabs.ts`.
//
// WHAT THIS PINS, and why each is worth a test rather than a comment:
//
//   1. THE TAB ON SCREEN IS DERIVED. An entry point seats only a KIND; its tab follows from it.
//      Clicking a tab seats the tab and clears the kind. Writing the derived tab back would make
//      the two disagree the first time either changed. My turn's VIEW is derived the same way.
//   2. THE ORDER IS THE SERVER'S. The view filters and caps; it never re-sorts. Do next is the
//      first `PENDING_DO_NEXT_SIZE` of whatever is on screen.
//   3. EVERY VIEW'S COUNT IS ITS OWN POPULATION. The whole tab says `tab.total`, a kind chip says
//      that kind's total, "Only yours" says the personal total — and "Showing X of Y" pairs the
//      list on screen with exactly that figure. One view borrowing another's denominator is the
//      two-populations-in-one-row defect.
//   4. EVERY VIEW IS CAPPED TO ITS TRUE TOP. The server lists up to `boardListCap` per LIST GROUP
//      (kind × My turn's side × who opened it), so beyond the first `boardListCap` of a union of
//      groups the list has gaps.
//   5. THE PEOPLE / AUTOMATION LENS IS THE SERVER'S. It filters by `pendingAuthorSideOf`, and every
//      figure under it — a tab badge, a chip, "Only yours", the pills — is the server's own split of
//      exactly that view, never `total − other`.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  PENDING_DO_NEXT_SIZE,
  PENDING_LIMITS,
  type AttentionCardsResponse,
  type PrAutomation,
  type DailyBriefCounts,
  type InsightCard,
  type PendingTab,
} from '@pierre-review/shared';
import { shouldShowDivider } from '../src/components/Activity/AttentionCards.js';
import {
  buildPendingView,
  effectiveMyTurnView,
  effectivePendingTab,
  MY_TURN_VIEW_LABEL,
  MY_TURN_VIEWS,
  offerAuthorLens,
  offerOnlyYours,
  passesAuthorLens,
  passesLens,
  relevancePillCount,
  tabBadgeCount,
  tabsOf,
  TAB_LABEL,
} from '../src/components/Activity/pendingTabs.js';
import { pendingEmptyNote } from '../src/components/Activity/AttentionView.js';
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

  it('is the kind filter’s own tab, whatever was picked — an entry point seats only the kind', () => {
    expect(effectivePendingTab('stalled_review', null)).toBe('review');
    expect(effectivePendingTab('reviewer_routing', 'land')).toBe('review');
    expect(effectivePendingTab('conflicts', null)).toBe('fixing');
    expect(effectivePendingTab('my_turn', 'threads')).toBe('my_turn');
  });

  it('ignores a kind that belongs to no tab', () => {
    expect(effectivePendingTab('bot_signal', 'threads')).toBe('threads');
  });
});

// My turn's two views — a client view inside the `my_turn` tab, derived exactly like the tab.
describe('the view on screen inside My turn', () => {
  it('is branches only on My turn with branches picked', () => {
    expect(effectiveMyTurnView('my_turn', 'branches')).toBe('branches');
  });

  it('is Cards by default, and on every other tab whatever the store holds', () => {
    expect(effectiveMyTurnView('my_turn', null)).toBe('cards');
    expect(effectiveMyTurnView('my_turn', 'cards')).toBe('cards');
    // A hand-edited `?attnTab=deps&attnView=branches` seats both raw; the render derives.
    expect(effectiveMyTurnView('deps', 'branches')).toBe('cards');
  });

  it('lists the two views in strip order', () => {
    expect(MY_TURN_VIEWS).toEqual(['cards', 'branches']);
  });

  it('⚠ no label carries a figure or says "My turn"', () => {
    // Count-free: the branches view is trunk status, which is informational. And the e2e suite's
    // `/My turn/` tab locator must stay unique.
    for (const label of Object.values(MY_TURN_VIEW_LABEL)) {
      expect(label).not.toMatch(/\d/);
      expect(label).not.toMatch(/my turn/i);
    }
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
    const v = buildPendingView(data, 'review', null, null, null);
    expect(v.cards.map((c) => c.id)).toEqual(['s1', 'r1', 's2', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(v.doNextCount).toBe(PENDING_DO_NEXT_SIZE);
  });

  it('pairs the whole-tab list with the tab’s own total', () => {
    const v = buildPendingView(data, 'review', null, null, null);
    expect([v.shown, v.total]).toEqual([8, 90]);
  });

  it('narrows to a kind chip, keeping order, with THAT kind’s total', () => {
    const v = buildPendingView(data, 'review', 'reviewer_routing', null, null);
    expect(v.kind).toBe('reviewer_routing');
    expect(v.cards.map((c) => c.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect([v.shown, v.total]).toEqual([6, 88]);
    // Do next is the top of what is ON SCREEN, not of the unfiltered tab.
    expect(v.doNextCount).toBe(PENDING_DO_NEXT_SIZE);
    const s = buildPendingView(data, 'review', 'stalled_review', null, null);
    expect(s.cards.map((c) => c.id)).toEqual(['s1', 's2']);
    expect(s.doNextCount).toBe(2);
  });

  it('offers a chip per kind, with each kind’s total, and puts review load in the people strip', () => {
    const v = buildPendingView(data, 'review', null, null, null);
    expect(v.chips).toEqual([
      { kind: 'stalled_review', total: 2 },
      { kind: 'reviewer_routing', total: 88 },
    ]);
    expect(v.people.map((c) => c.id)).toEqual(['load']);
    expect(v.cards.some((c) => c.kind === 'reviewer_load')).toBe(false);
  });

  it('ignores a kind filter that belongs to another tab', () => {
    const v = buildPendingView(data, 'review', 'merge', null, null);
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
    const all = buildPendingView(d, 'land', null, null, null);
    expect(all.shown).toBe(PENDING_LIMITS.boardListCap);
    expect(all.cards[0]!.id).toBe('m0');
    // A chip shows every card the server listed of that kind.
    expect(buildPendingView(d, 'land', 'merge', null, null).shown).toBe(30);
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
    const v = buildPendingView(data, 'my_turn', null, 'mine', null);
    expect(v.cards.map((c) => c.id)).toEqual(['a', 'c']);
    expect(v.total).toBe(70);
  });

  it('and the complement to the others, with ITS total', () => {
    const v = buildPendingView(data, 'my_turn', null, 'others', null);
    expect(v.cards.map((c) => c.id)).toEqual(['b']);
    expect(v.total).toBe(50);
  });

  it('never narrows another tab', () => {
    const d = response([card('x', 'merge')], [tab({ key: 'land', total: 1, kindTotals: { merge: 1 }, cardIds: ['x'] })]);
    expect(buildPendingView(d, 'land', null, 'mine', null).shown).toBe(1);
  });

  it('is offered only when it would change the list — or is already on', () => {
    expect(offerOnlyYours(myTurn, null)).toBe(true);
    expect(offerOnlyYours({ ...myTurn, relevanceTotals: { mine: 0, others: 9 } }, null)).toBe(false);
    expect(offerOnlyYours({ ...myTurn, relevanceTotals: { mine: 9, others: 0 } }, null)).toBe(false);
    expect(offerOnlyYours({ ...myTurn, relevanceTotals: { mine: 0, others: 9 } }, 'mine')).toBe(true);
  });
});

describe('a response from a server that predates tabs', () => {
  it('still gets all six tabs, built from its cards by kind, in the order sent', () => {
    const cards = [card('m', 'merge'), card('t', 'my_turn'), card('u', 'update_branch'), card('l', 'reviewer_load')];
    const tabs = tabsOf({ cards, users: [] });
    expect(tabs.map((t) => t.key)).toEqual(['my_turn', 'fixing', 'review', 'threads', 'land', 'deps']);
    expect(tabs.find((t) => t.key === 'land')!.cardIds).toEqual(['m', 'u']);
    expect(tabs.find((t) => t.key === 'review')!.peopleCardIds).toEqual(['l']);
  });
});

// ── THE DEPENDENCIES TAB ───────────────────────────────────────────────────────────────────────
describe('the Dependencies tab', () => {
  const data = response(
    [card('sec1', 'security'), card('sec2', 'security'), card('b1', 'dependency_bump'), card('b2', 'dependency_bump')],
    [
      tab({
        key: 'deps',
        total: 9,
        kindTotals: { security: 2, dependency_bump: 7 },
        // The server's strict group: every security item before any bump, whatever the scores.
        cardIds: ['sec1', 'sec2', 'b1', 'b2'],
      }),
    ],
  );

  it('is its own tab, named for what is in it', () => {
    expect(TAB_LABEL.deps).toBe('Dependencies');
  });

  it('offers a Security chip and a Bumps chip, each with its own total', () => {
    const v = buildPendingView(data, 'deps', null, null, null);
    expect(v.chips).toEqual([
      { kind: 'security', total: 2 },
      { kind: 'dependency_bump', total: 7 },
    ]);
    expect([v.shown, v.total]).toEqual([4, 9]);
  });

  it('keeps the server’s group order — security first — and never re-sorts', () => {
    expect(buildPendingView(data, 'deps', null, null, null).cards.map((c) => c.id)).toEqual([
      'sec1',
      'sec2',
      'b1',
      'b2',
    ]);
  });

  it('is where a `?attn=security` link lands', () => {
    expect(effectivePendingTab('security', null)).toBe('deps');
    expect(effectivePendingTab('dependency_bump', 'my_turn')).toBe('deps');
    const v = buildPendingView(data, 'deps', 'security', null, null);
    expect(v.cards.map((c) => c.id)).toEqual(['sec1', 'sec2']);
    expect(v.total).toBe(2);
  });
});

// ── THE PEOPLE / AUTOMATION LENS ────────────────────────────────────────────────────────────────
const BOT: PrAutomation = { role: 'code_agent', kind: null, source: 'account' };
const DEP: PrAutomation = { role: 'dependency', kind: 'dependabot', source: 'account' };

describe('the People / Automation lens', () => {
  const cards = [
    card('s1', 'stalled_review', { automation: null }),
    card('r1', 'reviewer_routing', { automation: BOT }),
    card('s2', 'stalled_review', { automation: BOT }),
    card('r2', 'reviewer_routing', { automation: null }),
    card('r3', 'reviewer_routing', { automation: null }),
    card('load', 'reviewer_load'),
  ];
  const review = tab({
    key: 'review',
    total: 40,
    kindTotals: { stalled_review: 10, reviewer_routing: 30 },
    cardIds: ['s1', 'r1', 's2', 'r2', 'r3'],
    peopleCardIds: ['load'],
    authorTotals: { people: 31, automation: 9 },
    kindAuthorTotals: {
      stalled_review: { people: 6, automation: 4 },
      reviewer_routing: { people: 25, automation: 5 },
    },
  });
  const data = response(cards, [review]);

  it('uses the server’s own predicate — a card is automation iff it names automation', () => {
    expect(passesAuthorLens(card('x', 'merge', { automation: DEP }), 'automation')).toBe(true);
    expect(passesAuthorLens(card('x', 'merge', { automation: DEP }), 'people')).toBe(false);
    expect(passesAuthorLens(card('x', 'merge', { automation: null }), 'people')).toBe(true);
    // A card naming no PR (a trunk with no landing PR, review load) is People.
    expect(passesAuthorLens(card('x', 'reviewer_load'), 'people')).toBe(true);
    expect(passesAuthorLens(card('x', 'merge', { automation: DEP }), null)).toBe(true);
  });

  it('narrows the whole tab, with the tab’s lensed total', () => {
    const v = buildPendingView(data, 'review', null, null, 'automation');
    expect(v.cards.map((c) => c.id)).toEqual(['r1', 's2']);
    expect([v.shown, v.total]).toEqual([2, 9]);
    const p = buildPendingView(data, 'review', null, null, 'people');
    expect(p.cards.map((c) => c.id)).toEqual(['s1', 'r2', 'r3']);
    expect(p.total).toBe(31);
  });

  it('narrows a kind chip, with THAT kind’s lensed total', () => {
    const v = buildPendingView(data, 'review', 'reviewer_routing', null, 'automation');
    expect(v.cards.map((c) => c.id)).toEqual(['r1']);
    expect(v.total).toBe(5);
  });

  it('gives each chip its lensed total under the lens', () => {
    expect(buildPendingView(data, 'review', null, null, 'people').chips).toEqual([
      { kind: 'stalled_review', total: 6 },
      { kind: 'reviewer_routing', total: 25 },
    ]);
  });

  it('reports the view BEFORE the lens — the pills’ figures — whichever pill is pressed', () => {
    for (const lens of [null, 'people', 'automation'] as const) {
      const v = buildPendingView(data, 'review', null, null, lens);
      expect(v.authorSplit).toEqual({ people: 31, automation: 9 });
      expect(v.allTotal).toBe(40);
    }
    const k = buildPendingView(data, 'review', 'stalled_review', null, 'people');
    expect(k.authorSplit).toEqual({ people: 6, automation: 4 });
    expect(k.allTotal).toBe(10);
  });

  it('leaves the people strip alone — review load is about people, not PRs', () => {
    expect(buildPendingView(data, 'review', null, null, 'automation').people.map((c) => c.id)).toEqual([
      'load',
    ]);
  });

  describe('on My turn, beside “Only yours”', () => {
    const mt = [
      card('a', 'my_turn', { personal: true, relevance: 'direct', automation: null }),
      card('b', 'my_turn', { personal: true, relevance: 'maintained', automation: DEP }),
      card('c', 'my_turn', { personal: false, relevance: 'none', automation: DEP }),
    ];
    const myTurn = tab({
      key: 'my_turn',
      total: 60,
      kindTotals: { my_turn: 60 },
      cardIds: ['a', 'b', 'c'],
      relevanceTotals: { mine: 45, others: 15 },
      authorTotals: { people: 50, automation: 10 },
      relevanceAuthorTotals: {
        mine: { people: 40, automation: 5 },
        others: { people: 10, automation: 5 },
      },
    });
    const d = response(mt, [myTurn]);

    it('pairs the relevance lens and the author lens with that pair’s own total', () => {
      const v = buildPendingView(d, 'my_turn', null, 'mine', 'automation');
      expect(v.cards.map((c) => c.id)).toEqual(['b']);
      expect(v.total).toBe(5);
      expect(v.authorSplit).toEqual({ people: 40, automation: 5 });
      expect(v.allTotal).toBe(45);
    });

    it('lists a red default branch like any My turn card — on its landing PR’s side of both lenses', () => {
      // A promoted trunk is kind `my_turn` with no PR of its own. The server puts it on the People /
      // Automation side of its LANDING PR's author (People when none resolved), and on the relevance
      // lens by its `relevance` — 'direct' (you added it) unless its repo is muted. The SPA must
      // file it on the same sides, or a badge counts a card the list never shows.
      const bumpTrunk = card('t1', 'my_turn', {
        reason: 'trunk_red',
        prId: 12,
        personal: true,
        relevance: 'direct',
        automation: DEP,
      });
      const pushTrunk = card('t2', 'my_turn', {
        reason: 'trunk_red',
        prId: null,
        personal: false,
        relevance: 'none',
        muted: true,
        automation: null,
      });
      expect(passesAuthorLens(bumpTrunk, 'automation')).toBe(true);
      expect(passesAuthorLens(pushTrunk, 'people')).toBe(true);
      expect(passesLens(bumpTrunk, 'mine')).toBe(true);
      expect(passesLens(bumpTrunk, 'others')).toBe(false);
      expect(passesLens(pushTrunk, 'others')).toBe(true);
      expect(passesLens(pushTrunk, 'mine')).toBe(false);

      const withTrunks = response([...mt, bumpTrunk, pushTrunk], [
        { ...myTurn, cardIds: ['t1', 'a', 'b', 'c', 't2'] },
      ]);
      // The server's order — the trunk group first here — survives every lens.
      expect(buildPendingView(withTrunks, 'my_turn', null, null, 'automation').cards.map((c) => c.id)).toEqual(
        ['t1', 'b', 'c'],
      );
      expect(buildPendingView(withTrunks, 'my_turn', null, 'others', null).cards.map((c) => c.id)).toEqual(
        ['c', 't2'],
      );
    });

    it('puts the lensed half on the “Only yours” pill — the list its click opens', () => {
      expect(relevancePillCount(myTurn, 'mine', null)).toBe(45);
      expect(relevancePillCount(myTurn, 'mine', 'automation')).toBe(5);
      expect(relevancePillCount(myTurn, 'others', 'people')).toBe(10);
      // A server predating the split says nothing, rather than borrowing the unlensed half.
      expect(relevancePillCount({ ...myTurn, relevanceAuthorTotals: undefined }, 'mine', 'people')).toBeNull();
    });
  });

  it('is offered only when it would change the list — or is already on', () => {
    expect(offerAuthorLens({ people: 3, automation: 2 }, null)).toBe(true);
    expect(offerAuthorLens({ people: 0, automation: 9 }, null)).toBe(false);
    expect(offerAuthorLens({ people: 9, automation: 0 }, null)).toBe(false);
    expect(offerAuthorLens(null, null)).toBe(false);
    // On, it can always be turned off — even when this view holds nothing on its side.
    expect(offerAuthorLens({ people: 0, automation: 9 }, 'people')).toBe(true);
    expect(offerAuthorLens(null, 'automation')).toBe(true);
  });

  it('puts each tab badge on the lensed side, and the whole tab without it', () => {
    expect(tabBadgeCount(review, null)).toBe(40);
    expect(tabBadgeCount(review, 'people')).toBe(31);
    expect(tabBadgeCount(review, 'automation')).toBe(9);
    // A server predating the split: the tab's own total, never an invented zero.
    expect(tabBadgeCount({ ...review, authorTotals: undefined }, 'automation')).toBe(40);
  });

  it(`caps the lensed whole-tab list at ${PENDING_LIMITS.boardListCap}`, () => {
    const many = Array.from({ length: PENDING_LIMITS.boardListCap + 20 }, (_, i) =>
      card(`m${i}`, i % 2 === 0 ? 'merge' : 'update_branch', { automation: DEP }),
    );
    const d = response(many, [
      tab({
        key: 'land',
        total: 300,
        kindTotals: { merge: 150, update_branch: 150 },
        cardIds: many.map((c) => c.id),
        authorTotals: { people: 0, automation: 300 },
      }),
    ]);
    const v = buildPendingView(d, 'land', null, null, 'automation');
    expect(v.shown).toBe(PENDING_LIMITS.boardListCap);
    expect(v.total).toBe(300);
  });

  it(`caps a KIND chip too — the server lists ${PENDING_LIMITS.boardListCap} per side, so a chip is a union with gaps`, () => {
    // Two list groups of one kind (people, automation), each at its cap: the chip's first
    // `boardListCap` are its true top, and the rest are not.
    const cap = PENDING_LIMITS.boardListCap;
    const ppl = Array.from({ length: cap }, (_, i) => card(`p${i}`, 'merge', { automation: null }));
    const bots = Array.from({ length: cap }, (_, i) => card(`b${i}`, 'merge', { automation: DEP }));
    const interleaved = ppl.flatMap((p, i) => [p, bots[i]!]);
    const d = response(interleaved, [
      tab({
        key: 'land',
        total: 500,
        kindTotals: { merge: 400, update_branch: 100 },
        cardIds: interleaved.map((c) => c.id),
      }),
    ]);
    const v = buildPendingView(d, 'land', 'merge', null, null);
    expect(v.shown).toBe(cap);
    expect(v.total).toBe(400);
  });
});

describe('what an empty list says', () => {
  const none = { kind: null, relevance: null, authorLens: null, allTotal: 0, cards: 0, people: 0 } as const;

  it('⚠ still speaks when a lens hid every card but the review-load strip is up — above the strip', () => {
    // The real shape (Waiting on review, three stalled reviews all by people, Automation on): the
    // strip counts REVIEWERS, so it survived the lens, and the reader got it with no word that
    // three cards were hidden and no "Show all".
    expect(
      pendingEmptyNote({ ...none, tab: 'review', authorLens: 'automation', allTotal: 3, people: 2 }),
    ).toEqual({
      sentence: 'Nothing from automation in Waiting on review right now.',
      placement: 'above',
      emptiedBy: 'automation',
    });
    // A kind chip emptied it: the same placement.
    expect(pendingEmptyNote({ ...none, tab: 'review', kind: 'stalled_review', people: 2 })?.placement).toBe(
      'above',
    );
  });

  it('says nothing over the strip when nothing was narrowed — the strip is the tab’s content', () => {
    // "No reviews are waiting." above a strip of pending reviews would contradict it.
    expect(pendingEmptyNote({ ...none, tab: 'review', people: 2 })).toBeNull();
    // …nor when the lens is on but the tab is empty anyway: the lens hid nothing.
    expect(pendingEmptyNote({ ...none, tab: 'review', authorLens: 'people', people: 2 })).toBeNull();
    expect(pendingEmptyNote({ ...none, tab: 'review', allTotal: 3, cards: 3 })).toBeNull();
  });

  it('names a chip in English — "Nothing under Bumps", never "No Bumps cards"', () => {
    expect(pendingEmptyNote({ ...none, tab: 'deps', kind: 'dependency_bump' })?.sentence).toBe(
      'Nothing under Bumps right now.',
    );
    expect(pendingEmptyNote({ ...none, tab: 'deps', kind: 'security' })?.sentence).toBe(
      'Nothing under Security right now.',
    );
    expect(
      pendingEmptyNote({ ...none, tab: 'deps', kind: 'security', authorLens: 'people', allTotal: 1 })?.sentence,
    ).toBe('Nothing from people under Security right now.');
  });

  it('says the tab’s own sentence when nothing narrowed it, and the lens’s when the lens is not why', () => {
    expect(pendingEmptyNote({ ...none, tab: 'deps' })).toEqual({
      sentence: 'No dependency updates or security alerts are waiting.',
      placement: 'alone',
      emptiedBy: null,
    });
    expect(pendingEmptyNote({ ...none, tab: 'land', authorLens: 'automation' })?.sentence).toBe(
      'Nothing is ready to land.',
    );
    expect(pendingEmptyNote({ ...none, tab: 'my_turn', relevance: 'mine' })?.sentence).toBe(
      'Nothing on My turn personally involves you right now.',
    );
    expect(pendingEmptyNote({ ...none, tab: 'my_turn', relevance: 'others' })?.sentence).toBe(
      'Nothing on My turn is waiting on someone other than you right now.',
    );
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
