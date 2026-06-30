import { useQuery } from '@tanstack/react-query';
import type { ReviewActionsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The raw captured action log for one review run (Surface 2: the per-entry
// "Actions on this review" disclosure in the Claude Reviews history modal). Gated on
// `enabled` so it only fetches when pro.reviewMemory is on AND the disclosure is
// expanded (zero-action rows never fetch); keyed per review id.
export function useReviewActions(reviewId: number | null, enabled: boolean) {
  return useQuery<ReviewActionsResponse>({
    queryKey: ['review-actions', reviewId],
    queryFn: () => api.reviewActions(reviewId as number),
    enabled: enabled && reviewId != null,
  });
}
