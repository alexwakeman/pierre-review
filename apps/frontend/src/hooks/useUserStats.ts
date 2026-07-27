import { useQuery } from '@tanstack/react-query';
import type { UserContributionStats } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME } from './useActivity.js';

// One contributor's ALL-TIME totals, for the user popover. Fetched ONLY while a popover is
// open (`enabled`) — the stats are a join-scan over the account's PR set, so this must never
// run per rendered row; a handle click is the one thing that triggers it.
//
// The repo scope is folded into the query key, so the same person clicked inside two
// different repos gets two correctly-scoped cached entries. Snapshot intent: totals move
// slowly and a popover is short-lived, so a generous staleTime keeps a re-open instant, and
// ACTIVITY_GC_TIME (shared with the Activity queries) keeps it warm across tab switches.
export function useUserStats(userId: number | null, repoIds: number[] | null) {
  // Sorted + joined so the key is stable regardless of the caller's array identity/order.
  const scopeKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : 'all';
  return useQuery<UserContributionStats>({
    queryKey: ['user-stats', userId, scopeKey],
    queryFn: () => api.userStats(userId as number, repoIds),
    enabled: userId != null,
    staleTime: 1000 * 60 * 5,
    gcTime: ACTIVITY_GC_TIME,
  });
}
