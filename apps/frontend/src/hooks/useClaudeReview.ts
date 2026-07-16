import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActiveReviewsResponse,
  ClaudeReview,
  ClaudeReviewListResponse,
  ClaudeReviewModel,
  ClaudeReviewResponse,
  ClaudeReviewStatusResponse,
  ClaudeReviewStreamEvent,
  ClaudeReviewVerdict,
  RequestedReviewMode,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { useFilters } from '../store/filters.js';

export function useClaudeReview(prId: number | null) {
  return useQuery<ClaudeReviewResponse>({
    queryKey: ['claude-review', prId],
    queryFn: () => api.claudeReview(prId as number),
    enabled: prId != null,
  });
}

// Fetch a specific past run by id (for the history selector when viewing a run
// other than the latest).
export function useClaudeReviewById(reviewId: number | null) {
  return useQuery<ClaudeReview>({
    queryKey: ['claude-review-by-id', reviewId],
    queryFn: () => api.claudeReviewById(reviewId as number),
    enabled: reviewId != null,
  });
}

// Poll the status endpoint while a run is active; the consumer flips `active` off
// once status leaves 'running' and refetches the full review. Retained as a
// fallback; the live UI uses useClaudeReviewStream (SSE) below.
export function useClaudeReviewStatus(prId: number | null, active: boolean) {
  return useQuery<ClaudeReviewStatusResponse>({
    queryKey: ['claude-review-status', prId],
    queryFn: () => api.claudeReviewStatus(prId as number),
    enabled: prId != null && active,
    refetchInterval: active ? 1500 : false,
  });
}

// Live progress via SSE — a single connection that PUSHES each phase / activity /
// usage change in real time (no 1.5s poll lag), then a terminal `done` that
// invalidates the full review so the finished result loads. `active` mirrors the
// run being in flight (running | queued); when it flips off, the stream is aborted.
// Returns a `{ status }` shape compatible with useClaudeReviewStatus.
export function useClaudeReviewStream(
  prId: number | null,
  active: boolean,
): { status: ClaudeReviewStatusResponse | null } {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ClaudeReviewStatusResponse | null>(null);

  useEffect(() => {
    if (prId == null || !active) {
      setStatus(null);
      return;
    }
    const ac = new AbortController();
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
    };
    void sseStream<ClaudeReviewStreamEvent>(
      `/api/prs/${prId}/claude-review/stream`,
      {
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === 'done') {
            settle();
            setStatus({ status: e.status, reviewId: e.reviewId, progress: null });
          } else {
            setStatus({
              status: e.status,
              reviewId: e.reviewId,
              progress: e.progress,
            });
          }
        },
      },
    ).catch(() => {
      /* aborted or network error — the review query still reflects the DB state */
    });
    return () => ac.abort();
  }, [prId, active, qc]);

  return { status };
}

export function useGenerateReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { model: ClaudeReviewModel; mode: RequestedReviewMode }) =>
      api.generateClaudeReview(prId, vars.model, vars.mode),
    onSuccess: () => {
      // Tell the global banner a run is in flight, so it starts polling.
      useFilters.getState().bumpClaudeReviewKickoff();
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
      void qc.invalidateQueries({ queryKey: ['claude-review-status', prId] });
    },
  });
}

// Post a single finding as a standalone comment. The server auto-routes it: inline
// on its line / on the file's first change (file in the diff), or as a standalone
// PR-level comment (file outside the diff).
export function usePostFinding(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { findingId: number }) =>
      api.postClaudeFinding(vars.findingId),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

export function useCancelReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelClaudeReview(prId),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

export function useUpdateReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      reviewId: number;
      userBody?: string;
      userVerdict?: ClaudeReviewVerdict;
    }) =>
      api.updateClaudeReview(vars.reviewId, {
        userBody: vars.userBody,
        userVerdict: vars.userVerdict,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

export function useUpdateFinding(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      findingId: number;
      included?: boolean;
      editedBody?: string;
    }) =>
      api.updateClaudeFinding(vars.findingId, {
        included: vars.included,
        editedBody: vars.editedBody,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

// Global poll of all in-flight reviews (for the progress banner). Polls at a slow
// cadence always, so a review started from one PR is visible while you explore
// elsewhere.
export function useActiveClaudeReviews(enabled: boolean) {
  return useQuery<ActiveReviewsResponse>({
    queryKey: ['claude-reviews-active'],
    queryFn: api.activeClaudeReviews,
    enabled,
    refetchInterval: 2500,
  });
}

// All Claude reviews across the timeline window (one entry per PR — its latest
// succeeded run), for the history modal. Gated by `enabled` so it only fetches
// when the modal is open.
export function useAllClaudeReviews(enabled: boolean) {
  return useQuery<ClaudeReviewListResponse>({
    queryKey: ['claude-reviews', 'all'],
    queryFn: api.listAllClaudeReviews,
    enabled,
  });
}

// Store or clear the user-supplied Anthropic API key, then refetch the review so
// the auth status (and `hasUserKey`) reflects the change.
export function useSetClaudeKey(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.setClaudeKey(key),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

// Set or clear the per-review budget cap, then refetch the review so the displayed
// value reflects the (server-clamped) result.
export function useSetReviewBudget(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (usd: number | null) => api.setReviewBudget(usd),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

export function usePostReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      reviewId: number;
      userVerdict: ClaudeReviewVerdict;
      dryRun?: boolean;
    }) => api.postClaudeReview(vars.reviewId, vars.userVerdict, vars.dryRun ?? false),
    onSuccess: (_data, vars) => {
      if (!vars.dryRun) {
        void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
      }
    },
  });
}
