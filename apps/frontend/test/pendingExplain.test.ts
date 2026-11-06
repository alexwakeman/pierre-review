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
//   4. A STRICT-GROUP TAB SAYS SO. In Dependencies a low-scoring security item still sits above every
//      bump, so "listed by score" alone would be false there; My turn is its fixed groups, longest
//      waiting first.
//   5. THE WORKING IS PRINTED WITH THE WEIGHTS THE SERVER SCORED WITH (`rules.weights` on the
//      response) — fixed today, and the arithmetic must still add up under any weights.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  DO_NEXT_RULES,
  MY_TURN_OLDER_DAYS,
  MY_TURN_ORDER,
  PENDING_DO_NEXT_SIZE,
  PENDING_SEVERITY,
  type DoNextAdjustment,
  type DoNextProximityBase,
  type DoNextWeights,
  type InsightCard,
  type MyTurnCardReason,
  type MyTurnRelevance,
  type PendingCardScore,
  type PendingRankRules,
} from '@pierre-review/shared';
import {
  agePhrase,
  BASE_LABEL,
  capSentence,
  colourReason,
  explainCard,
  hoursPhrase,
  orderSentence,
  ordinal,
  scoreBreakdown,
  whoseItIs,
  whyHere,
  type PendingBoardState,
} from '../src/components/Activity/pendingExplain.js';
import { WEIGHT_KEYS, WEIGHT_LABEL } from '../src/components/settings/myTurnSettingsForm.js';

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

/** The fixed weights, and three other weightings the arithmetic must still add up under. */
const BALANCED: DoNextWeights = { ...DO_NEXT_RULES.weights };
const MINE_FIRST: DoNextWeights = { proximity: 0.3, stall: 0.1, relevance: 0.6 };
const WEIGHTINGS: [string, DoNextWeights][] = [
  ['fixed', BALANCED],
  ['relevance-heavy', MINE_FIRST],
  ['stall-heavy', { proximity: 0.2, stall: 0.7, relevance: 0.1 }],
  ['proximity-heavy', { proximity: 0.8, stall: 0.1, relevance: 0.1 }],
];

/** The ranking rules a response carries. */
function rulesOf(w: DoNextWeights): PendingRankRules {
  return { weights: w, myTurnOrder: [...MY_TURN_ORDER], myTurnOff: ['watched_repo_pr'] };
}

/** The server's score, spelled exactly as db/work-plan.ts spells it. */
function serverScore(
  p: Pick<PendingCardScore, 'proximity' | 'stallRisk' | 'relevance'>,
  w: DoNextWeights = BALANCED,
): number {
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
    tab: 'review',
    indexById: new Map(cards.map((c, i) => [c.id, i])),
    doNextCount: Math.min(PENDING_DO_NEXT_SIZE, cards.length),
    total: cards.length,
    viewName: 'Waiting on review',
    scores: undefined,
    ...over,
  };
}

describe('the score working adds up to the score', () => {
  it('for every base, adjustment set, stall value and relevance tier — under any weights', () => {
    const bases = Object.keys(DO_NEXT_RULES.proximity) as DoNextProximityBase[];
    const adjs = Object.keys(DO_NEXT_RULES.adjustments) as DoNextAdjustment[];
    const subsets: DoNextAdjustment[][] = [[]];
    for (const a of adjs) for (const s of [...subsets]) subsets.push([...s, a]);
    const stalls = [DO_NEXT_RULES.stallBase, ...DO_NEXT_RULES.stallBuckets.map((b) => b.risk)];
    const rels: MyTurnRelevance[] = ['direct', 'maintained', 'none'];
    let checked = 0;
    for (const [preset, w] of WEIGHTINGS) {
      for (const base of bases) {
        for (const set of subsets) {
          let raw: number = DO_NEXT_RULES.proximity[base];
          for (const a of set) raw += DO_NEXT_RULES.adjustments[a];
          const proximity = Math.round(Math.min(1, Math.max(0, raw)) * 10_000) / 10_000;
          for (const stallRisk of stalls) {
            for (const relevance of rels) {
              const p = placement({ proximityBase: base, adjustments: set, proximity, stallRisk, relevance });
              p.score = serverScore(p, w);
              const b = scoreBreakdown(p, w);
              const sum = b.rows.reduce((n, r) => n + r.points, 0);
              // One decimal is exact for every value the rules allow — see `outOf100`.
              expect([preset, base, set, stallRisk, relevance, Math.round(sum * 10) / 10]).toEqual([
                preset,
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
    }
    expect(checked).toBe(
      WEIGHTINGS.length * bases.length * subsets.length * stalls.length * rels.length,
    );
  });

  it('prints the weights it is given', () => {
    expect(scoreBreakdown(placement(), MINE_FIRST).rows.map((r) => r.weight)).toEqual([30, 10, 60]);
    expect(scoreBreakdown(placement(), BALANCED).rows.map((r) => r.weight)).toEqual([
      Math.round(DO_NEXT_RULES.weights.proximity * 100),
      Math.round(DO_NEXT_RULES.weights.stall * 100),
      Math.round(DO_NEXT_RULES.weights.relevance * 100),
    ]);
  });

  it('names each part by its one spelling (WEIGHT_LABEL)', () => {
    const rows = scoreBreakdown(placement(), BALANCED).rows;
    expect(rows.map((r) => r.key)).toEqual([...WEIGHT_KEYS]);
    expect(rows.map((r) => r.label)).toEqual(WEIGHT_KEYS.map((k) => WEIGHT_LABEL[k]));
  });

  it('names the clock the age is measured from, and a trunk’s as our last look', () => {
    expect(scoreBreakdown(placement({ ageHours: 72, clock: 'requested' }), BALANCED).rows[1]!.note).toBe(
      '3 days since you were asked',
    );
    expect(
      scoreBreakdown(placement({ proximityBase: 'red_trunk', ageHours: 5, clock: 'observed' }), BALANCED)
        .rows[1]!.note,
    ).toBe('5 hours since we last checked the branch');
    expect(scoreBreakdown(placement({ ageHours: null, clock: null }), BALANCED).rows[1]!.note).toBe(
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
      scoreBreakdown(placement(), BALANCED).total,
    );
    const old = explainCard(cards[0]!, boardOf(cards));
    expect(old.score).toBeNull();
    expect(old.order).toBe('Listed in the order the server sent.');
  });

  it('prints the working with the response’s weights — and the default only without them', () => {
    const board = (rules?: PendingRankRules): PendingBoardState => boardOf(cards, { scores, rules });
    expect(explainCard(cards[0]!, board(rulesOf(MINE_FIRST))).score!.rows.map((r) => r.weight)).toEqual(
      [30, 10, 60],
    );
    // A response predating `rules` was ranked by the product default, so that is its true working.
    expect(explainCard(cards[0]!, board()).score!.rows.map((r) => r.weight)).toEqual([50, 30, 20]);
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
  const mt = (reason: MyTurnCardReason, over: Record<string, unknown> = {}) =>
    card({ id: `myturn:${reason}:1`, kind: 'my_turn', reason, severity: 'high', relevance: 'direct', ...over });

  it('has a sentence for every one of the twelve My Turn types', () => {
    const seen = new Set<string>();
    for (const reason of MY_TURN_ORDER) {
      const why = whyHere(mt(reason, { since: '2026-08-27T09:00:00.000Z', maintained: true }));
      expect(why.length).toBeGreaterThan(20);
      seen.add(why);
    }
    // Each type says something of its own — none falls back to a shared, vaguer line.
    expect(seen.size).toBe(MY_TURN_ORDER.length);
  });

  it('says what clears each new summons', () => {
    expect(whyHere(mt('mention'))).toBe(
      'Someone @-mentioned you on this PR. Any review, comment or push from you clears it.',
    );
    expect(whyHere(mt('thread_reply'))).toBe(
      'Someone replied after your comment in a review thread. Replying there clears it; resolving the thread always does.',
    );
    expect(whyHere(mt('comment_reply'))).toBe(
      'Someone commented on this PR after your last comment. Any review, comment or push from you clears it.',
    );
    expect(whyHere(mt('pushed_since'))).toBe(
      'Someone pushed new commits after your last review or comment. It goes away when you review, comment or push.',
    );
    expect(whyHere(mt('watched_repo_pr'))).toBe(
      'A new PR you have not reviewed, commented on or pushed to. It goes away when you do one of those.',
    );
  });

  it('says what each promoted type is, and when it leaves', () => {
    expect(whyHere(mt('own_ci_red'))).toBe(
      'The latest build on your open PR failed. It goes away when the build passes.',
    );
    expect(whyHere(mt('own_conflicts'))).toBe(
      'Your PR conflicts with its base branch. It goes away when the conflict is resolved.',
    );
    expect(whyHere(mt('own_ready', { own: { kind: 'ready', forward: 'merge' } }))).toBe(
      'GitHub will merge your PR now.',
    );
    expect(whyHere(mt('own_ready', { own: { kind: 'ready', forward: 'update_branch' } }))).toBe(
      'GitHub will not merge your PR until its branch is updated.',
    );
    const thirtyHoursAgo = new Date(Date.now() - 30 * 3_600_000).toISOString();
    expect(whyHere(mt('own_thread', { since: thirtyHoursAgo }))).toBe(
      'A review comment on your PR has had no reply and no later commit for 30 hours.',
    );
  });

  it('needs no second sentence on your own PR or a direct summons — the type already says it', () => {
    for (const reason of ['own_ci_red', 'own_conflicts', 'own_ready', 'own_thread', 'mention'] as const) {
      expect(whoseItIs(mt(reason))).toBeNull();
    }
    expect(whoseItIs(mt('watched_repo_pr', { relevance: 'maintained' }))).toBe(
      'It counts as “In your repos”: you can push to this repo, or have merged a PR into it.',
    );
  });

  it('names the rule behind each new type’s colour', () => {
    expect(colourReason(mt('mention'))).toBe('someone is waiting on your reply');
    expect(colourReason(mt('thread_reply'))).toBe('someone is waiting on your reply');
    expect(colourReason(mt('comment_reply'))).toBe('someone is waiting on your reply');
    expect(colourReason(mt('pushed_since', { severity: 'warn' }))).toBe('new code since your review');
    expect(colourReason(mt('own_ci_red'))).toBe('your build is failing');
    expect(colourReason(mt('own_conflicts'))).toBe('your PR cannot merge');
    expect(colourReason(mt('own_ready', { severity: 'warn' }))).toBe('it is your own PR');
    expect(colourReason(mt('own_thread', { severity: 'warn' }))).toBe('it is your own PR');
  });
});

describe('My turn’s order, explained', () => {
  const c = card({ id: 'myturn:mention:1', kind: 'my_turn', reason: 'mention', severity: 'high', relevance: 'direct' });

  it('says My turn is its fixed groups, longest waiting first — scored or not', () => {
    const sentence = `Waiting on you, then Re-review, then Your PRs. Longest waiting first in each. Anything older than ${MY_TURN_OLDER_DAYS} days is under Older.`;
    expect(orderSentence('my_turn', true, rulesOf(BALANCED))).toBe(sentence);
    expect(orderSentence('my_turn', false)).toBe(sentence);
    const x = explainCard(
      c,
      boardOf([c], { tab: 'my_turn', scores: { [c.id]: placement() }, rules: rulesOf(BALANCED) }),
    );
    expect(x.order).toBe(sentence);
  });

  it('leaves the Dependencies sentence alone when rules are present', () => {
    expect(orderSentence('deps', true, rulesOf(MINE_FIRST))).toBe(
      `Security first, then bumps. Each is listed by Do next score, highest first. The top ${PENDING_DO_NEXT_SIZE} are Do next.`,
    );
  });

  it('a grouped list the cap cut never claims "the rest score lower" — the cut is the last groups', () => {
    const rules = rulesOf(BALANCED);
    expect(capSentence('my_turn', null, 50, 65, rules)).toBe('Showing the first 50 of 65.');
    expect(capSentence('my_turn', null, 50, 65)).toBe('Showing the first 50 of 65.');
    expect(capSentence('deps', null, 50, 70, rules)).toBe('Showing the first 50 of 70.');
    // A kind chip makes Dependencies one scored list again; the other tabs always are.
    expect(capSentence('deps', 'dependency_bump', 50, 70, rules)).toBe(
      'Showing the top 50 of 70. The rest score lower.',
    );
    expect(capSentence('review', null, 50, 176, rules)).toBe(
      'Showing the top 50 of 176. The rest score lower.',
    );
  });
});

describe('the Dependencies tab, explained', () => {
  const fix = (over: Record<string, unknown>) =>
    card({ id: 'security:1', kind: 'security', severity: 'high', dependencyUpdate: true, fix: 'proven', relevance: 'maintained', ...over });

  it('says why each kind of security card is here, and what clears it', () => {
    expect(whyHere(fix({}))).toBe(
      'A dependency bot opened this PR to fix a known security advisory. It goes away when the PR is merged or closed.',
    );
    expect(whyHere(fix({ fix: 'inferred', severity: 'warn' }))).toBe(
      'Dependabot grouped this update the way it groups security updates, and GitHub cut off the line that would confirm it. It goes away when the PR is merged or closed.',
    );
    expect(whyHere(fix({ fix: null }))).toBe(
      'A security tool flagged a known advisory on this dependency update. It goes away when the PR is merged or closed, or the tool clears it.',
    );
    expect(whyHere(fix({ fix: null, dependencyUpdate: false }))).toBe(
      'A security tool flagged a known advisory on this PR. It goes away when the tool clears it or the review thread is resolved.',
    );
    expect(whyHere(card({ id: 'deps:1', kind: 'dependency_bump', severity: 'info' }))).toBe(
      'A dependency bot opened this PR. It goes away when the PR is merged or closed.',
    );
  });

  it('says whose a dependency update is, like a merge card — and nothing for a flagged person’s PR', () => {
    expect(whoseItIs(fix({ relevance: 'maintained' }))).toBe('It is in a repo you maintain.');
    expect(whoseItIs(card({ id: 'd', kind: 'dependency_bump', severity: 'info', relevance: 'none' }))).toBe(
      'It is not your PR, and you do not maintain the repo.',
    );
    expect(whoseItIs(fix({ dependencyUpdate: false, relevance: 'direct' }))).toBeNull();
  });

  it('names the rule behind each colour', () => {
    expect(colourReason(fix({ severity: 'high' }))).toBe('it names a known security advisory');
    expect(colourReason(fix({ fix: 'inferred', severity: 'warn' }))).toBe('it is probably a security update');
    expect(colourReason(card({ id: 'd', kind: 'dependency_bump', severity: 'info' }))).toBe(
      'an ordinary update, never urgent',
    );
  });

  it('calls a failing build a failing build — a red Dependabot PR is nobody’s', () => {
    expect(BASE_LABEL.unblock_ci).toBe('failing build');
    expect(BASE_LABEL.waiting).toBe('blocked, or still being checked');
    expect(BASE_LABEL.security_alert).toBe('flagged by a security tool');
  });

  it('says the Dependencies tab is in groups, and every other tab is one scored list', () => {
    expect(orderSentence('deps', true)).toBe(
      `Security first, then bumps. Each is listed by Do next score, highest first. The top ${PENDING_DO_NEXT_SIZE} are Do next.`,
    );
    expect(orderSentence('review', true)).toBe(
      `Listed by Do next score, highest first. The top ${PENDING_DO_NEXT_SIZE} are Do next.`,
    );
    expect(orderSentence('deps', false)).toBe('Listed in the order the server sent.');
  });

  it('puts the group sentence in a Dependencies card’s popover', () => {
    const c = fix({});
    const x = explainCard(c, boardOf([c], { tab: 'deps', scores: { [c.id]: placement() } }));
    expect(x.order).toContain('Security first, then bumps.');
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
