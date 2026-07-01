import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedDigestResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

/** ?repoIds= for the currently-visible Watched repos (null → all watched). */
function digestSearch(repoIds: number[] | null): string {
  const p = new URLSearchParams();
  if (repoIds && repoIds.length > 0) p.set('repoIds', repoIds.join(','));
  return p.toString();
}

// The cross-repo Feed digest (Pro): a per-repo bulleted change-report assembled from the
// per-repo digests, SCOPED to the currently-visible Watched repos (`repoIds`; null = all
// watched). Scope is in the query key so a FilterBar change refetches. Only fetched when
// `enabled` (pro.inboxDigest) — absent the @pierre/pro plugin the route returns
// enabled:false. Cached snapshot.
export function useFeedDigest(enabled: boolean, repoIds: number[] | null) {
  const search = digestSearch(repoIds);
  return useQuery<FeedDigestResponse>({
    queryKey: ['feed-digest', search],
    queryFn: () => api.feedDigest(search),
    enabled,
    staleTime: Infinity,
  });
}

// Regenerate the (scoped) cross-repo digest (the only billing path; unchanged repos cost
// $0 via the per-repo payload-hash cache). The refresh returns the fresh digest, so we
// seed the query directly and invalidate the per-repo banners (which may have changed).
export function useRefreshFeedDigest(repoIds: number[] | null) {
  const qc = useQueryClient();
  const search = digestSearch(repoIds);
  return useMutation({
    mutationFn: () => api.refreshFeedDigest(search),
    onSuccess: (data) => {
      qc.setQueryData(['feed-digest', search], data);
      void qc.invalidateQueries({ queryKey: ['repo-digest'] });
      void qc.invalidateQueries({ queryKey: ['repo-digests'] });
    },
  });
}
