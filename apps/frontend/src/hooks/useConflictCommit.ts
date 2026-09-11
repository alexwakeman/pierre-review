import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConflictCommitBody, ConflictCommitState, ConflictSession } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ARMED_MERGES_KEY } from './useAutoMerge.js';

// ── THE COMMIT ───────────────────────────────────────────────────────────────────────────────
//
// `POST …/conflicts/commit` answers **202**, not "pushed". Everything cheap is validated
// synchronously and refused with a real status code; the fetch, the merge, the commit and the push
// then run behind the ONE session SSE stream, and the phases arrive on `session.commit`. A cold
// clone on a large repository blows past Fastify's 60s request timeout, which is why this cannot
// be a long-held request.
//
// ⚠ SO THE MUTATION RESOLVING IS NOT THE PUSH LANDING, and the refetch below hangs off the
// STREAM's terminal frame rather than off `onSuccess`. Invalidating at the 202 would re-read every
// board a second or two BEFORE the commit existed, and the answer would be the state we were
// trying to move off.

/** ⚠ ONE SPELLING, EXPORTED. Two components must be able to see one in-flight commit: the overlay
 *  owns the mutation, and the PR pane behind it may want to say "committing…". A per-mount
 *  `isPending` is invisible to every other mount (the CiAnalysisCard lesson), so the fact is read
 *  off the KEY via `useIsMutating`. It covers the 202 HANDSHAKE only — the push's own phases live
 *  on `session.commit`, because that is where the server puts them. */
export function conflictCommitMutationKey(prId: number): unknown[] {
  return ['conflict-commit', prId];
}

/**
 * Every key a landed conflict resolution moves.
 *
 * ⚠ `['attention-cards']`, `['daily-brief']` AND `['work-plan']` GO TOGETHER, ALWAYS. They are the
 * only three keys that opt out of the app-wide `refetchOnWindowFocus: false` and they do it as a
 * set: the board's `conflicts` card must leave, the brief strip counts the same fold, and the
 * plan's chip reads it a third time. INVALIDATE, never splice — a local edit kills `capFor`'s
 * `shown === count` guard and takes the "50 of 148" disclosure with it.
 *
 * Deliberately absent: `['mergers']` (nothing merged) and `prRefreshKey(prId)` — invalidating that
 * one fires a POST walk, and the commit route already resyncs server-side while
 * `usePrLiveRefresh`'s own ~5s cadence picks the open pane up.
 */
export function invalidateAfterConflictCommit(qc: QueryClient, prId: number): void {
  for (const key of [
    ['pr', prId],
    ['merge-options', prId],
    ['timeline'],
    ['open-prs'],
    ['my-turn'],
    ['me'],
    ['activity'],
    ['consolidated-feed'],
    // The push disarms any "merge when ready" intent on this PR (the landing step says so before
    // the reader presses the button), so the armed list is stale the moment it lands.
    ARMED_MERGES_KEY as unknown as unknown[],
  ]) {
    void qc.invalidateQueries({ queryKey: key });
  }
  for (const key of [['attention-cards'], ['daily-brief'], ['work-plan']]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/** Hand the commit body over. Resolves at the 202 with the session in `commit.status: 'running'`;
 *  a synchronous refusal rejects with the server's own sentence on the `ApiError`. */
export function useConflictCommit(prId: number) {
  return useMutation<ConflictSession, Error, ConflictCommitBody>({
    mutationKey: conflictCommitMutationKey(prId),
    mutationFn: (body) => api.commitConflictResolution(prId, body),
  });
}

/**
 * Fire the refetch ONCE, when the stream says the push finished.
 *
 * ⚠ ONCE PER TERMINAL COMMIT, not once per render of a terminal state: the session keeps
 * `commit.status: 'done'` for as long as the overlay stays on its result panel, and re-firing on
 * every frame of that would put the whole app on a refetch loop for the price of one commit.
 */
export function useConflictCommitInvalidation(
  prId: number,
  commit: ConflictCommitState | null,
): void {
  const qc = useQueryClient();
  const fired = useRef(false);
  const status = commit?.status ?? null;
  useEffect(() => {
    if (status !== 'done' || fired.current) return;
    fired.current = true;
    invalidateAfterConflictCommit(qc, prId);
  }, [status, prId, qc]);
}
