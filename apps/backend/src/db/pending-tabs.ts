// ── THE PENDING BOARD'S TABS (CORE, deterministic, no AI) ───────────────────────────────────
//
// Six tabs (`PENDING_TABS` in packages/shared/src/pending-rules.ts), each a scored list: every PR
// card is scored by the one Do next scorer (`scoreCards`, db/work-plan.ts), with the READER's
// weights (Settings → My Turn), and each tab lists its cards highest score first — except the two
// STRICT-GROUP tabs, whose groups come first: My turn by card type in the READER's order
// (`groupByReason`) and Dependencies security before bumps (`groupByKind`), each scored within.
// There is no severity-first sort and no cross-kind spread rule — a card competes only with the
// cards in its own tab (and group), and a PR with two jobs appears once per job, in each job's tab.
//
// ⚠ THE RULES RIDE THE RESPONSE (`PendingBoard.rules`). The board's info popovers and guide explain
// the order the reader actually got — their weights and their type order — never the constants.
//
// ⚠ IT RANKS THE UNCAPPED FOLD, THEN CAPS. The caller passes `getWorkspaceInsights(…, { uncapped:
// true })`; a per-kind cap applied first (in severity / newest order) would hand this ranker the
// wrong cards. Each LIST GROUP (kind × My turn's "Only yours" side × who opened it) is then listed
// to `boardListCap`, highest score first, so every view the board can show — tab, kind chip,
// relevance lens, author lens — is its own true top.
//
// ⚠ EVERY COUNT IS ITS OWN POPULATION. The People / Automation splits are counted HERE, off the
// uncapped cards, with the SAME predicate the SPA filters by (`pendingAuthorSideOf`) — so
// `people + automation === total` by construction and no pill is ever a subtraction.
//
// ⚠ SUGGESTIONS ARE LOOKED UP ONLY FOR THE TOP "NEEDS A REVIEWER" CARDS. The lookup is network-
// backed per PR (CODEOWNERS), so it runs for `routingSuggestCap` cards, AFTER ranking decided which.
import {
  PENDING_LIMITS,
  PENDING_TABS,
  pendingAuthorSideOf,
  type InsightCard,
  type MyTurnCardReason,
  type PendingAuthorSplit,
  type PendingCardScore,
  type PendingRankRules,
  type PendingTab,
  type ReviewerRoutingCard,
  type User,
} from '@pierre-review/shared';
import { inArray } from 'drizzle-orm';
import { db, schema } from './client.js';
import { mapUser, suggestRoutingReviewers, type BotScope, type getWorkspaceInsights } from './queries.js';
import { scoreCards, type ScoredCard } from './work-plan.js';
import { getMyTurnSettings, rankRulesOf } from './my-turn-settings.js';

export interface PendingBoard {
  tabs: PendingTab[];
  /** Only the cards the tabs list, plus the review-load strip. */
  cards: InsightCard[];
  /** Users the suggestion pass named that the fold did not already carry. */
  extraUsers: User[];
  scores: Record<string, PendingCardScore>;
  /** The weights and My turn type order these tabs were ranked with — `rankRulesOf(settings)`. */
  rules: PendingRankRules;
}

/** Highest score first; ties go to the longer wait, then the lower PR id, then the card id — a
 *  total order, so two polls of unchanged data list the same cards in the same order. */
export function compareScored(a: ScoredCard, b: ScoredCard): number {
  return (
    b.score - a.score ||
    (b.ageHours ?? -1) - (a.ageHours ?? -1) ||
    (a.prId ?? Number.MAX_SAFE_INTEGER) - (b.prId ?? Number.MAX_SAFE_INTEGER) ||
    a.cardId.localeCompare(b.cardId)
  );
}

/** Which capped list a card counts against: kind × (My turn's "Only yours" side) × author side.
 *  Each view the board can show — tab, chip, relevance lens, author lens, or two of them — is then
 *  its own true top `boardListCap`. The My turn side is the board's own lens predicate: 'mine'
 *  keeps a card unless it is explicitly not personal (AttentionView's passesPersonalLens); the
 *  author side is `pendingAuthorSideOf`, the predicate the SPA's lens filters by. (The My Turn
 *  stream extends this; keep the segments in this order.) */
export function listGroupOf(card: InsightCard): string {
  const side = pendingAuthorSideOf(card);
  if (card.kind === 'my_turn') return `my_turn:${card.personal === false ? 'others' : 'mine'}:${side}`;
  return `${card.kind}:${side}`;
}

/** The strict-group rank inside a tab — ONE comparator for both strict-group tabs:
 *   • My turn (`groupByReason`): the index of the card's `reason` in the READER'S type order
 *     (Settings → My Turn), so their first type is listed first whatever the scores;
 *   • Dependencies (`groupByKind`): the kind's index in `def.kinds` — security before bumps;
 *   • every other tab: 0 (purely scored). */
export function tabGroupRank(
  def: (typeof PENDING_TABS)[number],
  card: InsightCard,
  myTurnOrderIdx: ReadonlyMap<MyTurnCardReason, number>,
): number {
  if (def.groupByReason === true && card.kind === 'my_turn') {
    return myTurnOrderIdx.get(card.reason) ?? Number.MAX_SAFE_INTEGER;
  }
  return def.groupByKind === true ? def.kinds.indexOf(card.kind) : 0;
}

/** THE LISTING RULE, pure and network-free: one tab's scored cards in the order the tab shows them
 *  (in a strict-group tab by group first, then highest score first), each LIST GROUP
 *  (`listGroupOf`) cut to `boardListCap`. `rankPendingTabs` lists with it, and the Pro work plan
 *  draws its rows only from what it lists (`listedCardIds`), so the two cannot disagree about
 *  which cards are on the board. */
export function listTab(
  def: (typeof PENDING_TABS)[number],
  scored: readonly ScoredCard[],
  byId: ReadonlyMap<string, InsightCard>,
  myTurnOrderIdx: ReadonlyMap<MyTurnCardReason, number>,
): ScoredCard[] {
  const rankedKinds: readonly InsightCard['kind'][] = def.kinds.filter((k) => k !== 'reviewer_load');
  const inTab = scored
    .filter((s) => {
      const card = byId.get(s.cardId);
      return card != null && rankedKinds.includes(card.kind);
    })
    .sort(
      (a, b) =>
        tabGroupRank(def, byId.get(a.cardId)!, myTurnOrderIdx) -
          tabGroupRank(def, byId.get(b.cardId)!, myTurnOrderIdx) || compareScored(a, b),
    );
  // The cap is per LIST GROUP (`listGroupOf`): the card's kind, for My turn also which side of
  // "Only yours" it falls on, and who opened it. Each view the board can show — the whole tab,
  // one kind's chip, My turn's "Only yours" / its complement, People / Automation — is then its
  // own true top `boardListCap`, so the figure a view shows is always min(its total, the cap)
  // and the daily brief can say that same number.
  const perGroup = new Map<string, number>();
  const out: ScoredCard[] = [];
  for (const s of inTab) {
    const group = listGroupOf(byId.get(s.cardId)!);
    const n = perGroup.get(group) ?? 0;
    if (n >= PENDING_LIMITS.boardListCap) continue;
    perGroup.set(group, n + 1);
    out.push(s);
  }
  return out;
}

/** Every card id any tab lists, for these cards, scores and My turn type order — the population
 *  the Pro work plan may name. A plan row whose card the board does not list would put its
 *  sentence on a card the reader cannot find. */
export function listedCardIds(
  cards: readonly InsightCard[],
  scored: readonly ScoredCard[],
  myTurnOrder: readonly MyTurnCardReason[],
): Set<string> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const orderIdx = new Map(myTurnOrder.map((r, i) => [r, i] as const));
  const ids = new Set<string>();
  for (const def of PENDING_TABS) for (const s of listTab(def, scored, byId, orderIdx)) ids.add(s.cardId);
  return ids;
}

/** One population split by who opened each PR — `pendingAuthorSideOf`, the SPA lens's predicate. */
function authorSplit(cards: readonly InsightCard[]): PendingAuthorSplit {
  const split: PendingAuthorSplit = { people: 0, automation: 0 };
  for (const c of cards) split[pendingAuthorSideOf(c)] += 1;
  return split;
}

export async function rankPendingTabs(
  accountId: number,
  scope: BotScope,
  insights: Awaited<ReturnType<typeof getWorkspaceInsights>>,
  now: number = Date.now(),
): Promise<PendingBoard> {
  const byId = new Map(insights.cards.map((c) => [c.id, c]));
  // The reader's weights and type order, read once for the whole board.
  const settings = await getMyTurnSettings(accountId);
  const orderIdx = new Map(settings.order.map((r, i) => [r, i] as const));
  const { scored } =
    scope.repoIds.length === 0
      ? { scored: [] as ScoredCard[] }
      : await scoreCards(accountId, insights.cards, now, settings.weights);
  const totals = insights.kindTotals ?? {};

  const tabs: PendingTab[] = [];
  const listed: InsightCard[] = [];
  const scores: Record<string, PendingCardScore> = {};
  let routingTop: ReviewerRoutingCard[] = [];

  for (const def of PENDING_TABS) {
    const rankedKinds: readonly InsightCard['kind'][] = def.kinds.filter((k) => k !== 'reviewer_load');
    // Every scored card of the tab's kinds — in a strict-group tab by group first — highest score
    // first, then listed per list group to the cap (`listTab`, the one listing rule).
    const ids: string[] = [];
    for (const s of listTab(def, scored, byId, orderIdx)) {
      ids.push(s.cardId);
      listed.push(byId.get(s.cardId)!);
      const { cardId: _cardId, prId: _prId, ...score } = s;
      scores[s.cardId] = score;
    }
    if (def.key === 'review') {
      routingTop = ids
        .map((id) => byId.get(id)!)
        .filter((c): c is ReviewerRoutingCard => c.kind === 'reviewer_routing')
        .slice(0, PENDING_LIMITS.routingSuggestCap);
    }

    const kindTotals: Partial<Record<InsightCard['kind'], number>> = {};
    for (const k of rankedKinds) kindTotals[k] = totals[k] ?? 0;
    // WHO OPENED IT, counted off the UNCAPPED fold's cards — so these ARE the populations, exactly
    // like `relevanceTotals` below, and each of the lens's pills has a total of its own.
    const tabCards = insights.cards.filter((c) => rankedKinds.includes(c.kind));
    const kindAuthorTotals: Partial<Record<InsightCard['kind'], PendingAuthorSplit>> = {};
    for (const k of rankedKinds) kindAuthorTotals[k] = authorSplit(tabCards.filter((c) => c.kind === k));
    const tab: PendingTab = {
      key: def.key,
      total: rankedKinds.reduce((n, k) => n + (totals[k] ?? 0), 0),
      kindTotals,
      cardIds: ids,
      authorTotals: authorSplit(tabCards),
      kindAuthorTotals,
    };
    if (def.key === 'my_turn') {
      // Uncapped fold ⇒ these ARE the populations. The two predicates are the board's own lens
      // predicates: 'mine' keeps a card unless it is explicitly not personal; 'others' is exactly
      // `relevance === 'none'` (see AttentionView's passesPersonalLens / passesOtherLens).
      const mt = insights.cards.filter((c) => c.kind === 'my_turn');
      const mine = mt.filter((c) => c.kind === 'my_turn' && c.personal !== false);
      const others = mt.filter((c) => c.kind === 'my_turn' && c.relevance === 'none');
      tab.relevanceTotals = { mine: mine.length, others: others.length };
      tab.relevanceAuthorTotals = { mine: authorSplit(mine), others: authorSplit(others) };
    }
    if (def.kinds.includes('reviewer_load')) {
      const people = insights.cards.filter((c) => c.kind === 'reviewer_load');
      tab.peopleCardIds = people.map((c) => c.id);
      listed.push(...people);
    }
    tabs.push(tab);
  }

  // Suggested reviewers for the top "Needs a reviewer" cards only — mutates those cards in place.
  const known = new Set(insights.users.map((u) => u.id));
  const suggested = (await suggestRoutingReviewers(accountId, routingTop)).filter(
    (id) => !known.has(id),
  );
  const extraUsers =
    suggested.length > 0
      ? (
          await db.select().from(schema.users).where(inArray(schema.users.id, suggested)).execute()
        ).map(mapUser)
      : [];

  return { tabs, cards: listed, extraUsers, scores, rules: rankRulesOf(settings) };
}
