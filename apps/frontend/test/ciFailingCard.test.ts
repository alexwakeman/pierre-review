// The `ci_failing` card kind on the client: the two SILENT touch points a new InsightKind has,
// and its cap disclosure.
//
// WHAT THIS PINS:
//
//   1. ⚠ EVERY KIND MUST BE URL-SEATABLE. `INSIGHT_KINDS` in hooks/useUrlState.ts is a HAND-WRITTEN
//      runtime array (the union ships none), and a kind missing from it makes `?attn=<kind>` a
//      no-op: the daily-brief line that counts that kind opens an UN-isolated board, and a browser
//      Back cannot return to the narrowed one. Nothing compiles. `KIND_LABEL`, by contrast, IS
//      compiler-enforced (`Record<InsightCard['kind'], string>`), so comparing the two forwards
//      that exhaustiveness onto the array that has none.
//   2. THE CAP DISCLOSURE PAIRS NARROW WITH NARROW. `ci_failing` shares INSIGHT_CARD_CAP (15) with
//      the SURVEY kinds, which stay silent about their cap on purpose — but this one is a worklist
//      the viewer clears, so it discloses. Borrowing `myTurnTotal` as its denominator would be one
//      row mixing two populations AND (because the guard is an equality) would drop the "of N"
//      entirely on exactly the workspaces it exists for.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { DailyBriefCounts } from '@pierre-review/shared';
import { ciFailingCapDisclosure } from '../src/components/Activity/AttentionView.js';
import { KIND_LABEL } from '../src/components/Activity/AttentionCards.js';
import { INSIGHT_KINDS } from '../src/hooks/useUrlState.js';

/** A brief fold with only the fields this rule reads varied. */
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

describe('a new InsightKind reaches every hand-written list', () => {
  it('the URL isolation list matches the compiler-enforced label map', () => {
    // The failure mode is one-directional in practice — a kind is added to KIND_LABEL because tsc
    // demands it, and forgotten here — but the set comparison catches both directions.
    expect([...INSIGHT_KINDS].sort()).toEqual(Object.keys(KIND_LABEL).sort());
  });

  it('…and ci_failing is in it, so its brief line is Back-able', () => {
    expect(INSIGHT_KINDS).toContain('ci_failing');
    expect(KIND_LABEL.ci_failing).toBeTruthy();
  });
});

describe('ciFailingCapDisclosure', () => {
  it('discloses the uncapped total when the board is capped', () => {
    const cap = ciFailingCapDisclosure(15, counts({ ciFailing: 15, ciFailingTotal: 22 }));
    expect(cap?.shown).toBe(15);
    expect(cap?.total).toBe(22);
    expect(cap?.title).toContain('22');
  });

  it('says nothing when nothing was capped', () => {
    expect(ciFailingCapDisclosure(3, counts({ ciFailing: 3, ciFailingTotal: 3 }))).toBeNull();
  });

  it('says nothing when the board shows none (0 of 22 is a lie the other way)', () => {
    expect(ciFailingCapDisclosure(0, counts({ ciFailing: 0, ciFailingTotal: 22 }))).toBeNull();
  });

  it('stays silent while the two sides disagree (the same-snapshot guard)', () => {
    // The board is live; the brief sits behind a ≤5-min TTL. "13 of 22" would pair a live
    // numerator with a stale denominator — one row, two populations.
    expect(ciFailingCapDisclosure(13, counts({ ciFailing: 15, ciFailingTotal: 22 }))).toBeNull();
  });

  it('⚠ never borrows myTurnTotal as its denominator', () => {
    // A response carrying the my_turn totals but no ci ones discloses NOTHING rather than
    // qualifying a red-build count with a my_turn population.
    const cap = ciFailingCapDisclosure(15, counts({ ciFailing: 15, myTurn: 50, myTurnTotal: 148 }));
    expect(cap).toBeNull();
  });

  it('degrades silently on a response predating the field', () => {
    expect(ciFailingCapDisclosure(15, counts())).toBeNull();
    expect(ciFailingCapDisclosure(15, null)).toBeNull();
    expect(ciFailingCapDisclosure(15, undefined)).toBeNull();
  });
});
