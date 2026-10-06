// CONTRIBUTION CARDS — the pure half (cards.ts). What this pins:
//   1. Partition: a member with a current card is read as the card; of the rest, the
//      TICKET_REVIEW_MAX_DIFFS (4) most recently updated are diffs and the overflow goes to the
//      pre-pass. Deterministic: ties by prId, a missing time last, input order irrelevant.
//   2. A pre-pass failure falls back to a diff while the fallback cap allows, else it is unread —
//      never dropped.
//   3. The run's cards are kept only for members it was shown as diffs; unknown refs, card members,
//      repeats and empty cards are dropped. Every field is re-checked (enums, clipping, caps).
//   4. Currency: a card holds while its head is the PR's synced head (a merged head never moves);
//      no synced head never matches.
//
//   pnpm --filter @pierre-review/backend test ticket-review/cards
import { describe, expect, it } from 'vitest';
import { TICKET_REVIEW_MAX_DIFFS } from '@pierre-review/shared';
import {
  CARD_INTERFACES_MAX,
  CARD_SUMMARY_CHARS,
  TICKET_REVIEW_MAX_FALLBACK_DIFFS,
  cardIsCurrent,
  cardText,
  normaliseCard,
  partitionMembers,
  placePrepassFailures,
  validateRunCards,
} from './cards.js';

const at = (min: number): Date => new Date(Date.UTC(2026, 9, 1, 0, min));

describe('partitionMembers', () => {
  const members = [
    { prId: 1, updatedAt: at(1) },
    { prId: 2, updatedAt: at(9) },
    { prId: 3, updatedAt: at(5) },
    { prId: 4, updatedAt: at(7) },
    { prId: 5, updatedAt: at(3) },
    { prId: 6, updatedAt: null },
    { prId: 7, updatedAt: at(7) },
    { prId: 8, updatedAt: at(8) },
  ];

  it('cards first, then the 4 most recently updated as diffs, the rest to the pre-pass', () => {
    expect(TICKET_REVIEW_MAX_DIFFS).toBe(4);
    const p = partitionMembers(members, new Set([2, 5]));
    expect(p.cards).toEqual([2, 5]);
    // 8 (min 8), then 4 and 7 tie at min 7 (prId order), then 3 (min 5).
    expect(p.diffs).toEqual([8, 4, 7, 3]);
    // 1 (min 1), then 6 (no time) last.
    expect(p.prepass).toEqual([1, 6]);
  });

  it('is deterministic whatever the input order', () => {
    const shuffled = [...members].reverse();
    const a = partitionMembers(members, new Set([2]));
    const b = partitionMembers(shuffled, new Set([2]));
    expect(b.diffs).toEqual(a.diffs);
    expect(b.prepass).toEqual(a.prepass);
  });

  it('no pre-pass while at most 4 members lack a card', () => {
    const p = partitionMembers(members, new Set([1, 2, 3, 4]));
    expect(p.diffs).toHaveLength(4);
    expect(p.prepass).toEqual([]);
    expect(partitionMembers([], new Set()).diffs).toEqual([]);
  });

  it('every member has a card: nothing is read as a diff', () => {
    const p = partitionMembers(members, new Set(members.map((m) => m.prId)));
    expect(p.diffs).toEqual([]);
    expect(p.prepass).toEqual([]);
    expect(p.cards).toEqual(members.map((m) => m.prId));
  });
});

describe('placePrepassFailures', () => {
  it('falls back to a diff while the cap allows, then names the rest unread', () => {
    expect(TICKET_REVIEW_MAX_FALLBACK_DIFFS).toBe(2);
    expect(placePrepassFailures([10, 11, 12, 13, 14], new Set([11]))).toEqual({
      fallbackDiffs: [10, 12],
      unread: [13, 14],
    });
    expect(placePrepassFailures([10, 11], new Set([10, 11]))).toEqual({ fallbackDiffs: [], unread: [] });
  });
});

describe('normaliseCard', () => {
  it('keeps a valid card and re-checks every field', () => {
    const c = normaliseCard({
      summary: '  Adds the export endpoint.  ',
      interfaces: [
        { kind: 'endpoint', name: 'GET /api/export', change: 'added', note: 'CSV body' },
        { kind: 'weird', name: 'Order.total', change: 'changed' },
        { kind: 'field', name: 'x', change: 'renamed' },
        { kind: 'field', name: '   ', change: 'added' },
      ],
      criteria: [{ criterion: 'CSV export', how: 'new route', files: ['a.ts', 7] }, { criterion: 'x' }],
      looseEnds: ['TODO: PDF', '', 3],
    });
    expect(c).toEqual({
      summary: 'Adds the export endpoint.',
      interfaces: [
        { kind: 'endpoint', name: 'GET /api/export', change: 'added', note: 'CSV body' },
        { kind: 'other', name: 'Order.total', change: 'changed', note: null },
      ],
      criteria: [{ criterion: 'CSV export', how: 'new route', files: ['a.ts'] }],
      looseEnds: ['TODO: PDF'],
    });
  });

  it('refuses a card with no summary, clips and caps', () => {
    expect(normaliseCard({ summary: '  ', interfaces: [] })).toBeNull();
    expect(normaliseCard(null)).toBeNull();
    const big = normaliseCard({
      summary: 'x'.repeat(CARD_SUMMARY_CHARS * 2),
      interfaces: Array.from({ length: CARD_INTERFACES_MAX + 5 }, (_, i) => ({ kind: 'field', name: `f${i}`, change: 'added' })),
    });
    expect(big?.summary.length).toBe(CARD_SUMMARY_CHARS);
    expect(big?.interfaces).toHaveLength(CARD_INTERFACES_MAX);
  });
});

describe('validateRunCards', () => {
  const shown = [
    { ref: 'PR1', prId: 100 },
    { ref: 'PR3', prId: 300 },
  ];
  it('keeps cards for the diff members shown, first per member', () => {
    const out = validateRunCards(
      [
        { pr: 'PR1', summary: 'first', interfaces: [] },
        { pr: 'PR1', summary: 'second', interfaces: [] },
        { pr: 'PR2', summary: 'a card member', interfaces: [] },
        { pr: 'PR9', summary: 'unknown', interfaces: [] },
        { pr: 'PR3', summary: '', interfaces: [] },
        'garbage',
      ],
      shown,
    );
    expect([...out.keys()]).toEqual([100]);
    expect(out.get(100)?.summary).toBe('first');
  });
  it("rewrites the run's refs to repo#number — a card outlives the run", () => {
    const out = validateRunCards(
      [{ pr: 'PR1', summary: 'Depends on PR3; PR12 unknown.', interfaces: [], looseEnds: ['Needs PR3 first'] }],
      shown,
      new Map([
        ['PR1', 'api#1'],
        ['PR3', 'web#9'],
      ]),
    );
    expect(out.get(100)?.summary).toBe('Depends on web#9; PR12 unknown.');
    expect(out.get(100)?.looseEnds).toEqual(['Needs web#9 first']);
  });
  it('no cards field is no cards', () => {
    expect(validateRunCards(undefined, shown).size).toBe(0);
  });
});

describe('cardIsCurrent', () => {
  it('holds exactly while the head matches; an empty head never matches', () => {
    expect(cardIsCurrent({ headSha: 'abc' }, { headSha: 'abc' })).toBe(true);
    expect(cardIsCurrent({ headSha: 'abc' }, { headSha: 'def' })).toBe(false);
    expect(cardIsCurrent({ headSha: '' }, { headSha: '' })).toBe(false);
  });
});

describe('cardText', () => {
  it('renders every part', () => {
    const t = cardText({
      summary: 'S',
      interfaces: [{ kind: 'event', name: 'order.paid', change: 'added', note: null }],
      criteria: [{ criterion: 'AC1', how: 'emits it', files: ['e.ts'] }],
      looseEnds: ['flag off'],
    });
    expect(t).toContain('- added event order.paid');
    expect(t).toContain('- AC1: emits it (e.ts)');
    expect(t).toContain('Loose ends:\n- flag off');
  });
});
