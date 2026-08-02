import { skipToken, useQuery } from '@tanstack/react-query';
import type { AttentionCardsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The "Needs attention" cards (stalled reviews / untouched threads / reviewer load / needs-a-
// reviewer) — CORE/free, powering the Activity rail's "Needs attention" entry. Same scope semantics
// + sync cadence as the Pro Insights hook, but NO capability gate (every tier). The workspace is in
// the cache key so each one caches independently, and the key stays `['attention-cards', …]` so a
// reviewer "Assign" (which invalidates that PREFIX — see usePrWrites) refreshes every workspace's
// copy of the tab.
export function useAttentionCards(workspaceId: number | null) {
  return useQuery<AttentionCardsResponse>({
    queryKey: ['attention-cards', workspaceKey(workspaceId)],
    // `skipToken` (not `enabled`) holds it idle until the store's id resolves: it is the form that
    // NARROWS `workspaceId` to a number, so an unscoped request — which the server would answer
    // from the account's DEFAULT workspace — is unrepresentable rather than merely discouraged.
    queryFn: workspaceId == null ? skipToken : () => api.attentionCards(workspaceId),
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
