import { useQuery } from '@tanstack/react-query';
import type { BranchTrendsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

/**
 * The two trend series behind an EXPANDED default-branch row (CI failures per day over the
 * retained trunk window, LOC merged into the default branch per week).
 *
 * Deliberately LAZY: `enabled` is the row's own open state, so the workspace-wide strip never
 * pays for charts nobody expanded. Keyed by repo alone — the data is a per-repo fact, not a
 * workspace-scoped view, so no `ws:` segment (the same repo expanded from two workspaces is the
 * same series and should share one cache entry).
 *
 * Informational only, like the strip it lives in: nothing here may feed attention counts,
 * the rail sort, My Turn, or any badge.
 */
export function useBranchTrends(repoId: number | null, enabled: boolean) {
  return useQuery<BranchTrendsResponse>({
    queryKey: ['branch-trends', repoId],
    // enabled guarantees repoId != null before this can run; the `?? -1` is for the type only.
    queryFn: () => api.branchTrends(repoId ?? -1),
    enabled: enabled && repoId != null,
    staleTime: 60_000,
  });
}
