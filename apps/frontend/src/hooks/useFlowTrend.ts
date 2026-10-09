import { skipToken, useQuery } from '@tanstack/react-query';
import type { FlowTrendResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useProCapabilities } from './useTriage.js';
import { workspaceKey } from './useActivity.js';

// Chronology "Over time" — `GET /api/flow-trend`, ONE fetch behind all four trend charts
// (docs/BOTTLENECKS.md § Over time).
//
// ⚠ PRO, ON `periodReports` — THE SAME FLAG THE ROUTE 402s ON (the useFlowFindings rule: the route
// is the monetisation gate, `enabled` is what stops the SPA learning it by error and polling a
// 402). ⚠ `skipToken` while `workspaceId` is null ("not resolved yet"), never a request with no
// `?workspace=`. No `repoIds`: Reports always covers the whole workspace.
//
// Not in `ACTIVITY_QUERY_KEYS` for the same reason as useFlowFindings (a `search`-tier fold).
// A slower poll than the panel: completed weeks are cached server-side and only the current week
// moves, so ten minutes is ample.
export function flowTrendQueryKey(workspaceId: number | null): (string | number)[] {
  return ['flow-trend', workspaceKey(workspaceId)];
}

export function useFlowTrend(workspaceId: number | null) {
  const { periodReports } = useProCapabilities();
  return useQuery<FlowTrendResponse>({
    queryKey: flowTrendQueryKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.flowTrend(workspaceId),
    enabled: periodReports,
    refetchInterval: 10 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 5 * 60_000,
  });
}
