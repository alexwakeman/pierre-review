import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentAssessmentResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Comment-validity assessment (Pro; reuses the prSummary capability). A retained Haiku verdict on
// a review thread's root comment. The GET is a cache read (retained after generation); the refresh
// mutation is the billing path. `enabled` gates on the prSummary capability + a real threadId.
// staleTime Infinity: the stored assessment doesn't change unless the user regenerates.
export function useCommentAssessment(threadId: number | null, enabled: boolean) {
  return useQuery<CommentAssessmentResponse>({
    queryKey: ['comment-assessment', threadId],
    queryFn: () => api.threadAssessment(threadId as number),
    enabled: threadId != null && enabled,
    staleTime: Infinity,
  });
}

// `diffHunk` = the thread's hydrated root-comment diff hunk, forwarded so the server-side
// check always has diff context (the DB column is null under lean storage).
export function useAssessComment(threadId: number, diffHunk?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.assessThread(threadId, diffHunk),
    onSuccess: (data) => {
      qc.setQueryData(['comment-assessment', threadId], data);
      // This route now writes the SAME row the annotations platform serves
      // (kind='validity'), so the PR-wide annotations cache must not keep the old copy.
      void qc.invalidateQueries({ queryKey: ['pr-annotations'] });
    },
  });
}
