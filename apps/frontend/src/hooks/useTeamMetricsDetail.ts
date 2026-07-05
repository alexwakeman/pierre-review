import { useQuery } from '@tanstack/react-query';
import type { TeamMetricsDetailResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The per-metric PR drill-down behind the flow-metric tiles (Pro; `teamInsights`). A
// heavier read than the always-loaded Insights, so it's fetched lazily — `enabled` is
// gated on the drill-down tab actually being open. Refetches on the sync cadence.
export function useTeamMetricsDetail(enabled: boolean) {
  return useQuery<TeamMetricsDetailResponse>({
    queryKey: ['team-metrics-detail'],
    queryFn: () => api.teamMetricsDetail(),
    enabled,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
