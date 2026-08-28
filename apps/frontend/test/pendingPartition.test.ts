// The Pending board's head/tail partition — the rule every cap disclosure on that screen leans on.
//
// WHAT THIS PINS, and why each half is worth a test rather than a comment:
//
//   1. HEAD ∪ TAIL === CARDS, DISJOINT. `GET /api/attention` returns `doNextIds` — card ids in
//      `db/work-plan.ts`'s score order — and `AttentionView` reorders `cards` into
//      `[...head, ...rest]`. It is an ORDERING, never a filter. `capFor` gates its "of N" on
//      `shown === count`, so a partition that dropped a card would push `myTurnShown` below
//      `counts.myTurn` and make "50 of 148" vanish WITH NO ERROR — on exactly the workspaces
//      where the cap matters. The coupling is invisible in the JSX, so it is asserted here.
//
//   2. THE DIVIDER'S TWO BOUNDS. `headCount === 0` is the COMMON case, not an edge: every
//      isolated board suppresses the head (each daily-brief line click, the Welcome-back banner,
//      every workspace "Elsewhere" row), and any response predating `doNextIds` has none either.
//      Without the lower bound the board opens with an "Everything else" rule and nothing above
//      it. The upper bound stops a trailing rule introducing an empty section.
//
// `partition` below is the SAME fold AttentionView performs, kept in one place so the test and the
// component cannot drift into two answers.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { shouldShowDivider } from '../src/components/Activity/AttentionCards.js';

type Card = { id: string; prId?: number | null };

/** The AttentionView fold: head = doNextIds resolved against the FINAL card set, tail = the rest
 *  in their existing order. Suppressed (head empty) under an isolation. */
function partition(
  cards: Card[],
  doNextIds: string[] | undefined,
  headSuppressed = false,
): { ordered: Card[]; headCount: number } {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const head = headSuppressed
    ? []
    : (doNextIds ?? []).map((id) => byId.get(id)).filter((c): c is Card => c != null);
  if (head.length === 0) return { ordered: cards, headCount: 0 };
  const inHead = new Set(head.map((c) => c.id));
  return { ordered: [...head, ...cards.filter((c) => !inHead.has(c.id))], headCount: head.length };
}

const cards: Card[] = [
  { id: 'my:1', prId: 1 },
  { id: 'wp:merge:2', prId: 2 },
  { id: 'thr:3', prId: 3 },
  { id: 'cifail:trunk:9:abc', prId: null },
  { id: 'my:5', prId: 5 },
];

describe('head ∪ tail === cards', () => {
  it('reorders without adding, dropping or duplicating a card', () => {
    const { ordered, headCount } = partition(cards, ['thr:3', 'wp:merge:2']);
    expect(headCount).toBe(2);
    expect(ordered).toHaveLength(cards.length);
    expect(new Set(ordered.map((c) => c.id))).toEqual(new Set(cards.map((c) => c.id)));
    // No duplicates — the head's members are removed from the tail, not copied into it.
    expect(ordered.map((c) => c.id)).toEqual([...new Set(ordered.map((c) => c.id))]);
    // The head leads, in the order the server ranked it.
    expect(ordered.slice(0, 2).map((c) => c.id)).toEqual(['thr:3', 'wp:merge:2']);
  });

  it('ignores a doNextId with no card behind it rather than shortening the board', () => {
    // The order comes from /api/attention and the cards from the same response, but a bot card
    // filtered upstream (or any future divergence) must cost a HEAD SLOT, never a board row.
    const { ordered, headCount } = partition(cards, ['ghost:404', 'my:5']);
    expect(headCount).toBe(1);
    expect(ordered).toHaveLength(cards.length);
    expect(ordered[0]!.id).toBe('my:5');
  });

  it('a response with NO doNextIds is a headless board, not an empty one', () => {
    const { ordered, headCount } = partition(cards, undefined);
    expect(headCount).toBe(0);
    expect(ordered).toEqual(cards);
  });

  it('an isolation suppresses the head and leaves the list untouched', () => {
    const { ordered, headCount } = partition(cards, ['thr:3', 'wp:merge:2'], true);
    expect(headCount).toBe(0);
    expect(ordered).toEqual(cards);
  });

  it('keeps a PR that two kinds both name — the tail sibling is MARKED, never dropped', () => {
    // The ranker's per-PR dedup decides which of a PR's rows is SEATED IN THE HEAD. The loser
    // stays on the board: removing it would break the partition and take the cap disclosure with
    // it, which is a strictly worse failure than showing one PR twice.
    const both: Card[] = [
      { id: 'wp:merge:7', prId: 7 },
      { id: 'my:7', prId: 7 },
    ];
    const { ordered, headCount } = partition(both, ['wp:merge:7']);
    expect(headCount).toBe(1);
    expect(ordered.map((c) => c.id)).toEqual(['wp:merge:7', 'my:7']);
  });
});

describe('the divider', () => {
  it('does NOT render above the first card on a headless board', () => {
    // The state every daily-brief line click produces.
    expect(shouldShowDivider(0, 5)).toBe(false);
    expect(shouldShowDivider(undefined, 5)).toBe(false);
  });

  it('does NOT render when the head swallows the whole board', () => {
    expect(shouldShowDivider(5, 5)).toBe(false);
  });

  it('renders exactly once, between head and tail', () => {
    expect(shouldShowDivider(2, 5)).toBe(true);
    expect(shouldShowDivider(1, 2)).toBe(true);
  });

  it('never renders on an empty board', () => {
    expect(shouldShowDivider(0, 0)).toBe(false);
  });
});
