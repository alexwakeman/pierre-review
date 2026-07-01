import { useQuery } from '@tanstack/react-query';
import type { InboxResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

/** Build the /api/inbox query string from the active repo + member scope. */
function inboxSearch(repoIds: number[] | null, userIds: number[] | null): string {
  const p = new URLSearchParams();
  if (repoIds && repoIds.length > 0) p.set('repoIds', repoIds.join(','));
  if (userIds && userIds.length > 0) p.set('userIds', userIds.join(','));
  return p.toString();
}

// The multi-repo triage aggregate backing the Inbox tab. Repo + member scope ride in
// the query key so a FilterBar change refetches. Snapshot intent — like the IndexedDB-
// cached PR/thread queries it's `staleTime: Infinity` + `refetchOnMount: false`, so
// opening the tab paints the cached snapshot instantly and only the rail header's
// "Refresh" re-pulls it (`query.refetch()`). `placeholderData: keep` keeps the previous
// data on screen while a refetch is in flight (dim, never blank).
export function useInbox(repoIds: number[] | null, userIds: number[] | null) {
  const search = inboxSearch(repoIds, userIds);
  return useQuery<InboxResponse>({
    queryKey: ['inbox', search],
    queryFn: () => api.inbox(search),
    staleTime: Infinity,
    refetchOnMount: false,
    placeholderData: (prev) => prev,
  });
}
