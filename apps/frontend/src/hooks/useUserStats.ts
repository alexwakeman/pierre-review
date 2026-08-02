import { useQuery } from '@tanstack/react-query';
import type { UserContributionStats } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';

// One contributor's ALL-TIME totals, for the user popover. Fetched ONLY while a popover is
// open (`enabled`) — the stats are a join-scan over the account's PR set, so this must never
// run per rendered row; a handle click is the one thing that triggers it.
//
// The workspace AND the repo scope are folded into the query key, so the same person clicked
// inside two different repos gets two correctly-scoped cached entries. Snapshot intent: totals
// move slowly and a popover is short-lived, so a generous staleTime keeps a re-open instant, and
// ACTIVITY_GC_TIME (shared with the Activity queries) keeps it warm across tab switches.
//
// ⚠ `workspaceId` IS REQUIRED ON THE WIRE, NOT JUST IN THE KEY. The server narrows to
// `membership ∩ (repoIds ?? membership)`, so a `repoIds` from OUTSIDE the named workspace
// intersects to nothing and the popover silently reports all zeros. When the handle was clicked
// inside a PR, pass that PR's repo AND that repo's OWN workspace (`Repo.workspaceId`) — a PR can
// be opened from another workspace via `?pr=`, a restored tab or a search hit, so the currently
// SELECTED workspace would be the wrong one. Otherwise pass the active workspace and `repoIds:
// null` (the whole workspace), which is what the popover's caption claims it is showing — NOT
// `filters.repoIds`, a timeline-board filter this card is mostly rendered away from.
export function useUserStats(
  userId: number | null,
  workspaceId: number | null,
  repoIds: number[] | null,
) {
  // Sorted + joined so the key is stable regardless of the caller's array identity/order.
  const scopeKey =
    repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : 'all';
  return useQuery<UserContributionStats>({
    queryKey: ['user-stats', userId, workspaceKey(workspaceId), scopeKey],
    queryFn: () => api.userStats(userId as number, workspaceId as number, repoIds),
    enabled: userId != null && workspaceId != null,
    staleTime: 1000 * 60 * 5,
    gcTime: ACTIVITY_GC_TIME,
  });
}
