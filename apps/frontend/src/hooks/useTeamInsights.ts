import { useQuery } from '@tanstack/react-query';
import type { TeamInsightsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Team review-intelligence "Insights" (Pro; `teamInsights`). The cards are computed on
// read from already-synced data, so refetching on the main sync cadence (~5 min) keeps
// the board fresh without a manual refresh; also refetches on window focus. `enabled` is
// gated on the capability by the caller (hidden entirely in OSS / when Pro is off).
export function useTeamInsights(enabled: boolean) {
  return useQuery<TeamInsightsResponse>({
    queryKey: ['team-insights'],
    queryFn: () => api.teamInsights(),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
