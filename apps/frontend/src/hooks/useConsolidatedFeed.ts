import { useQuery } from '@tanstack/react-query';
import type { ConsolidatedFeedResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The consolidated Feed (the Inbox "Feed" entry): one relevance-ranked stream across
// all repos merging unresolved threads + My Turn actionables + the activity feed.
// Snapshot intent like useInbox — the rail "Refresh" re-pulls it (it invalidates this
// key); `placeholderData: keep` keeps the list on screen while a refetch is in flight.
export function useConsolidatedFeed(enabled = true) {
  return useQuery<ConsolidatedFeedResponse>({
    queryKey: ['consolidated-feed'],
    queryFn: api.consolidatedFeed,
    enabled,
    staleTime: Infinity,
    refetchOnMount: false,
    placeholderData: (prev) => prev,
  });
}
