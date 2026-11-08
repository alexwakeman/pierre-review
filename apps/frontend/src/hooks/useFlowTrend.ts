import { skipToken, useQuery } from '@tanstack/react-query';
import type { FlowActorView, FlowTrendResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { flowViewKeySlot, useWorkspaceFlowView } from './useFlowView.js';

// Chronology "Over time" — `GET /api/flow-trend`, ONE fetch behind all four trend charts
// (docs/BOTTLENECKS.md § Over time).
//
// ⚠ `skipToken` while `workspaceId` is null ("not resolved yet"), never a request with no
// `?workspace=`. No `repoIds`: Reports always covers the whole workspace.
//
// Not in `ACTIVITY_QUERY_KEYS` for the same reason as useFlowFindings (a `search`-tier fold).
// A slower poll than the panel: completed weeks are cached server-side and only the current week
// moves, so ten minutes is ample.
// The view (who moves the ball, hooks/useFlowView.ts) is its own key slot: the panel and the trend
// always read the SAME view.
export function flowTrendQueryKey(workspaceId: number | null, view: FlowActorView | null = null): (string | number)[] {
  return ['flow-trend', workspaceKey(workspaceId), flowViewKeySlot(view)];
}

export function useFlowTrend(workspaceId: number | null) {
  const view = useWorkspaceFlowView(workspaceId);
  return useQuery<FlowTrendResponse>({
    queryKey: flowTrendQueryKey(workspaceId, view),
    queryFn: workspaceId == null ? skipToken : () => api.flowTrend(workspaceId, view ?? undefined),
    refetchInterval: 10 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 5 * 60_000,
  });
}
