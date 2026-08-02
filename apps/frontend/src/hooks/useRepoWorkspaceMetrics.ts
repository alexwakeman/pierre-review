import { useQuery } from '@tanstack/react-query';
import type { RepoWorkspaceMetricsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Insights flow-metric header (WorkspaceMetrics tiles + trend charts) computed for a SINGLE
// repo — powers the per-repo Activity console's Insights-style panel. Same refresh cadence as
// useWorkspaceInsights (computed on read from already-synced data; refetch on the main sync
// cadence + window focus); cached per repo. Returns `{ enabled, metrics }` — `enabled:false` when
// the Pro plugin/capability is off, `metrics:null` when the repo isn't owned / has no data.
//
// ⚠ IT TAKES NO WORKSPACE, and must not: the route holds a repo id and resolves that repo's OWN
// workspace server-side (a repo belongs to exactly one). Passing the SELECTED workspace here would
// be a real bug — this panel is reachable for a repo the current selection does not contain — so
// the repo id alone is the key.
export function useRepoWorkspaceMetrics(repoId: number, enabled = true) {
  return useQuery<RepoWorkspaceMetricsResponse>({
    queryKey: ['repo-workspace-metrics', repoId],
    queryFn: () => api.repoWorkspaceMetrics(repoId),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
