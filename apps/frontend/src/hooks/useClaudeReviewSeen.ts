import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClaudeReview, ClaudeReviewResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// MY TURN → "NEW AI REVIEW BY YOUR LIMN": the AI Review tab has this finished run ON SCREEN, so the
// reader has seen it (`POST /api/prs/:id/claude-review/seen`; docs/BACKEND.md § My Turn).
//
// ⚠ ONCE PER RUN, AND ONLY WHILE `seenAt === null`. Absent (`undefined`) is an older server: nothing
// is sent. The success writes `seenAt` into the cached review, so the refetches it starts (the board,
// the brief, My Turn) cannot send it again — and the server stamps only a NULL row anyway.

/** Should the tab send the seen stamp for this run? Pure. */
export function claudeReviewNeedsSeen(review: Pick<ClaudeReview, 'status' | 'reviewMode' | 'seenAt'> | null): boolean {
  return review != null && review.status === 'succeeded' && review.reviewMode !== 'skip' && review.seenAt === null;
}

export function useClaudeReviewSeen(prId: number, review: ClaudeReview | null, enabled: boolean): void {
  const qc = useQueryClient();
  const sentFor = useRef<number | null>(null);
  const mark = useMutation({
    mutationFn: (v: { prId: number; reviewId: number }) => api.markClaudeReviewSeen(v.prId, v.reviewId),
    onSuccess: (_r, v) => {
      const at = new Date().toISOString();
      qc.setQueryData<ClaudeReviewResponse>(['claude-review', v.prId], (old) =>
        old?.review != null && old.review.id === v.reviewId ? { ...old, review: { ...old.review, seenAt: at } } : old,
      );
      for (const key of ['attention-cards', 'daily-brief', 'my-turn']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const markRef = useRef(mark.mutate);
  markRef.current = mark.mutate;
  useEffect(() => {
    if (!enabled || review == null || !claudeReviewNeedsSeen(review)) return;
    if (sentFor.current === review.id) return;
    sentFor.current = review.id;
    markRef.current({ prId, reviewId: review.id });
  }, [enabled, prId, review]);
}
