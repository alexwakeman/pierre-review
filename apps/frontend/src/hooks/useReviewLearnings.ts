import { useQuery } from '@tanstack/react-query';
import type { ReviewLearningsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Aggregated retrieval signals shown BEFORE a Claude review run (Surface 1: "From
// your past reviews in this repo"). Gated on `enabled` (pro.reviewMemory) so OSS
// installs never hit the plugin-only route; keyed per PR.
export function useReviewLearnings(prId: number | null, enabled: boolean) {
  return useQuery<ReviewLearningsResponse>({
    queryKey: ['review-learnings', prId],
    queryFn: () => api.reviewLearnings(prId as number),
    enabled: enabled && prId != null,
  });
}
