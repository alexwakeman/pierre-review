import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { notifyManager, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { PrMergeQueueInfo } from '@pierre-review/shared';
import { invalidateAfterServerPrChange, recentlyWrittenPrIds } from './prCacheSync.js';

// ── GitHub's merge queue on the merge row: WHICH OBSERVATION IS NEWER ─────────────────────────
//
// The merge row decides "is this PR in GitHub's merge queue?" from TWO observations: the synced
// columns on the card / PR row, and the merge control's live merge-options answer. The pure
// resolver (`mergeQueueStatus`, Activity/pendingLabels.ts) picks the NEWER one, so both need a
// timestamp — React Query's `dataUpdatedAt` of the query each came from. These two hooks are the
// React half: reading that timestamp without a fetch, and repairing the synced side when a live
// answer contradicts it.

/**
 * When `queryKey`'s data was last written (epoch ms), or 0 when there is none.
 *
 * ⚠ A CACHE READ, NEVER AN OBSERVER. Mounting `useQuery` on the board's key from every card would
 * add fifty observers whose `refetchOnMount` refetches a stale board — a fetch on mount by the back
 * door. This subscribes to the cache and reads one number, nothing else.
 */
export function useQueryDataUpdatedAt(queryKey: QueryKey): number {
  const qc = useQueryClient();
  const subscribe = useCallback(
    // `batchCalls`, as TanStack's own `useIsFetching` does: cache events can fire while another
    // component renders, and a store change must not schedule an update from inside that render.
    (onChange: () => void) => qc.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [qc],
  );
  return useSyncExternalStore(subscribe, () => qc.getQueryState(queryKey)?.dataUpdatedAt ?? 0);
}

// prId → the live answer (its `dataUpdatedAt`) a repair was already fired for. Module-level so two
// mounts of one PR (the merge control and "Merge when ready" side by side) repair ONCE. Bounded:
// the oldest entry goes once it is full (a Map iterates in insertion order), which at worst lets
// one very old answer be repaired a second time.
const repairedAt = new Map<number, number>();
const REPAIRED_AT_MAX = 200;

/**
 * THE LIVE ANSWER IS NEWER AND SAYS SOMETHING ELSE — re-read the synced side, once.
 *
 * The merge-options GET stamps the PR row from the same probe it answered with, so by the time a
 * live answer contradicts the card or the PR pane, the row already holds the new value; only the
 * client's copies are old. This re-reads the PR's detail and the workspace half (the Pending
 * board's three reads among it) through the ONE server-change helper, throttled like every other
 * sweep. `skipPrIds` keeps that helper from re-fetching THIS PR's merge-options, which is the
 * answer that started it.
 *
 * "Something else" is the RENDERED membership: a synced `null` ("not observed") and a live
 * `false` draw the same row, so they are not a disagreement worth a refetch.
 *
 * `syncedInMergeQueue` undefined = the caller has no synced facts at all, and nothing is repaired.
 */
export function useQueueDisagreementRepair(
  prId: number,
  syncedInMergeQueue: boolean | null | undefined,
  syncedAt: number,
  live: PrMergeQueueInfo | null | undefined,
  liveAt: number,
): void {
  const qc = useQueryClient();
  const disagrees =
    syncedInMergeQueue !== undefined &&
    live != null &&
    liveAt > syncedAt &&
    live.inQueue !== (syncedInMergeQueue === true);
  useEffect(() => {
    if (!disagrees || repairedAt.get(prId) === liveAt) return;
    repairedAt.delete(prId);
    repairedAt.set(prId, liveAt);
    if (repairedAt.size > REPAIRED_AT_MAX) {
      const oldest = repairedAt.keys().next().value;
      if (oldest !== undefined) repairedAt.delete(oldest);
    }
    void qc.invalidateQueries({ queryKey: ['pr', prId] });
    // THE WORKSPACE HALF ONLY. `repoIds: ∅` keeps every open merge control out of it, but the
    // helper still re-reads each PR this tab WROTE to recently whose repo it cannot place (detail
    // not cached) — its `['pr', id]` and its `['merge-options', id]`, ~3 GitHub calls each. None of
    // them is what this repair is about, so all of them are skipped, this PR included (its live
    // answer is what started it).
    void invalidateAfterServerPrChange(qc, {
      repoIds: new Set<number>(),
      skipPrIds: new Set([prId, ...recentlyWrittenPrIds()]),
    });
  }, [disagrees, liveAt, prId, qc]);
}
