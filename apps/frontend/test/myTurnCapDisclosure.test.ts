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
import type { InsightCard } from '@pierre-review/shared';
import {
  myTurnCapDisclosure,
  myTurnCapPlacement,
  myTurnOtherCapDisclosure,
  myTurnPersonalCapDisclosure,
  passesOtherLens,
  passesPersonalLens,
  passesRelevanceLens,
  personalMyTurnCount,
} from '../src/components/Activity/AttentionView.js';
import { cardKindLabel, KIND_LABEL } from '../src/components/Activity/AttentionCards.js';
import {
  relevanceSplit,
  sumRelevanceSplit,
  workspaceCapDisclosure,
} from '../src/hooks/useMyTurnByWorkspace.js';

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

describe('workspaceCapDisclosure (the per-workspace badge and banner lines)', () => {
  // The shared sentence is written for the board you are STANDING ON. The Workspace dropdown and
  // the Welcome-back banner render the same disclosure on rows for workspaces the user is NOT
  // in — surfaces whose entire job is telling workspaces apart — so the place name has to move
  // with the row. The RULE (whether a cap exists, and the shown/total pair) still has one owner.
  const capped = counts({ myTurn: 50, myTurnTotal: 148 });

  it('the shared sentence still says "in this Workspace" — the substitution depends on it', () => {
    // ⚠ If this fails, the re-homing in useMyTurnByWorkspace has silently become a no-op and
    // every OTHER workspace's badge is back to naming the workspace the user is looking at.
    expect(myTurnCapDisclosure(50, capped)?.title).toContain('in this Workspace');
  });

  it('leaves the ACTIVE line on the shared sentence, word for word', () => {
    expect(workspaceCapDisclosure(capped, true, 'Default')?.title).toBe(
      myTurnCapDisclosure(50, capped)?.title,
    );
  });

  it('names the line’s OWN workspace on every other line', () => {
    const cap = workspaceCapDisclosure(capped, false, 'Platform');
    expect(cap?.title).toContain('in Platform');
    expect(cap?.title).not.toContain('in this Workspace');
    // The pair is untouched — only the place name moved.
    expect(cap?.shown).toBe(50);
    expect(cap?.total).toBe(148);
  });

  it('stays silent when there is no cap, wherever the line points', () => {
    const uncapped = counts({ myTurn: 9, myTurnTotal: 9 });
    expect(workspaceCapDisclosure(uncapped, false, 'Platform')).toBeNull();
    expect(workspaceCapDisclosure(uncapped, true, 'Default')).toBeNull();
  });
});

// ── The NARROW twin: the notification surfaces' pair ─────────────────────────────────────────
//
// The welcome-back banner, the Workspace-dropdown badges and the brief's "Elsewhere" rows count
// `myTurnPersonal` — the my_turn cards that personally involve the viewer — because a badge that
// lit up for a stranger's PR in a repo you only read is a summons to nothing. The BOARD keeps the
// broad population.
//
//   ⚠ PAIR NARROW WITH NARROW. The broad rule gates on `shown === counts.myTurn`. Hand it a
//     personal figure and that equality fails on exactly the workspaces the narrowing exists for,
//     so the capped line silently loses its "of N" — and had it passed, it would have printed a
//     narrow numerator over a broad denominator: one row, two populations.
describe('myTurnPersonalCapDisclosure', () => {
  it('discloses the PERSONAL total, never the broad one', () => {
    const cap = myTurnPersonalCapDisclosure(
      12,
      counts({ myTurn: 50, myTurnTotal: 148, myTurnPersonal: 12, myTurnPersonalTotal: 30 }),
    );
    expect(cap?.shown).toBe(12);
    expect(cap?.total).toBe(30);
    expect(cap?.title).toContain('30');
    expect(cap?.title).not.toContain('148');
  });

  it('the broad rule would have said NOTHING about the same line — the bug this exists for', () => {
    // 12 !== counts.myTurn (50), so the shared guard rejects it: the "+" disappears from every
    // capped narrow line, silently.
    const c = counts({ myTurn: 50, myTurnTotal: 148, myTurnPersonal: 12, myTurnPersonalTotal: 30 });
    expect(myTurnCapDisclosure(12, c)).toBeNull();
    expect(myTurnPersonalCapDisclosure(12, c)).not.toBeNull();
  });

  it('stays silent when the personal population is fully painted', () => {
    expect(
      myTurnPersonalCapDisclosure(
        12,
        counts({ myTurn: 50, myTurnTotal: 148, myTurnPersonal: 12, myTurnPersonalTotal: 12 }),
      ),
    ).toBeNull();
  });

  it('keeps the same-snapshot guard — a live board against a drained brief says nothing', () => {
    expect(
      myTurnPersonalCapDisclosure(
        9,
        counts({ myTurn: 50, myTurnTotal: 148, myTurnPersonal: 12, myTurnPersonalTotal: 30 }),
      ),
    ).toBeNull();
  });

  it('degrades to the BROAD pair when the server sent no personal count', () => {
    // A response predating the narrowing: the surfaces display `myTurn`, so the denominator must
    // be `myTurnTotal` — still one population per row, just the old one.
    const c = counts({ myTurn: 50, myTurnTotal: 148 });
    expect(myTurnPersonalCapDisclosure(50, c)?.total).toBe(148);
    expect(personalMyTurnCount(c)).toBe(50);
  });

  it('does NOT borrow the broad total when only the personal TOTAL is missing', () => {
    // Half a narrow pair is not a pair. Silence beats "12 of 148".
    expect(
      myTurnPersonalCapDisclosure(12, counts({ myTurn: 50, myTurnTotal: 148, myTurnPersonal: 12 })),
    ).toBeNull();
  });

  it('says nothing while the brief is still loading', () => {
    expect(myTurnPersonalCapDisclosure(12, undefined)).toBeNull();
    expect(myTurnPersonalCapDisclosure(12, null)).toBeNull();
  });

  it('personalMyTurnCount prefers the narrow figure and falls back to the broad one', () => {
    expect(personalMyTurnCount(counts({ myTurn: 50, myTurnPersonal: 3 }))).toBe(3);
    // ZERO is a real answer, not "absent": a workspace can hold 50 cards, none of them yours.
    expect(personalMyTurnCount(counts({ myTurn: 50, myTurnPersonal: 0 }))).toBe(0);
    expect(personalMyTurnCount(counts({ myTurn: 50 }))).toBe(50);
  });
});

describe('workspaceCapDisclosure reads the NARROW pair (badge + banner)', () => {
  it('qualifies the personal figure with the personal total, on any row', () => {
    const c = counts({
      myTurn: 50,
      myTurnTotal: 148,
      myTurnPersonal: 12,
      myTurnPersonalTotal: 30,
    });
    const active = workspaceCapDisclosure(c, true, 'Default');
    expect(active?.shown).toBe(12);
    expect(active?.total).toBe(30);
    // …and the place-name substitution still bites, so the narrow sentence must keep the phrase.
    const other = workspaceCapDisclosure(c, false, 'Platform');
    expect(other?.title).toContain('in Platform');
    expect(other?.title).not.toContain('in this Workspace');
  });
});

// ── The "review or reply" twin: the OTHER half of the same split ─────────────────────────────
//
// The brief's second my-turn line counts `myTurnOther` and opens a board filtered to it, so it
// needs its own pair for exactly the reasons the personal twin does — plus one of its own:
//
//   ⚠ IT MAY NEVER BE `myTurn - myTurnPersonal`. The arithmetic agrees; the disclosure does not.
//     `capFor` gates the "of N" on `shown === count`, so a subtracted figure has no denominator of
//     its own to compare against and the line silently loses its cap.
describe('myTurnOtherCapDisclosure', () => {
  const split = counts({
    myTurn: 50,
    myTurnTotal: 148,
    myTurnPersonal: 12,
    myTurnPersonalTotal: 30,
    myTurnOther: 38,
    myTurnOtherTotal: 118,
  });

  it('discloses the OTHER total, never the broad or the personal one', () => {
    const cap = myTurnOtherCapDisclosure(38, split);
    expect(cap?.shown).toBe(38);
    expect(cap?.total).toBe(118);
    expect(cap?.title).toContain('118');
    expect(cap?.title).not.toContain('148');
    expect(cap?.title).not.toContain('30');
  });

  it('the broad rule would have said NOTHING about the same line', () => {
    // 38 !== counts.myTurn (50), so the shared guard rejects it — the "+" would vanish silently.
    expect(myTurnCapDisclosure(38, split)).toBeNull();
    expect(myTurnOtherCapDisclosure(38, split)).not.toBeNull();
  });

  it('the SUBTRACTED spelling would have disclosed nothing at all — the rule’s whole point', () => {
    // `myTurn - myTurnPersonal` is 38 here too, and every existing rule refuses to qualify it:
    // the broad pair fails the equality and the personal pair describes a different population.
    // Only a fold with its OWN denominator can carry a cap.
    const subtracted = split.myTurn - (split.myTurnPersonal as number);
    expect(subtracted).toBe(38);
    expect(myTurnCapDisclosure(subtracted, split)).toBeNull();
    expect(myTurnPersonalCapDisclosure(subtracted, split)).toBeNull();
  });

  it('stays silent when the other population is fully painted', () => {
    expect(
      myTurnOtherCapDisclosure(38, counts({ myTurnOther: 38, myTurnOtherTotal: 38 })),
    ).toBeNull();
  });

  it('keeps the same-snapshot guard', () => {
    expect(myTurnOtherCapDisclosure(30, split)).toBeNull();
  });

  it('⚠ does NOT fall back to the broad pair, unlike its personal twin', () => {
    // The personal fallback exists because a pre-split response made the notification surfaces
    // DISPLAY the broad figure. Nothing displays an "other" figure on such a response — the brief
    // renders its single broad line instead — so there is nothing to qualify.
    const old = counts({ myTurn: 50, myTurnTotal: 148 });
    expect(myTurnOtherCapDisclosure(50, old)).toBeNull();
    expect(myTurnPersonalCapDisclosure(50, old)?.total).toBe(148);
  });

  it('does NOT borrow a total when only the OTHER count is missing its own', () => {
    expect(myTurnOtherCapDisclosure(38, counts({ myTurn: 50, myTurnTotal: 148, myTurnOther: 38 })))
      .toBeNull();
  });

  it('says nothing while the brief is still loading', () => {
    expect(myTurnOtherCapDisclosure(38, undefined)).toBeNull();
    expect(myTurnOtherCapDisclosure(38, null)).toBeNull();
  });

  // ── the invariant the two lines rest on ───────────────────────────────────────────────────
  it('the two lines are DISJOINT and EXHAUSTIVE over the same cards', () => {
    // Pinned server-side too; pinned here because the strip renders both figures side by side and
    // a reader can add them. If these ever stop summing, one of the two lines is a lie.
    expect((split.myTurnPersonal as number) + (split.myTurnOther as number)).toBe(split.myTurn);
    expect((split.myTurnPersonalTotal as number) + (split.myTurnOtherTotal as number)).toBe(
      split.myTurnTotal,
    );
  });
});

// ── The banner's headline split ("2 yours · 3 in your repos") ─────────────────────────────────
//
// The POPULATION is unchanged — the chips, the dropdown badges and the OS notification all still
// count the sum. This only says which half is which, because a new PR in a repo you maintain is
// orbit rather than ownership and reporting the two as one figure is what made the banner nag.
describe('relevanceSplit (one workspace)', () => {
  it('reads both halves when the server sent them', () => {
    expect(relevanceSplit(counts({ myTurnDirect: 2, myTurnMaintained: 3 }))).toEqual({
      direct: 2,
      maintained: 3,
    });
  });

  it('⚠ BOTH FIELDS OR NEITHER — half a split is not a split', () => {
    // Rendering "2 yours" beside a total of 5 with nothing accounting for the other 3 is the
    // one-row-two-populations defect, and `maintained = count - direct` would silently absorb any
    // future third relevance into "in your repos".
    expect(relevanceSplit(counts({ myTurnPersonal: 5, myTurnDirect: 2 }))).toBeNull();
    expect(relevanceSplit(counts({ myTurnPersonal: 5, myTurnMaintained: 3 }))).toBeNull();
    expect(relevanceSplit(counts({ myTurnPersonal: 5 }))).toBeNull();
  });

  it('a ZERO half is a real answer, not an absent one', () => {
    expect(relevanceSplit(counts({ myTurnDirect: 0, myTurnMaintained: 4 }))).toEqual({
      direct: 0,
      maintained: 4,
    });
  });

  it('the halves sum to the personal count the surfaces display', () => {
    const c = counts({ myTurnPersonal: 5, myTurnDirect: 2, myTurnMaintained: 3 });
    const s = relevanceSplit(c);
    expect((s as { direct: number }).direct + (s as { maintained: number }).maintained).toBe(
      personalMyTurnCount(c),
    );
  });
});

describe('sumRelevanceSplit (the banner headline)', () => {
  const line = (direct: number, maintained: number): { split: { direct: number; maintained: number } | null } => ({
    split: { direct, maintained },
  });

  it('sums across workspaces', () => {
    expect(sumRelevanceSplit([line(2, 3), line(1, 0)])).toEqual({ direct: 3, maintained: 3 });
  });

  it('⚠ REFUSES when ANY contributing line lacks the split', () => {
    // Mixed responses are real: the active workspace's counts are fresh per request while the
    // roll-up lines ride a 5-min cache, so one can predate a deploy the other followed. Summing
    // the halves over some lines and the whole over others prints two numbers that do not add up
    // to the total beside them.
    expect(sumRelevanceSplit([line(2, 3), { split: null }])).toBeNull();
    expect(sumRelevanceSplit([{ split: null }])).toBeNull();
  });

  it('says nothing when there are no lines at all', () => {
    expect(sumRelevanceSplit([])).toBeNull();
  });
});

describe('passesPersonalLens (the "mine" half)', () => {
  const card = (over: Partial<InsightCard>): InsightCard =>
    ({ kind: 'my_turn', personal: true, ...over }) as InsightCard;

  it('keeps personal my_turn cards and drops the rest', () => {
    expect(passesPersonalLens(card({ personal: true }))).toBe(true);
    expect(passesPersonalLens(card({ personal: false }))).toBe(false);
  });

  it('keeps a my_turn card whose flag is ABSENT — advisory, and absence means personal', () => {
    expect(passesPersonalLens(card({ personal: undefined }))).toBe(true);
  });

  it('reads `personal`, NOT `relevance` — it must survive a pre-split response', () => {
    // `personal` IS `relevance !== 'none'` and the server writes it on every row. Deriving this
    // predicate from `relevance` instead would hide EVERY card on a response that predates the
    // three-way split.
    expect(passesPersonalLens(card({ personal: true, relevance: undefined }))).toBe(true);
    expect(passesPersonalLens(card({ personal: true, relevance: 'maintained' }))).toBe(true);
  });

  it('never touches another kind — no other card carries the flag at all', () => {
    expect(passesPersonalLens(card({ kind: 'stalled_review', personal: undefined }))).toBe(true);
    expect(passesPersonalLens(card({ kind: 'untouched_thread', personal: undefined }))).toBe(true);
  });
});

describe('passesOtherLens (the "review or reply" half)', () => {
  const card = (over: Partial<InsightCard>): InsightCard =>
    ({ kind: 'my_turn', ...over }) as InsightCard;

  it('keeps ONLY relevance:none my_turn cards', () => {
    expect(passesOtherLens(card({ relevance: 'none' }))).toBe(true);
    expect(passesOtherLens(card({ relevance: 'direct' }))).toBe(false);
    expect(passesOtherLens(card({ relevance: 'maintained' }))).toBe(false);
  });

  it('⚠ an ABSENT relevance is NOT in this half', () => {
    // The two lenses are deliberately not exact complements over unclassifiable rows: 'mine'
    // keeps an unknown card (over-showing beats hiding work) and 'others' simply never claims it.
    // A pre-split response therefore paints an EMPTY 'others' board rather than a mislabelled
    // full one — and the brief does not offer the line on such a response, so nobody lands there.
    expect(passesOtherLens(card({ relevance: undefined, personal: false }))).toBe(false);
  });

  it('never touches another kind', () => {
    expect(passesOtherLens(card({ kind: 'stalled_review' }))).toBe(true);
    // ⚠ `ci_failing` is personal BY CONSTRUCTION (your own red PRs + trunk in repos you maintain),
    // so hiding it under 'others' would hide work that IS yours from a reader who asked only to
    // see the backlog. The lens narrows `my_turn` and nothing else, in BOTH directions.
    expect(passesOtherLens(card({ kind: 'ci_failing' }))).toBe(true);
  });
});

describe('passesRelevanceLens (the one predicate the board and the banner share)', () => {
  const card = (over: Partial<InsightCard>): InsightCard =>
    ({ kind: 'my_turn', ...over }) as InsightCard;

  it('null keeps everything', () => {
    expect(passesRelevanceLens(card({ relevance: 'none', personal: false }), null)).toBe(true);
    expect(passesRelevanceLens(card({ relevance: 'direct', personal: true }), null)).toBe(true);
  });

  it('the two halves PARTITION the classified cards', () => {
    for (const rel of ['direct', 'maintained', 'none'] as const) {
      const c = card({ relevance: rel, personal: rel !== 'none' });
      const mine = passesRelevanceLens(c, 'mine');
      const others = passesRelevanceLens(c, 'others');
      // Exactly one half claims each card — which is what makes the brief's two lines mutually
      // exclusive on the board as well as in the strip.
      expect(mine !== others).toBe(true);
    }
  });
});

// ── THE CARD LABELS: three, off `relevance` ──────────────────────────────────────────────────
//
// The `personal` boolean conflated two different relationships. "Somebody else opened a PR in a
// repo you maintain" is ORBIT, not ownership — labelling it "Your turn" is the over-claim the
// reporter objected to ("work on repos" vs "work tied to me directly through authorship, reply or
// merge"). The KIND stays neutral; the claim is per card.
describe('cardKindLabel (my_turn)', () => {
  const card = (over: Partial<InsightCard>): InsightCard =>
    ({ kind: 'my_turn', ...over }) as InsightCard;

  it('direct claims you, maintained claims your ground, none claims nothing', () => {
    expect(cardKindLabel(card({ relevance: 'direct' }))).toBe('Your turn');
    expect(cardKindLabel(card({ relevance: 'maintained' }))).toBe('In your repos');
    expect(cardKindLabel(card({ relevance: 'none' }))).toBe(KIND_LABEL.my_turn);
  });

  it('⚠ an ABSENT relevance renders the NEUTRAL label, even with personal:true', () => {
    // The opposite of the wire's tolerance rule, deliberately: absence ⇒ personal is the safe
    // direction for NOTIFYING, but a missing field may never invent an ownership claim ON SCREEN.
    // The only way to see this is a server too old to send the field, where "Review or reply" is
    // still true.
    expect(cardKindLabel(card({ personal: true }))).toBe(KIND_LABEL.my_turn);
    expect(cardKindLabel(card({ personal: false }))).toBe(KIND_LABEL.my_turn);
  });

  it('the three labels are DISTINCT — the split is invisible if two of them collide', () => {
    const labels = (['direct', 'maintained', 'none'] as const).map((r) =>
      cardKindLabel(card({ relevance: r })),
    );
    expect(new Set(labels).size).toBe(3);
  });

  it('the ci_failing arms keep their own two labels', () => {
    expect(cardKindLabel({ kind: 'ci_failing', arm: 'your_pr' } as InsightCard)).toBe(
      'CI failing on your PR',
    );
    expect(cardKindLabel({ kind: 'ci_failing', arm: 'trunk' } as InsightCard)).toBe(
      'Trunk CI failing',
    );
  });

  it('every other kind is called what its kind is called', () => {
    expect(cardKindLabel({ kind: 'stalled_review' } as InsightCard)).toBe(KIND_LABEL.stalled_review);
    expect(cardKindLabel({ kind: 'reviewer_load' } as InsightCard)).toBe(KIND_LABEL.reviewer_load);
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
