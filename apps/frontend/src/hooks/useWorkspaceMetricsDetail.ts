import { skipToken, useQuery } from '@tanstack/react-query';
import type { WorkspaceMetricsDetailResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useProCapabilities } from './useTriage.js';

// The per-metric PR drill-down behind the flow-metric tiles — PRO on `periodReports` like the tiles
// (the route 402s, so the capability is ANDed into `enabled` here). A heavier read than the header,
// so it is fetched lazily: `enabled` is also gated on the drill-down tab actually being open.
// Refetches on the sync cadence.
//
// `workspaceId` narrows to that workspace's repos so the drill-down matches the scoped tile above
// it, and it is part of the cache key so each workspace caches independently. `skipToken` holds
// the query idle while the store's id is still null — an unscoped request would silently be
// answered for the account's DEFAULT workspace and cached under a null key.
export function useWorkspaceMetricsDetail(enabled: boolean, workspaceId: number | null) {
  const id = workspaceId;
  const { periodReports } = useProCapabilities();
  return useQuery<WorkspaceMetricsDetailResponse>({
    queryKey: ['workspace-metrics-detail', `ws:${id}`],
    queryFn: id == null ? skipToken : () => api.workspaceMetricsDetail(id),
    enabled: enabled && periodReports,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
