import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoDigest, RepoDigestsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

/** Build the digest query string from the active repo filter. */
function digestSearch(repoIds: number[] | null): string {
  return repoIds && repoIds.length > 0 ? `repoIds=${repoIds.join(',')}` : '';
}

// Bulk per-repo digests for the watched repos. Only fetched when `enabled`
// (pro.activityDigest) — absent the @pierre/pro plugin the route 404s. Cached snapshot;
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

// Trigger (re)generation of one or more repos' digests, then invalidate so the banners
// refetch the fresh summaries. Pass a single repo id to regenerate just that repo, or an
// array to regenerate a set (the Feed collection's "Regenerate all" over the watched repos);
// omit to let the backend pick (its watched-only default).
export function useRefreshRepoDigests() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg?: number | number[]) => {
      const search =
        arg == null
          ? undefined
          : Array.isArray(arg)
            ? arg.length > 0
              ? `repoIds=${arg.join(',')}`
              : undefined
            : `repoIds=${arg}`;
      return api.refreshRepoDigests(search);
    },
    onSuccess: (_data, arg) => {
      if (typeof arg === 'number') void qc.invalidateQueries({ queryKey: ['repo-digest', arg] });
      // A bulk/unscoped refresh may have touched any repo — invalidate all single caches.
      else void qc.invalidateQueries({ queryKey: ['repo-digest'] });
      void qc.invalidateQueries({ queryKey: ['repo-digests'] });
    },
  });
}
