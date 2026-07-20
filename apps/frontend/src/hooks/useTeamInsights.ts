import { useQuery } from '@tanstack/react-query';
import type { TeamInsightsResponse, TeamMetricsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The team flow-metric header (DORA-ish tiles + trend charts) — CORE/free, rendered at the top of
// the cross-repo Feed (moved out of the Pro Insights pane). Always enabled (no capability gate);
// same scope semantics + refetch cadence as useTeamInsights. `scope` is in the cache key so each
// team caches independently.
export function useTeamMetrics(scope?: string) {
  return useQuery<TeamMetricsResponse>({
    queryKey: ['team-metrics', scope ?? 'all'],
    queryFn: () => api.teamMetrics(scope),
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

// Team review-intelligence "Insights" (Pro; `teamInsights`). The cards are computed on
// read from already-synced data, so refetching on the main sync cadence (~5 min) keeps
// the board fresh without a manual refresh; also refetches on window focus. `enabled` is
// gated on the capability by the caller (hidden entirely in OSS / when Pro is off).
// `scope` ('all' | 'none' | '<teamId>') narrows both the Overview metrics AND all insight
// cards to a team's repos — it's part of the cache key so each team caches independently.
export function useTeamInsights(enabled: boolean, scope?: string) {
  return useQuery<TeamInsightsResponse>({
    queryKey: ['team-insights', scope ?? 'all'],
    queryFn: () => api.teamInsights(scope),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
