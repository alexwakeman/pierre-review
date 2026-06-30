import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedDigestResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The cross-all-repos Feed digest (Pro): a per-repo bulleted change-report assembled
// from the per-repo digests. Only fetched when `enabled` (pro.inboxDigest) — absent
// the @pierre/pro plugin the route returns enabled:false. Cached snapshot.
export function useFeedDigest(enabled: boolean) {
  return useQuery<FeedDigestResponse>({
    queryKey: ['feed-digest'],
    queryFn: api.feedDigest,
    enabled,
    staleTime: Infinity,
  });
}

// Regenerate the cross-repo digest (the only billing path; unchanged repos cost $0
// via the per-repo payload-hash cache). The refresh returns the fresh digest, so we
// seed the query directly and invalidate the per-repo banners (which may have changed).
export function useRefreshFeedDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshFeedDigest(),
    onSuccess: (data) => {
      qc.setQueryData(['feed-digest'], data);
      void qc.invalidateQueries({ queryKey: ['repo-digest'] });
      void qc.invalidateQueries({ queryKey: ['repo-digests'] });
    },
  });
}
