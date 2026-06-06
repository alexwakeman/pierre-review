import { useQuery } from '@tanstack/react-query';
import type { SyncStatus } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useRepos } from './useTimeline.js';

export interface SyncOverview {
  /** A user-initiated/visible sync is currently running for at least one repo. */
  running: boolean;
  /** Aggregate PRs processed so far across the running repos. */
  prsProcessed: number;
  /** At least one running repo is doing a full backfill (vs an incremental sync). */
  isFullSync: boolean;
}

// Read-only view of the live sync status that SyncStatus already polls. We attach
// as a DISABLED observer of the same ['sync-status', <repoIds>] query, so we never
// drive a second poll — we just re-render when SyncStatus refreshes the cache.
// This lets the timeline paint a first-load skeleton while the initial backfill
// fills the (otherwise empty) board, without prop-drilling sync state through App.
export function useSyncOverview(): SyncOverview {
  const { data: repos } = useRepos();
  // Must match SyncStatus's key exactly so we share its cache entry, not start a
  // fetch of our own (the key it builds at SyncStatus.tsx is the same join).
  const repoIdsKey = (repos ?? []).map((r) => r.id).join(',');
  const { data: statuses } = useQuery<SyncStatus[]>({
    queryKey: ['sync-status', repoIdsKey],
    enabled: false, // SyncStatus owns the poll; this is a pure cache subscriber.
    queryFn: () => Promise.all((repos ?? []).map((r) => api.syncStatus(r.id))),
  });
  const running = (statuses ?? []).filter((s) => s.status === 'running');
  return {
    running: running.length > 0,
    prsProcessed: running.reduce((sum, s) => sum + (s.progress?.prsProcessed ?? 0), 0),
    isFullSync: running.some((s) => s.progress?.mode === 'full'),
  };
}
