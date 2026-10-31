import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

/**
 * EVERY READ OF THE PER-PR "SEEN" STAMP (`pr_views`), refreshed together after it moves — opening
 * a PR (PrDetail's markViewed) or "Mark all seen" on a repo's status panel. Prefixes, so every
 * workspace slot refreshes.
 *
 * ⚠ VIEWING A PR IS A MY-TURN MUTATION: `your_pr` rows leave getMyTurn's new-activity section the
 * instant the stamp moves, so the board, the daily-brief count and the work plan (one fold, read
 * three times — prCacheSync.ts) move together. And `activity` carries the sidebar's BLUE dot and
 * the repo status panel's blue line (`ActivityRepo.hasUnread` / `unreadPrs`).
 */
export function invalidateSeenState(qc: QueryClient): void {
  for (const key of ['open-prs', 'timeline', 'my-turn', 'me', 'attention-cards', 'daily-brief', 'work-plan', 'activity']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/** "Mark all seen" for ONE repo: stamps its open PRs viewed (POST /api/prs/mark-all-viewed). */
export function useMarkRepoSeen(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    // ⚠ Always a one-element list: an EMPTY list is read by the client as "every repo".
    mutationFn: () => api.markAllViewed([repoId]),
    onSuccess: () => invalidateSeenState(qc),
  });
}
