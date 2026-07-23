import { useQuery } from '@tanstack/react-query';
import type { AttentionCardsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The "Needs attention" cards (stalled reviews / untouched threads / reviewer load / needs-a-
// reviewer) — CORE/free, powering the Feed "Needs attention" rail tab. Same scope semantics + sync
// cadence as the Pro Insights hook, but NO capability gate (every tier). `scope` is in the cache
// key so each team caches independently. Kept keyed `['attention-cards', scope]` so a reviewer
// "Assign" (which invalidates this key, see usePrWrites) refreshes the tab.
export function useAttentionCards(scope?: string) {
  return useQuery<AttentionCardsResponse>({
    queryKey: ['attention-cards', scope ?? 'all'],
    queryFn: () => api.attentionCards(scope),
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
