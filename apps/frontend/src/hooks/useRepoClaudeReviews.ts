import { useQuery } from '@tanstack/react-query';
import type { RepoClaudeReviewsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Repo-scoped Claude review history (all runs per PR, newest-first). Gated on
// `enabled` so the single-repo console only fetches it when that section is open —
// and on a server flag (config.claudeReviewEnabled): when off the route 404s, so the
// caller renders nothing. Keyed per repo.
export function useRepoClaudeReviews(repoId: number | null, enabled = true) {
  return useQuery<RepoClaudeReviewsResponse>({
    queryKey: ['repo-claude-reviews', repoId],
    queryFn: () => api.repoClaudeReviews(repoId as number),
    enabled: enabled && repoId != null,
  });
}
