import { useQuery } from '@tanstack/react-query';
import type { RepoTeamMetricsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Insights flow-metric header (TeamMetrics tiles + trend charts) computed for a SINGLE
// repo — powers the per-repo Activity console's Insights-style panel (getTeamInsights scoped
// to [repoId]). Same refresh cadence as useTeamInsights (computed on read from already-synced
// data; refetch on the main sync cadence + window focus); cached per repo. Returns
// `{ enabled, metrics }` — `enabled:false` when the Pro plugin/capability is off,
// `metrics:null` when the repo isn't owned / has no data.
export function useRepoTeamMetrics(repoId: number, enabled = true) {
  return useQuery<RepoTeamMetricsResponse>({
    queryKey: ['repo-team-metrics', repoId],
    queryFn: () => api.repoTeamMetrics(repoId),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
