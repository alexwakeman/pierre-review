import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';

// Shown on a review thread that's in the user's "My Turn" set (a thread awaiting
// their response). Marks it done — the same dismissal as the My Turn panel's Done
// button — so it leaves the queue (and lands in the "Done" tab) while staying in
// the PR. Only mounted when the thread is in My Turn, so the mutation/observer is
// created only where needed.
export function MarkThreadDone({ threadId }: { threadId: number }): JSX.Element {
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api.dismissMyTurn('thread', threadId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['my-turn-done'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <button
      type="button"
      onClick={() => dismiss.mutate()}
      disabled={dismiss.isPending}
      title="Awaiting your response (in My Turn) — mark it done"
      className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300"
    >
      ✓ Done
    </button>
  );
}
