import { useEffect, useState } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CiReview,
  CiReviewProgress,
  CiReviewStatesResponse,
  CiReviewStatus,
  CiReviewStreamEvent,
  PrCiReviewResponse,
  StartCiReviewResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { anyCiRunning, ciStatesRequestIds } from '../lib/ciReview.js';

// THE CI REVIEW's server state (docs/API.md § CI review): its own Claude run, beside the code
// review. Gated by the caller on `me.ai.enabled` (local, free) — the routes are absent in the cloud.

export const ciReviewKey = (prId: number): readonly unknown[] => ['ci-review', prId];
// The batched states' query-key PREFIX (the full key appends the sorted id list).
export const CI_REVIEW_STATES_KEY = ['ci-review-states'] as const;
// ⚠ ONE MUTATION KEY PER PR for every way a check is started, so `useIsMutating` lets each surface
// see the other's start in flight.
export const ciReviewStartKey = (prId: number): readonly unknown[] => ['ci-review-start', prId];

/** True while a CI check start for this PR is in flight, from ANY surface. */
export function useCiReviewStarting(prId: number): boolean {
  return useIsMutating({ mutationKey: ciReviewStartKey(prId) }) > 0;
}

/** The PR's latest CI review and whether it is current. Polls only while one runs. */
export function useCiReview(prId: number, enabled: boolean) {
  return useQuery<PrCiReviewResponse>({
    queryKey: ciReviewKey(prId),
    queryFn: () => api.prCiReview(prId),
    enabled,
    // A run the sweeper started shows up here as `running`; its SSE stream then pushes progress,
    // and this re-read catches the end if the stream drops.
    refetchInterval: (q) => (q.state.data?.state.status === 'running' ? 5000 : false),
  });
}

/** One run by id — the last SUCCEEDED run while a newer one runs, failed or was refused. */
export function useCiReviewById(id: number | null) {
  return useQuery<CiReview>({
    queryKey: ['ci-review-run', id],
    queryFn: () => api.ciReview(id as number),
    enabled: id != null,
  });
}

/**
 * Open PRs and the Pending cards: ONE batched request for every listed PR, never one per card.
 * Polls every 5s only while one of them is running.
 */
export function useCiReviewStates(prIds: readonly number[], enabled: boolean) {
  const ids = ciStatesRequestIds(prIds);
  return useQuery<CiReviewStatesResponse>({
    queryKey: [...CI_REVIEW_STATES_KEY, ids.join(',')],
    queryFn: () => api.ciReviewStates(ids),
    enabled: enabled && ids.length > 0,
    refetchInterval: (q) => (anyCiRunning(q.state.data?.states) ? 5000 : false),
  });
}

function refreshAfter(qc: QueryClient, prId: number): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ciReviewKey(prId) }),
    qc.invalidateQueries({ queryKey: CI_REVIEW_STATES_KEY }),
  ]);
}

/** Start (or re-run) a CI check. ⚠ The invalidation is RETURNED, so the button stays pending until
 *  the readers show the run. */
export function useStartCiReview(prId: number) {
  const qc = useQueryClient();
  return useMutation<StartCiReviewResponse, Error, void>({
    mutationKey: ciReviewStartKey(prId),
    mutationFn: () => api.startCiReview({ prId }),
    onSuccess: () => refreshAfter(qc, prId),
  });
}

/** Live progress of ONE run over SSE. On `done` the PR's CI review and the states are re-read. */
export function useCiReviewStream(
  ciReviewId: number | null,
  active: boolean,
): { status: CiReviewStatus | null; progress: CiReviewProgress | null } {
  const qc = useQueryClient();
  const [state, setState] = useState<{ status: CiReviewStatus | null; progress: CiReviewProgress | null }>({
    status: null,
    progress: null,
  });
  useEffect(() => {
    if (ciReviewId == null || !active) {
      setState({ status: null, progress: null });
      return;
    }
    const ac = new AbortController();
    void sseStream<CiReviewStreamEvent>(`/api/ci-reviews/${ciReviewId}/stream`, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'done') {
          setState({ status: e.status, progress: null });
          void refreshAfter(qc, e.prId);
        } else {
          setState({ status: e.status, progress: e.progress });
        }
      },
    }).catch(() => {
      /* aborted or network error — the polled read still reflects the DB */
    });
    return () => ac.abort();
  }, [ciReviewId, active, qc]);
  return state;
}
