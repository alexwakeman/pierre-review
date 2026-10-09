import { skipToken, useQuery } from '@tanstack/react-query';
import type {
  MergedPrsResponse,
  WorkspaceInsightsResponse,
  WorkspaceMetricsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useProCapabilities } from './useTriage.js';

// The workspace flow-metric header (DORA-ish tiles + trend charts) plus the per-repo "where is the
// work happening?" breakdown under it, rendered in the "Flow metrics" section of the REPORTS rail
// entry. PRO on `periodReports` with the rest of Reports: the route 402s without it, so the
// capability is ANDed into `enabled` HERE (one place for every caller), or the SPA polls a 402.
//
// ⚠ ONE FETCH FOR THE WHOLE SECTION. The tiles, the 12-week trends and the per-repo pair all ride
// this ONE response, so they can never be a refresh apart — and the per-repo half costs no extra
// round trip to paint.
//
// `workspaceId` is the WHOLE scope and it is in the cache key, so each workspace caches
// independently. It is `number | null` because the store's id starts null and is filled once
// `useWorkspaces()` lands: `skipToken` holds the query idle until then. That gate is not
// cosmetic — firing without an id would send no `?workspace=`, which the server resolves to the
// account's DEFAULT workspace, and the response would then be cached under a null key and shown
// under whatever workspace resolves a moment later.
export function useWorkspaceMetrics(workspaceId: number | null) {
  const id = workspaceId;
  const { periodReports } = useProCapabilities();
  return useQuery<WorkspaceMetricsResponse>({
    queryKey: ['workspace-metrics', `ws:${id}`],
    queryFn: id == null ? skipToken : () => api.workspaceMetrics(id),
    enabled: periodReports,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

// Reports → "Merged so far": every PR merged in the workspace's reporting window. Pro on
// `periodReports` with the rest of Reports — the capability is ANDed into `enabled` here, or the
// SPA polls a 402. Same `ws:<id>` key discipline and `skipToken` hold as `useWorkspaceMetrics`.
export function useMergedPrs(workspaceId: number | null) {
  const id = workspaceId;
  const { periodReports } = useProCapabilities();
  return useQuery<MergedPrsResponse>({
    queryKey: ['merged-prs', `ws:${id}`],
    queryFn: id == null ? skipToken : () => api.mergedPrs(id),
    enabled: periodReports,
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
