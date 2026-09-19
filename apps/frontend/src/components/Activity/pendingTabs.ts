import {
  PENDING_DO_NEXT_SIZE,
  PENDING_LIMITS,
  PENDING_TABS,
  pendingAuthorSideOf,
  pendingTabOf,
  type AttentionCardsResponse,
  type InsightCard,
  type InsightKind,
  type PendingAuthorLens,
  type PendingAuthorSplit,
  type PendingTab,
  type PendingTabKey,
} from '@pierre-review/shared';
import type { AttentionRelevanceLens } from '../../store/filters.js';

// THE PENDING BOARD'S VIEW MODEL — which tab is on screen, which cards it lists, where Do next
// ends, and the counts. Pure and JSX-free so `test/pendingTabs.test.ts` can pin it.
//
// ⚠ THE ORDER IS THE SERVER'S. `tab.cardIds` arrive highest score first — except the two
// strict-group tabs: My turn (grouped by type in the reader's order from Settings → My Turn) and
// Dependencies (security first, then bumps). This module only FILTERS (a kind chip, My turn's "Only
// yours", the People / Automation lens) and CAPS, never re-sorts, so a filtered view keeps the
// groups. The first `PENDING_DO_NEXT_SIZE` of whatever list is on screen are Do next.

export const TAB_LABEL: Record<PendingTabKey, string> = {
  my_turn: 'My turn',
  fixing: 'Needs fixing',
  review: 'Waiting on review',
  threads: 'Unanswered threads',
  land: 'Ready to land',
  deps: 'Dependencies',
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

/** Does this card survive the People / Automation lens? The server's own predicate
 *  (`pendingAuthorSideOf`), so the list and the figures beside it are one population. */
export function passesAuthorLens(card: InsightCard, lens: PendingAuthorLens | null): boolean {
  return lens == null || pendingAuthorSideOf(card) === lens;
}

/** The figure on a tab's badge: the lens's own total when one is on and the server sent it. */
export function tabBadgeCount(tab: PendingTab, lens: PendingAuthorLens | null): number {
  return lens != null && tab.authorTotals != null ? tab.authorTotals[lens] : tab.total;
}

/** Offer the lens only when it would change the list — both sides non-empty — or it is already on
 *  (so it can always be turned off). */
export function offerAuthorLens(
  split: PendingAuthorSplit | null,
  lens: PendingAuthorLens | null,
): boolean {
  if (lens != null) return true;
  return split != null && split.people > 0 && split.automation > 0;
}

/** The figure on My turn's "Only yours" / "Not tied to you" pill: the view it opens, which under an
 *  author lens is that half's own split — never the unlensed half beside a lensed list. */
export function relevancePillCount(
  tab: PendingTab | undefined,
  rel: AttentionRelevanceLens,
  lens: PendingAuthorLens | null,
): number | null {
  if (lens != null) return tab?.relevanceAuthorTotals?.[rel]?.[lens] ?? null;
  return tab?.relevanceTotals?.[rel] ?? null;
}

/**
 * THE TABS, from a response. A response from a server predating `tabs` gets the same tabs
 * (`PENDING_TABS`) built from its cards by kind — in the order the server sent them, with card counts for totals —
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
  /** This view BEFORE the People / Automation lens, split by who opened each PR — the lens pills'
   *  figures and `offerAuthorLens`' input. Null when the server sent no split. */
  authorSplit: PendingAuthorSplit | null;
  /** This view's population before the People / Automation lens — the "All" pill's figure. */
  allTotal: number;
}

export function buildPendingView(
  data: AttentionCardsResponse | undefined,
  tabKey: PendingTabKey,
  isolation: InsightKind | null,
  lens: AttentionRelevanceLens | null,
  authorLens: PendingAuthorLens | null,
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

  const narrowed = listed.filter((c) => (kind == null || c.kind === kind) && passesLens(c, lensOn));
  // ⚠ CAPPED FOR EVERY VIEW, not just the whole tab. The server lists up to `boardListCap` of each
  // LIST GROUP — kind × My turn's side × who opened it — so a kind chip or "Only yours" is now the
  // union of a People list and an Automation list: its first `boardListCap` are its true top, and
  // beyond that the union has gaps. (A view that IS one list group is never longer than the cap.)
  const cards = narrowed
    .filter((c) => passesAuthorLens(c, authorLens))
    .slice(0, PENDING_LIMITS.boardListCap);

  // THE VIEW'S POPULATION, BEFORE AND AFTER THE AUTHOR LENS. Each figure is the server's own count
  // of exactly this view — never one view's total beside another view's list. The counted
  // fallback only serves a response predating the figure.
  const counted = narrowed.length;
  let allTotal: number;
  let authorSplit: PendingAuthorSplit | null;
  if (kind != null) {
    allTotal = tab.kindTotals[kind] ?? counted;
    authorSplit = tab.kindAuthorTotals?.[kind] ?? null;
  } else if (lensOn != null) {
    allTotal = tab.relevanceTotals?.[lensOn] ?? counted;
    authorSplit = tab.relevanceAuthorTotals?.[lensOn] ?? null;
  } else {
    allTotal = tab.total;
    authorSplit = tab.authorTotals ?? null;
  }
  const total = authorLens != null ? (authorSplit?.[authorLens] ?? cards.length) : allTotal;
  return {
    tab: tab.key,
    cards,
    doNextCount: Math.min(PENDING_DO_NEXT_SIZE, cards.length),
    shown: cards.length,
    total: Math.max(total, cards.length),
    // Under the lens a chip counts that kind's lensed side, the list its click opens.
    chips:
      kinds.length > 1
        ? kinds.map((k) => ({
            kind: k,
            total:
              authorLens != null
                ? (tab.kindAuthorTotals?.[k]?.[authorLens] ??
                  listed.filter((c) => c.kind === k && passesAuthorLens(c, authorLens)).length)
                : (tab.kindTotals[k] ?? 0),
          }))
        : null,
    kind,
    people: (tab.peopleCardIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is InsightCard => c != null),
    authorSplit,
    allTotal: Math.max(allTotal, Math.min(counted, PENDING_LIMITS.boardListCap)),
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
