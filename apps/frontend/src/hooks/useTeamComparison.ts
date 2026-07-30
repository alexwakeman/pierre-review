import { useQuery } from '@tanstack/react-query';
import type { TeamComparisonResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Cross-team comparison — the Feed's "Compare teams" sub-tab (CORE/free; it moved out of the Pro
// Insights pane along with the DORA header it now sits beside). One TeamMetrics row per team in
// scope, computed on read from already-synced data, so refetching on the main sync cadence keeps
// it fresh.
//
// SCOPE-KEYED, and it must be. The key used to be a bare ['team-comparison'] with the comment
// "it always covers every team" — true only while the panel was gated on the All-Teams sentinel.
// Now that an explicit 2-of-5 selection reaches it, two different selections would otherwise
// share one cache entry and show each other's columns.
//
// `enabled` means "the Compare tab is the active Feed sub-tab" — NOT a capability check. The
// route is N × getTeamMetrics (one full flow-metric computation per team), so it must not fire
// on every Feed open.
export function useTeamComparison(scope: string, enabled: boolean) {
  return useQuery<TeamComparisonResponse>({
    queryKey: ['team-comparison', scope],
    queryFn: () => api.teamComparison(scope),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
