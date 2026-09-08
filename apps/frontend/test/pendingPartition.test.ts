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
import type { DailyBriefCounts, InsightCard } from '@pierre-review/shared';
import { shouldShowDivider } from '../src/components/Activity/AttentionCards.js';
import {
  headSuppressedFor,
  myTurnPillToggle,
  passesRelevanceLens,
  personalLensToggle,
} from '../src/components/Activity/AttentionView.js';
import {
  activeWorkspaceBadge,
  workspaceCapDisclosure,
  type WorkspaceMyTurnLine,
} from '../src/hooks/useMyTurnByWorkspace.js';

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

// ── THE HEADER'S "Only yours" CONTROL ────────────────────────────────────────────────────────
//
// The board's relevance lens shipped with exactly two entry points — `openMyTurnInWorkspace` and
// the daily brief's lines — and BOTH of them seat a kind isolation as well. Correct in both cases
// (a narrow count may only navigate through its own lens), but between them no gesture could
// narrow the board to what involves you WITHOUT collapsing it to one kind, which suppresses the
// ranked "Do next" head and hides six of the seven kinds. `personalLensToggle` backs the control
// that closes that gap; what is pinned here is the arithmetic behind its number, because a number
// beside a filter is a claim about the list the press produces.
//
//   ⚠ THE COUNT IS A FOLD OF THE PAINTED ARRAY BY THE PRESS'S OWN PREDICATE. Any other source —
//     the brief's counts, a subtraction, a second predicate — can disagree with the rows, and the
//     board is where the two would be seen side by side.
//   ⚠ AND IT IS WITHHELD WHERE THAT FOLD WOULD LIE. `passesPersonalLens` passes every non-my_turn
//     card, so folding it over an 'others' board yields a figure the press could never produce.
//     No number is the correct output there; a plausible wrong one is the defect.
const card = (over: Partial<InsightCard>): InsightCard => ({ kind: 'my_turn', ...over }) as InsightCard;

/** One board of each shape the lens distinguishes: two rows tied to the reader, one that is not,
 *  and two survey rows that carry no relevance at all. */
const board: InsightCard[] = [
  card({ id: 'my:direct', personal: true, relevance: 'direct' }),
  card({ id: 'my:maintained', personal: true, relevance: 'maintained' }),
  card({ id: 'my:none', personal: false, relevance: 'none' }),
  card({ id: 'thr:1', kind: 'untouched_thread' }),
  card({ id: 'stall:1', kind: 'stalled_review' }),
];
const paint = (cards: InsightCard[], lens: 'mine' | 'others' | null): string[] =>
  cards.filter((c) => passesRelevanceLens(c, lens)).map((c) => c.id);

describe('the personal lens', () => {
  it('keeps exactly the direct + maintained rows — and every row the lens does not judge', () => {
    // That pair is what every personal badge already counts, and the survey kinds are exempt from
    // the lens in BOTH directions (they carry no relevance, and `ci_failing` is personal by
    // construction), so they stay on a narrowed board.
    expect(paint(board, 'mine')).toEqual(['my:direct', 'my:maintained', 'thr:1', 'stall:1']);
  });

  it('restores everything when the lens goes back to null', () => {
    expect(paint(board, null)).toEqual(board.map((c) => c.id));
  });

  it('offers the control, and carries NO number, when the board is mixed', () => {
    const t = personalLensToggle(board, null);
    expect(t).toEqual({ pressed: false });
    // The press is real — it removes the non-personal my-turn row and keeps everything else.
    expect(paint(board, 'mine')).toHaveLength(4);
  });

  it('carries no number once pressed, or under the OTHER lens', () => {
    expect(personalLensToggle(paint(board, 'mine').map((id) => card({ id })), 'mine')).toEqual({
      pressed: true,
    });
    const others = board.filter((c) => passesRelevanceLens(c, 'others'));
    expect(others.map((c) => c.id)).toEqual(['my:none', 'thr:1', 'stall:1']);
    expect(personalLensToggle(others, 'others')).toEqual({ pressed: false });
  });

  it('⚠ IS WITHHELD WHEN NO ROW IS THE READER’S, however many rows survive the press', () => {
    // THE REGRESSION. Shape taken from a real workspace: fifty my-turn rows, NONE personal, beside
    // sixty-five survey and forward rows. `passesPersonalLens` narrows `my_turn` AND NOTHING ELSE,
    // so it passes all sixty-five — and the predecessor, which gated on that figure being non-zero,
    // offered "Only yours 65" on a board holding nothing of the reader's at all. A press then
    // painted sixty-five rows, every one of them explicitly NOT theirs.
    const noneMine = [
      ...Array.from({ length: 3 }, (_, i) =>
        card({ id: `my:none:${i}`, personal: false, relevance: 'none' }),
      ),
      ...Array.from({ length: 5 }, (_, i) => card({ id: `thr:${i}`, kind: 'untouched_thread' })),
    ];
    // The old guard's figure is emphatically non-zero — that is exactly why it did not fire.
    expect(noneMine.filter((c) => passesRelevanceLens(c, 'mine'))).toHaveLength(5);
    expect(personalLensToggle(noneMine, null)).toBeNull();
  });

  it('is absent when it would change nothing — every row personal, or none of them', () => {
    // Nothing to hide.
    const allPersonal = board.filter((c) => c.id !== 'my:none');
    expect(personalLensToggle(allPersonal, null)).toBeNull();
    // Nothing to show: pressing would empty the board, which is not a filter, it is a dead end.
    expect(personalLensToggle([card({ id: 'my:none', personal: false, relevance: 'none' })], null)).toBeNull();
    // An empty board (loading, or genuinely clear) offers no control either.
    expect(personalLensToggle([], null)).toBeNull();
  });

  it('an unclassifiable my_turn row counts as personal, in the fold AND on the control', () => {
    // ⚠ Only an EXPLICIT `personal: false` hides a card — the wire's own tolerance rule, and the
    // safe direction for a lens that hides work. A row with neither field therefore never makes
    // the control appear on a board that is otherwise entirely personal.
    const withUnknown = [...board.filter((c) => c.id !== 'my:none'), card({ id: 'my:unknown' })];
    expect(paint(withUnknown, 'mine')).toContain('my:unknown');
    expect(personalLensToggle(withUnknown, null)).toBeNull();
  });
});

// ── THE "My turn" PILL ───────────────────────────────────────────────────────────────────────
//
// The reader asked for "a pill at the top to filter for My Turn only so I can focus in on those at
// any point". It seats the KIND isolation, which is the same value the daily brief's my-turn line
// seats — so what is new here is not the state, it is that a reader can reach it and LEAVE it
// without a notification having sent them there.
//
//   ⚠ THE PRESS TARGET IS PART OF THE FUNCTION, not of the `onClick`. Every entry point seats its
//     value, `null` included, and a renderer-less test can only exercise that if the value is
//     returned rather than computed in JSX.
//   ⚠ IT STANDS DOWN WHERE IT WOULD DO NOTHING, exactly like its neighbour: an all-my_turn board
//     has nothing to hide and a my_turn-less one has nothing to show.
describe('the “My turn” pill', () => {
  const mixed: InsightCard[] = [
    card({ id: 'my:1' }),
    card({ id: 'thr:1', kind: 'untouched_thread' }),
    card({ id: 'merge:1', kind: 'merge' }),
  ];

  it('seats the isolation on a press, and CLEARS it on the next one', () => {
    const off = myTurnPillToggle(mixed, null);
    expect(off).toEqual({ pressed: false, next: 'my_turn' });
    // Pressed state is derived from the isolation, never from a local flag — a press that seated
    // `my_turn` elsewhere (a brief line, the Welcome-back banner) shows the pill pressed too.
    const on = myTurnPillToggle(mixed.filter((c) => c.kind === 'my_turn'), 'my_turn');
    expect(on).toEqual({ pressed: true, next: null });
  });

  it('is withheld on a board it cannot change', () => {
    // Nothing of the kind to focus on…
    expect(myTurnPillToggle(mixed.filter((c) => c.kind !== 'my_turn'), null)).toBeNull();
    // …and nothing else to hide.
    expect(myTurnPillToggle([card({ id: 'my:1' }), card({ id: 'my:2' })], null)).toBeNull();
    expect(myTurnPillToggle([], null)).toBeNull();
  });

  it('is withheld under ANOTHER kind’s isolation — that board has its own way out', () => {
    // The board is already somebody else's narrowing (a brief line), whose banner carries "Clear".
    // A second pill offering to swap one isolation for another turns a filter into a rail.
    const stalledOnly = [card({ id: 'stall:1', kind: 'stalled_review' })];
    expect(myTurnPillToggle(stalledOnly, 'stalled_review')).toBeNull();
  });

  it('⚠ HIDES “Only yours” while it is pressed — two near-synonym pills is the failure', () => {
    // Both controls narrow toward "mine" in the reader's language, and the header cannot say which
    // of the two is on. The KIND pill is the one they pressed, so it stays; the relevance lens
    // keeps its entry points and its way out on the isolation banner directly above the board.
    const lensBoard: InsightCard[] = [
      card({ id: 'my:direct', personal: true, relevance: 'direct' }),
      card({ id: 'my:none', personal: false, relevance: 'none' }),
    ];
    // Un-isolated, the relevance control is offered as before.
    expect(personalLensToggle(lensBoard, null, null)).toEqual({ pressed: false });
    // Under the pill it is withheld — pressed lens or not.
    expect(personalLensToggle(lensBoard, null, 'my_turn')).toBeNull();
    expect(personalLensToggle(lensBoard, 'mine', 'my_turn')).toBeNull();
    // …and NOT under any other isolation: those boards never show the pill, so nothing collides.
    expect(personalLensToggle(lensBoard, null, 'stalled_review')).toEqual({ pressed: false });
  });
});

// ── THE HEAD SURVIVES THE PILL, AND ONLY THE PILL ────────────────────────────────────────────
//
// `headSuppressed` used to be `attentionIsolation != null`, which blanked the ranked "Do next"
// head, every Pro `why` line and the plan button for EVERY isolation. That was right while the
// only isolations were the daily brief's SURVEY kinds — "15 untouched threads" has no order to do
// them in. It is wrong for the pill: the reader asking to see only what is on them is asking for
// exactly the population `db/work-plan.ts` ranks, and blanking the head answers a request to focus
// by deleting the ordering.
//
//   ⚠ THE EXEMPTION MUST NOT COST THE PARTITION. The head is `doNextIds` resolved against the
//     ISOLATED card set, so it is still a subset of the board — head ∪ tail === cards, disjoint —
//     and `capFor`'s `shown === count` guard, which the "50 of 180" disclosure hangs on, is
//     untouched.
describe('the ranked head under an isolation', () => {
  const myTurnOnly: Card[] = [
    { id: 'my:1', prId: 1 },
    { id: 'my:5', prId: 5 },
    { id: 'my:9', prId: 9 },
  ];
  // A real response: /api/attention ranked twelve rows across seven kinds; three of them are
  // my_turn. (Measured on workspace 5: 115 cards, 12 doNextIds, 3 of them my_turn.)
  const doNextIds = ['upd:2', 'my:5', 'thr:7', 'my:1'];

  it('keeps the head under the “My turn” pill, ranked, and still a permutation', () => {
    expect(headSuppressedFor('my_turn')).toBe(false);
    const { ordered, headCount } = partition(myTurnOnly, doNextIds, headSuppressedFor('my_turn'));
    // The ids naming cards this isolation filtered away cost a HEAD SLOT, never a board row.
    expect(headCount).toBe(2);
    expect(ordered.map((c) => c.id)).toEqual(['my:5', 'my:1', 'my:9']);
    expect(new Set(ordered.map((c) => c.id))).toEqual(new Set(myTurnOnly.map((c) => c.id)));
    // …so the divider still has both of its bounds to work with.
    expect(shouldShowDivider(headCount, ordered.length)).toBe(true);
  });

  it('still suppresses it for every OTHER kind', () => {
    for (const kind of ['stalled_review', 'untouched_thread', 'reviewer_routing', 'ci_failing', 'merge'] as const) {
      expect(headSuppressedFor(kind)).toBe(true);
    }
    const surveys: Card[] = [{ id: 'thr:7' }, { id: 'thr:8' }];
    const { ordered, headCount } = partition(surveys, ['thr:7'], headSuppressedFor('untouched_thread'));
    expect(headCount).toBe(0);
    expect(ordered).toEqual(surveys);
  });

  it('leaves the un-isolated board exactly as it was', () => {
    expect(headSuppressedFor(null)).toBe(false);
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
