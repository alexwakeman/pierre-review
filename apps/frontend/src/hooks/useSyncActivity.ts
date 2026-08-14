import { useQuery } from '@tanstack/react-query';
import type { SyncActivityResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The global loading bar's feed: the account's FULL-MODE sync walks only (first-sync
// backfills, deep re-syncs, and repos queued for one) — never routine incrementals,
// which is what keeps an idle board from flickering the bar every five minutes.
//
// Key carries NO workspace segment on purpose: the sync manager's walk queue is
// account-wide (a repo backfills once no matter which workspace shows it), exactly the
// reasoning behind the un-scoped ['ml-status'] key next door in useMlLabels.
export function useSyncActivity(mlScoring: boolean) {
  return useQuery<SyncActivityResponse>({
    queryKey: ['sync-activity'],
    queryFn: api.syncActivity,
    // Two-speed poll, mirroring useMlEnrichmentStatus: fast while the bar has anything
    // to animate — a full-mode walk reported HERE, or the ML scoring pass that follows
    // one (`mlScoring` is the caller's isMlScoring(...) read; a data change there
    // re-renders the caller, so this closure is rebuilt with the fresh value) — and
    // lazy otherwise.
    refetchInterval: (q) =>
      (q.state.data?.backfills.length ?? 0) > 0 || mlScoring ? 4_000 : 20_000,
    refetchIntervalInBackground: false,
  });
}
