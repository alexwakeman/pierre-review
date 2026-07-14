import { useQuery } from '@tanstack/react-query';
import type { TeamComparisonResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Cross-team comparison (Insights "Compare" sub-tab; only shown in All-Teams scope). One
// TeamMetrics row per team, computed on read from already-synced data — so refetching on the
// main sync cadence keeps it fresh. `enabled` gates on the teamInsights capability + the
// All-Teams scope being active (the caller passes false otherwise). Not scope-keyed: it always
// covers every team.
export function useTeamComparison(enabled: boolean) {
  return useQuery<TeamComparisonResponse>({
    queryKey: ['team-comparison'],
    queryFn: () => api.teamComparison(),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
