import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConflictCommitBody, ConflictCommitState, ConflictSession } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';

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
 * Every key a landed conflict resolution moves: THE ONE WRITE SET (`invalidateAfterPrWrite`,
 * prCacheSync.ts), so the board's `conflicts` card, its counts and the plan move together.
 *
 * `armed`: the push disarms any "merge when ready" intent on this PR (the landing step says so
 * before the reader presses the button), so the armed list is stale the moment it lands. Not
 * `merged` — nothing merged.
 *
 * ⚠ GitHub attaches the push and recomputes mergeability a few seconds AFTER the push, so this
 * one refetch can still read "conflicting". The helper opens SyncStatus's fast `['repos']` poll,
 * which carries the server's follow-up re-reads here; the resolver shell also calls this again
 * when it closes, and polls the PR while it is open.
 */
export function invalidateAfterConflictCommit(qc: QueryClient, prId: number): void {
  void invalidateAfterPrWrite(qc, prId, { armed: true });
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
