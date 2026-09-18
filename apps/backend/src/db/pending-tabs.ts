// ── THE PENDING BOARD'S TABS (CORE, deterministic, no AI) ───────────────────────────────────
//
// Five tabs (`PENDING_TABS` in packages/shared/src/pending-rules.ts), each a PURELY SCORED list:
// every PR card is scored by the one Do next scorer (`scoreCards`, db/work-plan.ts) and each tab
// lists its cards highest score first. There is no severity-first sort and no cross-kind spread
// rule — a card competes only with the cards in its own tab, and a PR with two jobs appears once
// per job, in each job's tab.
//
// ⚠ IT RANKS THE UNCAPPED FOLD, THEN CAPS. The caller passes `getWorkspaceInsights(…, { uncapped:
// true })`; a per-kind cap applied first (in severity / newest order) would hand this ranker the
// wrong cards. Each kind is then listed to `boardListCap`, highest score first, so the first
// `boardListCap` of any tab ARE that tab's top cards, and a kind chip still shows its kind's top.
//
// ⚠ SUGGESTIONS ARE LOOKED UP ONLY FOR THE TOP "NEEDS A REVIEWER" CARDS. The lookup is network-
// backed per PR (CODEOWNERS), so it runs for `routingSuggestCap` cards, AFTER ranking decided which.
import {
  PENDING_LIMITS,
  PENDING_TABS,
  type InsightCard,
  type PendingCardScore,
  type PendingTab,
  type ReviewerRoutingCard,
  type User,
} from '@pierre-review/shared';
import { inArray } from 'drizzle-orm';
import { db, schema } from './client.js';
import { mapUser, suggestRoutingReviewers, type BotScope, type getWorkspaceInsights } from './queries.js';
import { scoreCards, type ScoredCard } from './work-plan.js';

export interface PendingBoard {
  tabs: PendingTab[];
  /** Only the cards the tabs list, plus the review-load strip. */
  cards: InsightCard[];
  /** Users the suggestion pass named that the fold did not already carry. */
  extraUsers: User[];
  scores: Record<string, PendingCardScore>;
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

/** Which capped list a card counts against — see the loop in `rankPendingTabs`. The My turn
 *  split is the board's own lens predicate: 'mine' keeps a card unless it is explicitly not
 *  personal (AttentionView's passesPersonalLens). */
export function listGroupOf(card: InsightCard): string {
  if (card.kind === 'my_turn') return card.personal === false ? 'my_turn:others' : 'my_turn:mine';
  return card.kind;
}

export async function rankPendingTabs(
  accountId: number,
  scope: BotScope,
  insights: Awaited<ReturnType<typeof getWorkspaceInsights>>,
  now: number = Date.now(),
): Promise<PendingBoard> {
  const byId = new Map(insights.cards.map((c) => [c.id, c]));
  const { scored } =
    scope.repoIds.length === 0 ? { scored: [] as ScoredCard[] } : await scoreCards(accountId, insights.cards, now);
  const totals = insights.kindTotals ?? {};

  const tabs: PendingTab[] = [];
  const listed: InsightCard[] = [];
  const scores: Record<string, PendingCardScore> = {};
  let routingTop: ReviewerRoutingCard[] = [];

  for (const def of PENDING_TABS) {
    const rankedKinds: readonly InsightCard['kind'][] = def.kinds.filter((k) => k !== 'reviewer_load');
    // Every scored card of the tab's kinds, highest score first, then listed per kind to the cap.
    const inTab = scored
      .filter((s) => {
        const card = byId.get(s.cardId);
        return card != null && rankedKinds.includes(card.kind);
      })
      .sort(compareScored);
    // The cap is per LIST GROUP: the card's kind, and for My turn also which side of "Only yours"
    // it falls on. Each view the board can show — the whole tab, one kind's chip, or My turn's
    // "Only yours" / its complement — is then its own true top `boardListCap`, so the figure a view
    // shows is always min(its total, the cap) and the daily brief can say that same number.
    const perGroup = new Map<string, number>();
    const ids: string[] = [];
    for (const s of inTab) {
      const card = byId.get(s.cardId)!;
      const group = listGroupOf(card);
      const n = perGroup.get(group) ?? 0;
      if (n >= PENDING_LIMITS.boardListCap) continue;
      perGroup.set(group, n + 1);
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
    const tab: PendingTab = {
      key: def.key,
      total: rankedKinds.reduce((n, k) => n + (totals[k] ?? 0), 0),
      kindTotals,
      cardIds: ids,
    };
    if (def.key === 'my_turn') {
      // Uncapped fold ⇒ these ARE the populations. The two predicates are the board's own lens
      // predicates: 'mine' keeps a card unless it is explicitly not personal; 'others' is exactly
      // `relevance === 'none'` (see AttentionView's passesPersonalLens / passesOtherLens).
      const mt = insights.cards.filter((c) => c.kind === 'my_turn');
      tab.relevanceTotals = {
        mine: mt.filter((c) => c.kind === 'my_turn' && c.personal !== false).length,
        others: mt.filter((c) => c.kind === 'my_turn' && c.relevance === 'none').length,
      };
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

  return { tabs, cards: listed, extraUsers, scores };
}
