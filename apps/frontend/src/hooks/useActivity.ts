import { useQuery } from '@tanstack/react-query';
import type { ActivityResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Every query key that reflects the WATCHED-repo Activity/Insights surface (rail aggregate,
// consolidated feed + its head poll, Pro digests, team insights, sprint report). Invalidate
// ALL of them whenever the watched set changes (watch toggle / add repo) or a sync lands, so
// the Activity console tracks the watched repos live — no manual Refresh. These are all cheap
// DB reads (the AI summaries are GET-only here; regeneration is a separate, delta-gated action).
export const ACTIVITY_QUERY_KEYS = [
  'activity',
  'consolidated-feed',
  'feed-head',
  'repo-digests',
  'team-insights',
  'sprint-report',
] as const;

/** Build the /api/activity query string from the active repo + member scope. */
function activitySearch(repoIds: number[] | null, userIds: number[] | null): string {
  const p = new URLSearchParams();
  if (repoIds && repoIds.length > 0) p.set('repoIds', repoIds.join(','));
  if (userIds && userIds.length > 0) p.set('userIds', userIds.join(','));
  return p.toString();
}

// The multi-repo triage aggregate backing the Activity tab. Repo + member scope ride in
// the query key so a FilterBar change refetches. Snapshot intent — like the IndexedDB-
// cached PR/thread queries it's `staleTime: Infinity` + `refetchOnMount: false`, so
// opening the tab paints the cached snapshot instantly and only the rail header's
// "Refresh" re-pulls it (`query.refetch()`). `placeholderData: keep` keeps the previous
// data on screen while a refetch is in flight (dim, never blank).
export function useActivity(repoIds: number[] | null, userIds: number[] | null) {
  const search = activitySearch(repoIds, userIds);
  return useQuery<ActivityResponse>({
    queryKey: ['activity', search],
    queryFn: () => api.inbox(search),
    staleTime: Infinity,
    refetchOnMount: false,
    placeholderData: (prev) => prev,
  });
}
