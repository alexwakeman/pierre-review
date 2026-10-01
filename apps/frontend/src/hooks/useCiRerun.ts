import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CiRerunMode } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';

export interface RerunOutcome {
  mode: CiRerunMode;
  queued: number;
  failed: number;
}

// Re-trigger CI for a PR. GitHub reruns operate per WORKFLOW RUN, so a PR head can
// have several failed runs — we fire one call per distinct run id. We use
// `allSettled` (not `all`) so a partial failure (e.g. GitHub 403s a run that's too old
// or has no failed jobs) still reports the runs that DID queue rather than reporting
// the whole action as failed. Rejects only when EVERY run failed. The refreshed check
// states arrive later (GitHub runs asynchronously): the success refetches the ONE write set
// now (a `ci_failing` card and the CI dot read the same column), and the fast `['repos']`
// poll it opens carries the server's later re-reads to every screen; the UI shows a transient
// confirmation.
export function useRerunCi(prId: number) {
  const qc = useQueryClient();
  return useMutation<RerunOutcome, Error, { runIds: number[]; mode: CiRerunMode }>({
    mutationFn: async ({ runIds, mode }) => {
      const settled = await Promise.allSettled(
        runIds.map((runId) => api.rerunCi(prId, { runId, mode })),
      );
      const queued = settled.filter((r) => r.status === 'fulfilled').length;
      const failed = settled.length - queued;
      if (queued === 0) {
        const first = settled.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        throw first?.reason instanceof Error
          ? first.reason
          : new Error('Re-run failed');
      }
      return { mode, queued, failed };
    },
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}
