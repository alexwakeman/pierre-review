import type { ClaudeReview, ClaudeReviewSummary } from '@pierre-review/shared';

/**
 * The Claude review an AI Fix is built from: the one handed over from the Claude Review tab, else
 * the PR's newest SUCCEEDED run — a failed (or still running) newer run never hides an older
 * finished one. null only when no run on the PR has succeeded.
 */
export function fixSourceReviewId(
  handoffReviewId: number | null,
  latest: Pick<ClaudeReview, 'id' | 'status'> | null,
  history: ReadonlyArray<Pick<ClaudeReviewSummary, 'id' | 'status'>>,
): number | null {
  if (handoffReviewId != null) return handoffReviewId;
  if (latest?.status === 'succeeded') return latest.id;
  // `history` is newest first.
  return history.find((h) => h.status === 'succeeded')?.id ?? null;
}

/** The line above the picker when the fix is not built from the latest run, or null. */
export function olderSourceNote(
  handoffReviewId: number | null,
  sourceId: number | null,
  latest: Pick<ClaudeReview, 'id' | 'status'> | null,
): string | null {
  if (sourceId == null || latest == null || sourceId === latest.id) return null;
  if (handoffReviewId != null) return 'Uses the review you picked, not the latest.';
  if (latest.status === 'failed') return 'Uses the last review that finished. The latest one failed.';
  if (latest.status === 'running' || latest.status === 'queued')
    return 'Uses the last review that finished. A newer one is running.';
  return 'Uses the last review that finished.';
}
