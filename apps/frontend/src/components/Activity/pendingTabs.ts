import {
  PENDING_DO_NEXT_SIZE,
  PENDING_LIMITS,
  PENDING_TABS,
  pendingTabOf,
  type AttentionCardsResponse,
  type InsightCard,
  type InsightKind,
  type PendingTab,
  type PendingTabKey,
} from '@pierre-review/shared';
import type { AttentionRelevanceLens } from '../../store/filters.js';

// THE PENDING BOARD'S VIEW MODEL — which tab is on screen, which cards it lists, where Do next
// ends, and the counts. Pure and JSX-free so `test/pendingTabs.test.ts` can pin it.
//
// ⚠ THE ORDER IS THE SERVER'S. `tab.cardIds` arrive highest score first; this module only FILTERS
// (a kind chip, My turn's "Only yours") and CAPS, never re-sorts. The first `PENDING_DO_NEXT_SIZE`
// of whatever list is on screen are Do next.

export const TAB_LABEL: Record<PendingTabKey, string> = {
  my_turn: 'My turn',
  fixing: 'Needs fixing',
  review: 'Waiting on review',
  threads: 'Unanswered threads',
  land: 'Ready to land',
};

/**
 * THE TAB ON SCREEN — derived, never written back. A kind filter (seated by a daily-brief line)
 * names its own tab and wins; otherwise the tab the reader picked; otherwise My turn.
 */
export function effectivePendingTab(
  isolation: InsightKind | null,
  picked: PendingTabKey | null,
): PendingTabKey {
  if (isolation != null) {
    const t = pendingTabOf(isolation);
    if (t != null) return t;
  }
  return picked ?? 'my_turn';
}

/** Does this card survive My turn's "Only yours" ('mine') or its complement ('others')?
 *  ⚠ The SAME two predicates the server caps by (pending-tabs.ts `listGroupOf`) and the brief counts
 *  by: 'mine' keeps a card unless it is EXPLICITLY not personal; 'others' is exactly
 *  `relevance === 'none'`. Only `my_turn` cards are ever narrowed. */
export function passesLens(card: InsightCard, lens: AttentionRelevanceLens | null): boolean {
  if (lens == null || card.kind !== 'my_turn') return true;
  return lens === 'mine' ? card.personal !== false : card.relevance === 'none';
}

/**
 * THE TABS, from a response. A response from a server predating `tabs` gets the same five tabs
 * built from its cards by kind — in the order the server sent them, with card counts for totals —
 * so an older server still renders a usable board.
 */
export function tabsOf(data: AttentionCardsResponse | undefined): PendingTab[] {
  if (data?.tabs != null) return data.tabs;
  const cards = data?.cards ?? [];
  return PENDING_TABS.map((def) => {
    const ranked: readonly InsightKind[] = def.kinds.filter((k) => k !== 'reviewer_load');
    const mine = cards.filter((c) => ranked.includes(c.kind));
    const kindTotals: Partial<Record<InsightKind, number>> = {};
    for (const k of ranked) kindTotals[k] = mine.filter((c) => c.kind === k).length;
    return {
      key: def.key,
      total: mine.length,
      kindTotals,
      cardIds: mine.map((c) => c.id),
      ...(def.kinds.includes('reviewer_load')
        ? { peopleCardIds: cards.filter((c) => c.kind === 'reviewer_load').map((c) => c.id) }
        : {}),
    };
  });
}

export interface PendingView {
  tab: PendingTabKey;
  /** What is listed, highest score first. */
  cards: InsightCard[];
  /** How many leading cards are Do next. */
  doNextCount: number;
  /** "Showing `shown` of `total`" — `total` is the uncapped population of THIS view. */
  shown: number;
  total: number;
  /** The kind chips, when the tab holds more than one kind of PR card. */
  chips: { kind: InsightKind; total: number }[] | null;
  /** The kind filter actually in force on this tab (a chip), or null for all. */
  kind: InsightKind | null;
  /** Review-load cards, for the "who has reviews waiting" strip. */
  people: InsightCard[];
}

export function buildPendingView(
  data: AttentionCardsResponse | undefined,
  tabKey: PendingTabKey,
  isolation: InsightKind | null,
  lens: AttentionRelevanceLens | null,
): PendingView {
  const tabs = tabsOf(data);
  const tab = tabs.find((t) => t.key === tabKey) ?? tabs[0]!;
  const byId = new Map((data?.cards ?? []).map((c) => [c.id, c]));
  const listed = tab.cardIds.map((id) => byId.get(id)).filter((c): c is InsightCard => c != null);

  const kinds = Object.keys(tab.kindTotals) as InsightKind[];
  // A kind filter applies only to its own tab, and only when that tab has more than one kind — on a
  // one-kind tab (My turn, Unanswered threads) the filter IS the tab.
  const kind = isolation != null && kinds.length > 1 && kinds.includes(isolation) ? isolation : null;
  const lensOn = tabKey === 'my_turn' ? lens : null;

  let cards = listed.filter((c) => (kind == null || c.kind === kind) && passesLens(c, lensOn));
  let total: number;
  if (kind != null) total = tab.kindTotals[kind] ?? cards.length;
  else if (lensOn != null) total = tab.relevanceTotals?.[lensOn] ?? cards.length;
  else {
    // The whole tab: its true top `boardListCap` (the server listed that many PER KIND, so the
    // first `boardListCap` of the union are the tab's top — beyond that the union has gaps).
    cards = cards.slice(0, PENDING_LIMITS.boardListCap);
    total = tab.total;
  }
  return {
    tab: tab.key,
    cards,
    doNextCount: Math.min(PENDING_DO_NEXT_SIZE, cards.length),
    shown: cards.length,
    total: Math.max(total, cards.length),
    chips: kinds.length > 1 ? kinds.map((k) => ({ kind: k, total: tab.kindTotals[k] ?? 0 })) : null,
    kind,
    people: (tab.peopleCardIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is InsightCard => c != null),
  };
}

/** Should the "Only yours" control be offered on My turn? Only when it would change the list:
 *  there is something of yours AND something that is not — or the lens is already on (so it can
 *  always be turned off). */
export function offerOnlyYours(
  tab: PendingTab | undefined,
  lens: AttentionRelevanceLens | null,
): boolean {
  if (lens != null) return true;
  const r = tab?.relevanceTotals;
  return r != null && r.mine > 0 && r.others > 0;
}
