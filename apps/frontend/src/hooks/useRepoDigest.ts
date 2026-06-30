import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoDigest, RepoDigestsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

/** Build the digest query string from the active repo filter. */
function digestSearch(repoIds: number[] | null): string {
  return repoIds && repoIds.length > 0 ? `repoIds=${repoIds.join(',')}` : '';
}

// Bulk per-repo digests for the watched repos. Only fetched when `enabled`
// (pro.inboxDigest) — absent the @pierre/pro plugin the route 404s. Cached snapshot;
// regeneration is explicit (the refresh mutation / per-banner regenerate).
export function useRepoDigests(repoIds: number[] | null, enabled: boolean) {
  const search = digestSearch(repoIds);
  return useQuery<RepoDigestsResponse>({
    queryKey: ['repo-digests', search],
    queryFn: () => api.repoDigests(search),
    enabled,
    staleTime: Infinity,
  });
}

// A single repo's digest, fetched lazily (only when its banner is in view + Pro on)
// so a slow Haiku call never blocks the core grid. Keyed per repo.
export function useRepoDigest(repoId: number | null, enabled: boolean) {
  return useQuery<RepoDigest>({
    queryKey: ['repo-digest', repoId],
    queryFn: () => api.repoDigest(repoId as number),
    enabled: enabled && repoId != null,
    staleTime: Infinity,
  });
}

// Trigger (re)generation of one or more repos' digests, then invalidate so the
// banner refetches the fresh summary. Pass a repo id to regenerate just that repo.
export function useRefreshRepoDigests() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId?: number) =>
      api.refreshRepoDigests(repoId != null ? `repoIds=${repoId}` : undefined),
    onSuccess: (_data, repoId) => {
      if (repoId != null) {
        void qc.invalidateQueries({ queryKey: ['repo-digest', repoId] });
      }
      void qc.invalidateQueries({ queryKey: ['repo-digests'] });
    },
  });
}
