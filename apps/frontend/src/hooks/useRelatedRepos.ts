import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RelatedReposResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// RELATED REPOS for one workspace (Settings → Workspace; docs/CLAUDE-REVIEW.md § Related repos). The
// key carries the workspace id; not persisted.

export const relatedReposKey = (workspaceId: number | null) => ['related-repos', `ws:${workspaceId}`] as const;

export function useRelatedRepos(workspaceId: number | null) {
  return useQuery<RelatedReposResponse>({
    queryKey: relatedReposKey(workspaceId),
    queryFn: workspaceId != null ? () => api.relatedRepos(workspaceId) : skipToken,
  });
}

export function useSetRelatedRepos(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<RelatedReposResponse, Error, { repoId: number; relatedRepoIds: number[] }>({
    mutationFn: ({ repoId, relatedRepoIds }) => api.setRelatedRepos(workspaceId!, repoId, relatedRepoIds),
    onSuccess: (resp) => qc.setQueryData(relatedReposKey(resp.workspaceId), resp),
  });
}

/** The repos related to `repoId`, from the pairs (the relation is symmetric). */
export function relatedTo(pairs: ReadonlyArray<{ repoId: number; relatedRepoId: number }>, repoId: number): number[] {
  const out: number[] = [];
  for (const p of pairs) {
    if (p.repoId === repoId) out.push(p.relatedRepoId);
    else if (p.relatedRepoId === repoId) out.push(p.repoId);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Whether `partnerId` cannot take `repoId` as a NEW relation: it already has `max` relations to other
 * repos (the server skips it — the cap holds on both sides, db/related-repos.ts). A partner already
 * related to `repoId` is never "full" for it.
 */
export function partnerIsFull(
  pairs: ReadonlyArray<{ repoId: number; relatedRepoId: number }>,
  repoId: number,
  partnerId: number,
  max: number,
): boolean {
  const theirs = relatedTo(pairs, partnerId);
  return !theirs.includes(repoId) && theirs.length >= max;
}
