// The Pending board's "why is this card here" copy — `pendingExplain.ts`.
//
// WHAT THIS PINS, and why each is worth a test rather than a comment:
//
//   1. THE WORKING ADDS UP. The popover prints a card's Do next score as three weighted parts with
//      their points. A reader who adds the points and does not get the total has been handed a
//      figure that cannot be checked, which is worse than no figure. Asserted over EVERY base,
//      adjustment set, stall value and relevance tier the rules allow.
//   2. THE NUMBERS ARE THE SERVER'S. Every threshold in the copy is read from the shared rules the
//      backend folds with, so the tests read the SAME constants and would fail if the copy were
//      re-typed with a literal that later drifted.
//   3. A CARD'S PLACE IS ITS RANK IN THE VIEW ON SCREEN — "4th of 176 in Waiting on review" — with
//      Do next marked, and a card with no score says so rather than inventing one.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  DO_NEXT_RULES,
  PENDING_DO_NEXT_SIZE,
  PENDING_SEVERITY,
  type DoNextAdjustment,
  type DoNextProximityBase,
  type InsightCard,
  type MyTurnRelevance,
  type PendingCardScore,
} from '@pierre-review/shared';
import {
  agePhrase,
  colourReason,
  explainCard,
  hoursPhrase,
  ordinal,
  scoreBreakdown,
  whyHere,
  type PendingBoardState,
} from '../src/components/Activity/pendingExplain.js';

const card = (fields: Record<string, unknown>): InsightCard => fields as unknown as InsightCard;

const placement = (over: Partial<PendingCardScore> = {}): PendingCardScore => ({
  score: 0.575,
  proximity: 0.55,
  proximityBase: 'review',
  adjustments: [],
  stallRisk: 0.4,
  relevance: 'direct',
  ageHours: 30,
  clock: 'requested',
  ...over,
});

/** The server's score, spelled exactly as db/work-plan.ts spells it. */
function serverScore(p: Pick<PendingCardScore, 'proximity' | 'stallRisk' | 'relevance'>): number {
  const w = DO_NEXT_RULES.weights;
  const raw =
    w.proximity * p.proximity +
    w.stall * p.stallRisk +
    w.relevance * DO_NEXT_RULES.relevanceWeight[p.relevance];
  return Math.round(raw * 10_000) / 10_000;
}

function boardOf(
  cards: InsightCard[],
  over: Partial<PendingBoardState> = {},
): PendingBoardState {
  return {
    indexById: new Map(cards.map((c, i) => [c.id, i])),
    doNextCount: Math.min(PENDING_DO_NEXT_SIZE, cards.length),
    total: cards.length,
    viewName: 'Waiting on review',
    scores: undefined,
    ...over,
  };
}

describe('the score working adds up to the score', () => {
  it('for every base, adjustment set, stall value and relevance tier', () => {
    const bases = Object.keys(DO_NEXT_RULES.proximity) as DoNextProximityBase[];
    const adjs = Object.keys(DO_NEXT_RULES.adjustments) as DoNextAdjustment[];
    const subsets: DoNextAdjustment[][] = [[]];
    for (const a of adjs) for (const s of [...subsets]) subsets.push([...s, a]);
    const stalls = [DO_NEXT_RULES.stallBase, ...DO_NEXT_RULES.stallBuckets.map((b) => b.risk)];
    const rels: MyTurnRelevance[] = ['direct', 'maintained', 'none'];
    let checked = 0;
    for (const base of bases) {
      for (const set of subsets) {
        let raw: number = DO_NEXT_RULES.proximity[base];
        for (const a of set) raw += DO_NEXT_RULES.adjustments[a];
        const proximity = Math.round(Math.min(1, Math.max(0, raw)) * 10_000) / 10_000;
        for (const stallRisk of stalls) {
          for (const relevance of rels) {
            const p = placement({ proximityBase: base, adjustments: set, proximity, stallRisk, relevance });
            p.score = serverScore(p);
            const b = scoreBreakdown(p);
            const sum = b.rows.reduce((n, r) => n + r.points, 0);
            // One decimal is exact for every value the rules allow — see `outOf100`.
            expect([base, set, stallRisk, relevance, Math.round(sum * 10) / 10]).toEqual([
              base,
              set,
              stallRisk,
              relevance,
              b.total,
            ]);
            for (const r of b.rows) expect(r.points).toBe(Math.round(r.value * r.weight) / 100);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(bases.length * subsets.length * stalls.length * rels.length);
  });

  it('prints the weights the ranker uses', () => {
    const b = scoreBreakdown(placement());
    expect(b.rows.map((r) => r.weight)).toEqual([
      Math.round(DO_NEXT_RULES.weights.proximity * 100),
      Math.round(DO_NEXT_RULES.weights.stall * 100),
      Math.round(DO_NEXT_RULES.weights.relevance * 100),
    ]);
  });

  it('names the clock the age is measured from, and a trunk’s as our last look', () => {
    expect(scoreBreakdown(placement({ ageHours: 72, clock: 'requested' })).rows[1]!.note).toBe(
      '3 days since you were asked',
    );
    expect(
      scoreBreakdown(placement({ proximityBase: 'red_trunk', ageHours: 5, clock: 'observed' })).rows[1]!
        .note,
    ).toBe('5 hours since we last checked the branch');
    expect(scoreBreakdown(placement({ ageHours: null, clock: null })).rows[1]!.note).toBe(
      'no start time to measure from',
    );
  });
});

describe('the colour rules quote the shared thresholds', () => {
  it('stalled reviews', () => {
    const t = PENDING_SEVERITY.stalledReviewHours;
    const c = (severity: string) => card({ id: 's', kind: 'stalled_review', severity, ageHours: 1 });
    expect(colourReason(c('high'))).toBe(`open ${hoursPhrase(t.high)} or more`);
    expect(colourReason(c('warn'))).toBe(`open ${hoursPhrase(t.warn)} to ${hoursPhrase(t.high)}`);
    expect(colourReason(c('info'))).toBe(`open under ${hoursPhrase(t.warn)}`);
  });

  it('untouched threads and review load', () => {
    const u = PENDING_SEVERITY.untouchedThreadHours;
    expect(colourReason(card({ id: 'u', kind: 'untouched_thread', severity: 'high' }))).toBe(
      `unanswered ${hoursPhrase(u.high)} or more`,
    );
    const r = PENDING_SEVERITY.reviewerLoadPending;
    expect(colourReason(card({ id: 'l', kind: 'reviewer_load', severity: 'warn' }))).toBe(
      `${r.warn} to ${r.high - 1} reviews waiting`,
    );
  });
});

describe('where a card sits', () => {
  const cards = Array.from({ length: 8 }, (_, i) =>
    ({ id: `c${i}`, kind: 'stalled_review', severity: 'warn', ageHours: 60 }) as unknown as InsightCard,
  );
  const scores = Object.fromEntries(cards.map((c) => [c.id, placement()]));

  it('is its rank in the view on screen, of that view’s whole population, with Do next marked', () => {
    const board = boardOf(cards, { total: 176, scores });
    expect(explainCard(cards[3]!, board).place).toBe('4th of 176 in Waiting on review · Do next');
    expect(explainCard(cards[6]!, board).place).toBe('7th of 176 in Waiting on review');
  });

  it('says how the list is ordered', () => {
    expect(explainCard(cards[0]!, boardOf(cards, { scores })).order).toBe(
      `Listed by Do next score, highest first. The top ${PENDING_DO_NEXT_SIZE} are Do next.`,
    );
  });

  it('shows the score working when there is a score, and none when the server sent none', () => {
    expect(explainCard(cards[0]!, boardOf(cards, { scores })).score?.total).toBe(
      scoreBreakdown(placement()).total,
    );
    const old = explainCard(cards[0]!, boardOf(cards));
    expect(old.score).toBeNull();
    expect(old.order).toBe('Listed in the order the server sent.');
  });

  it('places a review-load card in the people strip, unscored', () => {
    const load = { id: 'load', kind: 'reviewer_load', severity: 'info', pendingCount: 3 } as unknown as InsightCard;
    const board = boardOf(cards, { scores, indexById: new Map([['load', -1]]) });
    const x = explainCard(load, board);
    expect(x.place).toBe('In “Reviews waiting on people”, above the ranked list');
    expect(x.score).toBeNull();
  });
});

describe('what a card means', () => {
  it('has a sentence for every My turn section, and names a push-since row as one', () => {
    const reasons = ['review_request', 'thread', 'pr_approved', 'your_pr', 'watched_repo_pr', 'claude_review'];
    for (const reason of reasons) {
      expect(whyHere(card({ id: 'x', kind: 'my_turn', reason, severity: 'high' })).length).toBeGreaterThan(20);
    }
    expect(
      whyHere(card({ id: 'x', kind: 'my_turn', reason: 'watched_repo_pr', severity: 'info', ball: { kind: 'commits_after' } })),
    ).toContain('pushed new commits after your last review or comment');
  });

  it('never names "Your PR" as clearing by action — it clears by opening, and says so', () => {
    expect(whyHere(card({ id: 'x', kind: 'my_turn', reason: 'your_pr', severity: 'warn' }))).toContain(
      'Opening it clears this',
    );
  });
});

describe('the small formatters', () => {
  it('ordinal', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th',
    ]);
  });

  it('hours and ages', () => {
    expect([4, 24, 48, 96].map(hoursPhrase)).toEqual(['4 hours', '1 day', '2 days', '4 days']);
    expect([0.5, 1, 30, 47.6, 72].map(agePhrase)).toEqual([
      'under an hour',
      '1 hour',
      '30 hours',
      '2 days',
      '3 days',
    ]);
  });
});
