import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActiveReviewsResponse,
  ClaudeReview,
  ClaudeReviewModel,
  ClaudeReviewResponse,
  ClaudeReviewStatusResponse,
  ClaudeReviewVerdict,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
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
// once status leaves 'running' and refetches the full review.
export function useClaudeReviewStatus(prId: number | null, active: boolean) {
  return useQuery<ClaudeReviewStatusResponse>({
    queryKey: ['claude-review-status', prId],
    queryFn: () => api.claudeReviewStatus(prId as number),
    enabled: prId != null && active,
    refetchInterval: active ? 1500 : false,
  });
}

export function useGenerateReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (model: ClaudeReviewModel) =>
      api.generateClaudeReview(prId, model),
    onSuccess: () => {
      // Tell the global banner a run is in flight, so it starts polling.
      useFilters.getState().bumpClaudeReviewKickoff();
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
      void qc.invalidateQueries({ queryKey: ['claude-review-status', prId] });
    },
  });
}

// Post a single anchored finding as a standalone inline comment.
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
