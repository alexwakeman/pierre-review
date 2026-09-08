import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrDetail, PrRefreshResponse } from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { prMlLabelsKey } from './useMlLabels.js';

// Live PR-detail freshness: while a PR is OPEN and its pane is actually VISIBLE, poll
// POST /api/prs/:id/refresh every ~5s. The server is probe-gated (a quiet tick is one
// free conditional REST 304 with a ~30s forced-walk floor for CI/thread-resolve, which
// updated_at can't see), so the poll is quota-safe in both modes — the CLIENT's job is
// only to not poll what nobody is looking at, and to invalidate ONLY when something
// changed (an unconditional 5s ['timeline'] invalidation would churn the vis board).
//
// The manual header button is the SAME query key driven through fetchQuery with the
// {wait:true} variant — the CiAnalysisCard lesson: two triggers of one paid call must
// share one in-flight state, or a tab switch mid-run invites a doubled request.

const POLL_MS = 5_000;
const POLL_MAX_MS = 60_000;

export function prRefreshKey(prId: number): unknown[] {
  return ['pr-refresh', prId];
}

export interface PrLiveRefresh {
  /** The manual button: {wait:true} through the shared key. Never throws at the click site. */
  refreshNow: () => void;
  /** Any refresh (poll tick or manual) in flight on this PR — one spinner for both. */
  isRefreshing: boolean;
  /** The last attempt couldn't re-read GitHub — show a subtle stale note, NEVER an error. */
  isStale: boolean;
}

export function usePrLiveRefresh(prId: number, enabled: boolean): PrLiveRefresh {
  const qc = useQueryClient();
  // Consecutive failed polls, for the exponential backoff. React Query's own
  // fetchFailureCount resets at every fetch START (not on settle), so it can never count
  // across polls; errorUpdatedAt in the effect deps ticks once per failed attempt.
  const failsRef = useRef(0);

  const query = useQuery<PrRefreshResponse>({
    queryKey: prRefreshKey(prId),
    queryFn: () => api.refreshPr(prId),
    enabled,
    // A fresh result on every mount = the "immediate sync on open" (staleTime 0 makes
    // the default refetchOnMount fetch unconditionally); nothing worth keeping after the
    // pane closes (gcTime 0), and never persisted (not in main.tsx's whitelist).
    staleTime: 0,
    gcTime: 0,
    retry: false,
    // The interval-as-function pattern (useMlLabels.ts): 5s normally; after a failure
    // back off exponentially to 60s, honoring a 429's Retry-After when it's longer.
    // A 200 carrying {synced:false} counts as a failure here too — it means the server
    // could not re-read GitHub (revoked access, SAML wall, GraphQL outage), and holding
    // the 5s cadence against a broken token would spend the tenant's probe/walk budget
    // on a pane that cannot get fresher until something external changes.
    refetchInterval: (q) => {
      const unsynced = q.state.status === 'success' && q.state.data?.synced === false;
      if (q.state.status !== 'error' && !unsynced) return POLL_MS;
      const backoff = Math.min(POLL_MS * 2 ** failsRef.current, POLL_MAX_MS);
      const err = q.state.error;
      const retryAfterMs =
        err instanceof ApiError && err.retryAfterSeconds != null
          ? err.retryAfterSeconds * 1000
          : 0;
      return Math.max(backoff, retryAfterMs);
    },
    refetchIntervalInBackground: false,
  });

  const { data, dataUpdatedAt, status, errorUpdatedAt } = query;

  useEffect(() => {
    if (status === 'error') failsRef.current += 1;
    else if (status === 'success' && data?.synced === false) failsRef.current += 1;
    else if (status === 'success') failsRef.current = 0;
  }, [status, errorUpdatedAt, dataUpdatedAt, data]);

  // Changed-only invalidation, mirroring useDetailCacheReconciler's exact set: the PR,
  // its cached threads, its ML-label index, and the two lean feeds (reconciler + badges +
  // my-turn ripple). On !changed invalidate NOTHING. Keyed on dataUpdatedAt as well as
  // data: consecutive changed:true payloads can be structurally identical (same
  // updatedAt after two floor walks), and each one still needs its repaint.
  useEffect(() => {
    if (!data?.changed) return;
    const cached = qc.getQueryData<PrDetail>(['pr', prId]);
    void qc.invalidateQueries({ queryKey: ['pr', prId] });
    for (const t of cached?.threads ?? []) {
      void qc.invalidateQueries({ queryKey: ['thread', t.id] });
    }
    void qc.invalidateQueries({ queryKey: prMlLabelsKey(prId) });
    // ⚠ AND THE MERGE CONTROL'S KEY, which ['pr', prId] does NOT cover. `useMergeOptions`
    // (usePrWrites.ts) holds the LIVE GitHub read — allowed merge methods, current mergeability,
    // and merge-queue membership, position and entry state — none of which the sync persists, so
    // no amount of refetching the PR detail can move it. It is staleTime:30s with no
    // refetchInterval and the app-wide refetchOnWindowFocus is false, so until this line the ONLY
    // thing that re-read it was a merge RETRY: a PR that GitHub had kicked out of the queue went
    // on showing its old position until the user clicked Merge and watched it fail. Invalidation
    // refetches ACTIVE queries only, and this one is enabled just while the control is open — a
    // closed control is merely marked stale and costs nothing.
    //
    // ⚠ Inside the `changed` guard and nowhere else: that route is ~3 GitHub calls, so an
    // unconditional version would put them on a 5-second timer — the churn this effect's own
    // comment forbids. Bare literal because useMergeOptions spells the key that way too; a
    // rename there fails silently here.
    void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
    void qc.invalidateQueries({ queryKey: ['timeline'] });
    void qc.invalidateQueries({ queryKey: ['open-prs'] });
    // ⚠ AND THE PENDING BOARD, WHICH WAS THE ONE SURFACE THIS EFFECT DID NOT REACH. The walk
    // that just landed wrote fresh `state` / `mergeStateStatus` / `review_requests` rows — so
    // a PR that merged, closed or went behind while its pane was open is already stale in the
    // DB's own terms, and the board behind the pane went on rendering the card for up to five
    // minutes (its refetchInterval) with no GitHub call able to fix it. These three keys are ONE
    // FOLD READ THREE TIMES (getWorkspaceInsights): the board, the brief strip whose count the
    // board's cap disclosure divides by, and the ranked plan under it. Sweep them TOGETHER or
    // `capFor`'s `shown === count` guard compares two snapshots and the "50 of 148" line
    // silently vanishes — the same rule ACTIVITY_QUERY_KEYS keeps for a landing sync.
    //
    // Still gated on `changed`: an unconditional 5s sweep of a `search`-tier route is exactly
    // the churn this effect's comment above forbids.
    void qc.invalidateQueries({ queryKey: ['attention-cards'] });
    void qc.invalidateQueries({ queryKey: ['daily-brief'] });
    void qc.invalidateQueries({ queryKey: ['work-plan'] });
  }, [data, dataUpdatedAt, prId, qc]);

  const refreshNow = useCallback(() => {
    // fetchQuery on the SAME key so the result lands in the same cache entry — the
    // changed-invalidation effect above covers both paths and `isRefreshing` below is
    // one truth. But fetchQuery DEDUPES onto an in-flight fetch for the key: if a poll
    // tick's wait:false probe is mid-flight at click time, the click would silently
    // become that probe (which can 304 and do nothing) and the {wait:true} walk the
    // button promises would never be sent. Cancel the in-flight tick first, THEN fetch —
    // the click's semantics must survive the collision. Errors surface through the query
    // state (the stale note), never as an unhandled rejection.
    void qc
      .cancelQueries({ queryKey: prRefreshKey(prId) })
      .then(() =>
        qc.fetchQuery({
          queryKey: prRefreshKey(prId),
          queryFn: () => api.refreshPr(prId, { wait: true }),
          staleTime: 0,
        }),
      )
      .catch(() => {});
  }, [prId, qc]);

  return {
    refreshNow,
    isRefreshing: query.isFetching,
    // Only a COMPLETED attempt counts as stale evidence — a closed PR that never polls
    // stays pending forever and must not be flagged.
    isStale: status === 'error' || data?.synced === false,
  };
}
