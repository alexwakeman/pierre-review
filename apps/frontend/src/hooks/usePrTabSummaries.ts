import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PR_TAB_SUMMARIES_MAX, type PrTabSummariesResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { prTabIds } from '../lib/tabHoverCard.js';

// THE OPEN-TABS HOVER CARD'S ONE READ (docs/FRONTEND.md § The tab hover card): every PR tab's stored
// facts, in ONE batch, keyed by the sorted id list — so every card shares one cache entry.
//
//   • ONLY WHILE A CARD IS OPEN: the card's body calls this, and the body mounts only while the card
//     shows. A sidebar with forty tabs and no hover asks for nothing.
//   • 30 s FRESH: moving the pointer from tab to tab reads the cache; nothing asks again per hover.
//   • DB-only on the server (never a GitHub call), never persisted to IndexedDB (main.tsx's allow-list).
//   • Opening or closing a tab changes the key; the previous answer stays on screen until the new one
//     lands, so a card never blanks.
export const PR_TAB_SUMMARIES_KEY = ['pr-tab-summaries'] as const;
const FRESH_MS = 30_000;

export function usePrTabSummaries() {
  const tabs = usePinnedTabs((s) => s.tabs);
  const ids = prTabIds(tabs).slice(0, PR_TAB_SUMMARIES_MAX);
  return useQuery<PrTabSummariesResponse>({
    queryKey: [...PR_TAB_SUMMARIES_KEY, ids.join(',')],
    queryFn: () => api.prTabSummaries(ids),
    enabled: ids.length > 0,
    staleTime: FRESH_MS,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
}

/** The tab hover card's AI review states share the Open PRs column's cache rule, with this freshness. */
export const TAB_CARD_FRESH_MS = FRESH_MS;
