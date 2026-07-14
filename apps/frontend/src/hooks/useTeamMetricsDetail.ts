import { useQuery } from '@tanstack/react-query';
import type { TeamMetricsDetailResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The per-metric PR drill-down behind the flow-metric tiles (Pro; `teamInsights`). A
// heavier read than the always-loaded Insights, so it's fetched lazily — `enabled` is
// gated on the drill-down tab actually being open. Refetches on the sync cadence.
// `scope` ('all' | 'none' | '<teamId>') narrows to a team's repos so the drill-down
// matches the scoped tile — it's part of the cache key so each team caches independently.
export function useTeamMetricsDetail(enabled: boolean, scope?: string) {
  return useQuery<TeamMetricsDetailResponse>({
    queryKey: ['team-metrics-detail', scope ?? 'all'],
    queryFn: () => api.teamMetricsDetail(scope),
    enabled,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
