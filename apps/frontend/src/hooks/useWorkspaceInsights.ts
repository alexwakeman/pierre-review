import { skipToken, useQuery } from '@tanstack/react-query';
import type {
  WorkspaceInsightsResponse,
  WorkspaceMetricsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// The workspace flow-metric header (DORA-ish tiles + trend charts) — CORE/free, rendered at the
// top of the cross-repo Feed (it moved out of the Pro Insights pane). No capability gate; same
// refetch cadence as useWorkspaceInsights below.
//
// `workspaceId` is the WHOLE scope and it is in the cache key, so each workspace caches
// independently. It is `number | null` because the store's id starts null and is filled once
// `useWorkspaces()` lands: `skipToken` holds the query idle until then. That gate is not
// cosmetic — firing without an id would send no `?workspace=`, which the server resolves to the
// account's DEFAULT workspace, and the response would then be cached under a null key and shown
// under whatever workspace resolves a moment later.
export function useWorkspaceMetrics(workspaceId: number | null) {
  const id = workspaceId;
  return useQuery<WorkspaceMetricsResponse>({
    queryKey: ['workspace-metrics', id],
    queryFn: id == null ? skipToken : () => api.workspaceMetrics(id),
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

// Workspace review-intelligence "Insights" (Pro; the `workspaceInsights` capability). The cards
// are computed on read from already-synced data, so refetching on the main sync cadence (~5 min)
// keeps the board fresh without a manual refresh; also refetches on window focus. `enabled` is
// gated on the capability by the caller (hidden entirely in OSS / when Pro is off).
//
// `workspaceId` narrows both the metrics header and every insight card to that workspace's repos.
// It is a plain integer on the wire (`?workspace=<id>`) — there is no scope union, no sentinel and
// nothing to canonicalise — and it is part of the cache key so each workspace caches
// independently. `skipToken` holds the query idle until the store's id resolves; see the note on
// useWorkspaceMetrics for why an unscoped request is worse than no request.
export function useWorkspaceInsights(enabled: boolean, workspaceId: number | null) {
  const id = workspaceId;
  return useQuery<WorkspaceInsightsResponse>({
    queryKey: ['workspace-insights', id],
    queryFn: id == null ? skipToken : () => api.workspaceInsights(id),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
