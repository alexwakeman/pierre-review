import { useQuery } from '@tanstack/react-query';
import type { SyncActivityResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The global loading bar's feed: the account's HEAVY sync walks — full-mode ones
// (`backfills`: first syncs, deep re-syncs, and repos queued for one) and cold-return
// catch-ups (`catchups`: an incremental walk more than 24h behind). Routine incrementals
// are still excluded, which is what keeps an idle board from flickering the bar every five
// minutes.
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
    // ⚠ BOTH WALK POPULATIONS, NOT JUST `backfills`. A cold return is often catch-ups ONLY —
    // no full-mode walk, no ML backlog — and that is exactly the burst the bar's percent, its
    // learned ETA (sampled on `dataUpdatedAt`) and its fade-out are drawn from. Keying the
    // cadence on backfills alone dropped that case to three updates a minute.
    // Both are optional-chained for the same reason as useAutoMerge's `requests`: a throw in
    // this closure escapes into React's commit phase and unmounts the whole tree.
    refetchInterval: (q) =>
      (q.state.data?.backfills?.length ?? 0) + (q.state.data?.catchups?.length ?? 0) > 0 ||
      mlScoring
        ? 4_000
        : 20_000,
    refetchIntervalInBackground: false,
  });
}
