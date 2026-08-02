import { useQuery } from '@tanstack/react-query';
import type { WorkspaceComparisonResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Cross-workspace comparison — the Activity rail's "Compare workspaces" entry (CORE/free; it
// shares the free DORA header's trailing-14d window, which is why it is served beside it at
// `GET /api/workspace-metrics/compare` and not from the Pro Insights bundle).
//
// ⚠ IT TAKES NO SCOPE, and the key carries no scope segment. It compares EVERY workspace the
// account owns, Default included, because its entire purpose is to place the selected workspace
// against the others — a selection cannot narrow that. The key was scoped in its previous life
// (`['team-comparison', scope]`) for a real reason at the time: the route filtered to the selected
// teams, so two selections were two answers. The route no longer takes a parameter, so a scoped
// key would now do the opposite damage — fragmenting ONE answer across N identical cache slots,
// each refetched separately.
//
// The surface is hidden when the account owns fewer than two workspaces
// (`(workspaces ?? []).length >= 2` — a count over the ROSTER, never a test on a scope value), so
// this hook is never mounted with nothing to compare.
//
// `enabled` means "the Compare surface is open" — NOT a capability check. The route is
// N × getWorkspaceMetrics (one full 12-week flow-metric computation per workspace) and sits on the
// 60/min `search` rate-limit tier rather than the blanket `read` bucket, so it must not fire on
// every Activity open.
export function useWorkspaceComparison(enabled: boolean) {
  return useQuery<WorkspaceComparisonResponse>({
    queryKey: ['workspace-comparison'],
    queryFn: () => api.workspaceComparison(),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
