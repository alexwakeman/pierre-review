// The `my_turn` CAP DISCLOSURE — when a capped board says "50 of 148" and when it says nothing.
//
// `my_turn` cards are emitted capped at MY_TURN_CARD_CAP (50, server-side). On a real workspace
// GET /api/my-turn held 148 items while the board and the daily brief both said 50: they agreed
// with each other (which is the rule — the brief counts the cards the board paints) but 50 was
// not the truth, and no wire field carried the rest. `myTurnTotal` is that field, and this is the
// one predicate every surface asks before rendering it:
//
//   ⚠ THE FIGURE NEVER CHANGES. The board, the banner and the brief keep displaying the CARD
//     count — the list a click opens. `myTurnTotal` only ever QUALIFIES it. A surface that
//     promoted 148 to the headline would recreate the bug this batch existed to fix: a number
//     with no list of 148 behind it.
//
//   ⚠ THE PAIR MUST COME FROM ONE SNAPSHOT. The board's card count is live (/api/attention);
//     the total rides the daily brief, which sits behind a ≤5-min server TTL. Pairing a live
//     numerator with a stale denominator renders "48 of 148" — one row mixing two populations,
//     the exact defect the period-report work had to fix three times. Hence the equality guard,
//     which costs nothing in the capped case (a capped board reads 50 and so does the brief) and
//     buys silence for one refresh when they disagree.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { DailyBriefCounts } from '@pierre-review/shared';
import {
  myTurnCapDisclosure,
  myTurnCapPlacement,
} from '../src/components/Activity/AttentionView.js';

/** A brief fold with only the two fields this rule reads varied. */
function counts(over: Partial<DailyBriefCounts> = {}): DailyBriefCounts {
  return {
    myTurn: 0,
    stalled: 0,
    untouchedThreads: 0,
    needsReviewer: 0,
    resolveBacklog: 0,
    botAnomalies: [],
    trunkRed: [],
    ...over,
  };
}

describe('myTurnCapDisclosure', () => {
  // ── capped: the disclosure ────────────────────────────────────────────────────────────────
  it('discloses the uncapped total when the board is capped', () => {
    const cap = myTurnCapDisclosure(50, counts({ myTurn: 50, myTurnTotal: 148 }));
    expect(cap).not.toBeNull();
    expect(cap?.shown).toBe(50);
    expect(cap?.total).toBe(148);
  });

  it('the title names BOTH numbers — the tooltip is where the exact pair lives', () => {
    const cap = myTurnCapDisclosure(50, counts({ myTurn: 50, myTurnTotal: 148 }));
    expect(cap?.title).toContain('148');
    expect(cap?.title).toContain('50');
  });

  it('`shown` is the CARD count, never the total (the figure must not move)', () => {
    // The whole point: a surface renders cap.shown, and 148 appears only as a qualifier.
    const cap = myTurnCapDisclosure(50, counts({ myTurn: 50, myTurnTotal: 148 }));
    expect(cap?.shown).not.toBe(cap?.total);
    expect(cap?.shown).toBe(50);
  });

  it('discloses a cap of any size, not just the 50 boundary', () => {
    // Nothing here knows MY_TURN_CARD_CAP — duplicating the server's constant client-side is how
    // the two drift. The predicate is "the total exceeds what we painted", full stop.
    expect(myTurnCapDisclosure(7, counts({ myTurn: 7, myTurnTotal: 8 }))?.total).toBe(8);
  });

  // ── not capped: silence ───────────────────────────────────────────────────────────────────
  it('says nothing when the board holds the whole population', () => {
    expect(myTurnCapDisclosure(12, counts({ myTurn: 12, myTurnTotal: 12 }))).toBeNull();
  });

  it('says nothing when the total is somehow BELOW the card count', () => {
    // Not reachable by construction; a "50 of 40" is worse than silence if it ever were.
    expect(myTurnCapDisclosure(50, counts({ myTurn: 50, myTurnTotal: 40 }))).toBeNull();
  });

  it('says nothing when nothing is shown ("0 of 148" is a lie in the other direction)', () => {
    expect(myTurnCapDisclosure(0, counts({ myTurn: 0, myTurnTotal: 148 }))).toBeNull();
  });

  // ── the field is OPTIONAL: absence is not zero ────────────────────────────────────────────
  it('says nothing when the server sent no total (older host, or an empty workspace)', () => {
    // `myTurnTotal` is additive and optional on the wire — a response without it degrades to
    // exactly today's silent behaviour rather than rendering "50 of undefined"/"50 of 0".
    expect(myTurnCapDisclosure(50, counts({ myTurn: 50 }))).toBeNull();
  });

  it('says nothing while the brief is still loading', () => {
    expect(myTurnCapDisclosure(50, undefined)).toBeNull();
    expect(myTurnCapDisclosure(50, null)).toBeNull();
  });

  // ── the same-snapshot guard ───────────────────────────────────────────────────────────────
  it('says nothing when the brief is STALE-HIGH against a board that has drained', () => {
    // The failure this guard exists for: the user cleared 100 items, the board is uncapped at 48,
    // and the brief still holds the pre-clear pair. "48 of 148" would pair a live numerator with
    // a dead denominator.
    expect(myTurnCapDisclosure(48, counts({ myTurn: 50, myTurnTotal: 148 }))).toBeNull();
  });

  it('says nothing when the BOARD is the stale one', () => {
    // Symmetric: the guard is an equality, not a comparison, so neither side gets to be the
    // trusted one. Nothing in this rule ranks the two caches.
    expect(myTurnCapDisclosure(50, counts({ myTurn: 48, myTurnTotal: 148 }))).toBeNull();
  });

  it('the capped case satisfies the guard for free — both sides are the same capped fold', () => {
    // Why the guard is cheap rather than a feature-killer: when the cap is actually in force,
    // the board paints 50 and the brief counts 50, because they are one fold with one cap.
    expect(myTurnCapDisclosure(50, counts({ myTurn: 50, myTurnTotal: 148 }))).not.toBeNull();
  });

  it('the brief strip passes its own figure as both sides — one response, one snapshot', () => {
    // BriefStrip calls myTurnCapDisclosure(counts.myTurn, counts): the equality is an identity
    // there, so the strip's rule reduces to the honest one — "is the total bigger than what I am
    // about to print".
    const c = counts({ myTurn: 50, myTurnTotal: 148 });
    expect(myTurnCapDisclosure(c.myTurn, c)?.total).toBe(148);
    const uncapped = counts({ myTurn: 9, myTurnTotal: 9 });
    expect(myTurnCapDisclosure(uncapped.myTurn, uncapped)).toBeNull();
  });
});

describe('myTurnCapPlacement (the board header)', () => {
  const cap = myTurnCapDisclosure(50, counts({ myTurn: 50, myTurnTotal: 148 }));

  it('goes INLINE when the board is isolated to my_turn — the header count is that count', () => {
    expect(myTurnCapPlacement(cap, 'my_turn')).toBe('inline');
  });

  it('goes ASIDE on the un-isolated board — the header counts five kinds', () => {
    // "95 of 148" would put a mixed-kind numerator and a my_turn-only denominator in one row.
    // The un-isolated board is the DEFAULT, so this is where the silent cap actually bit.
    expect(myTurnCapPlacement(cap, null)).toBe('aside');
  });

  it('says NOTHING when the board is isolated to some other kind', () => {
    // Not one my_turn card is on screen; a clause about 148 of them qualifies nothing visible.
    expect(myTurnCapPlacement(cap, 'stalled_review')).toBe('none');
    expect(myTurnCapPlacement(cap, 'untouched_thread')).toBe('none');
    expect(myTurnCapPlacement(cap, 'reviewer_routing')).toBe('none');
  });

  it('says NOTHING when there is no cap to disclose, whatever the board shows', () => {
    expect(myTurnCapPlacement(null, 'my_turn')).toBe('none');
    expect(myTurnCapPlacement(null, null)).toBe('none');
  });
});
