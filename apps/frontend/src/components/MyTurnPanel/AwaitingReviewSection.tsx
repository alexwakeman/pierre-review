import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AwaitingReviewItem, User } from '@gh-team-monitor/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';

export function AwaitingReviewSection({
  items,
}: {
  items: AwaitingReviewItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (prId: number) => api.dismissMyTurn('review_request', prId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (items.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <span className="text-blue-500">●</span>
        Awaiting your review
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li key={it.prId} className="group flex items-stretch">
            <button
              type="button"
              onClick={() => openPrFocused(it.prId)}
              className="flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <span className="shrink-0 text-xs text-gray-400">
                {it.repoFullName} #{it.number}
              </span>
              <span className="min-w-0 flex-1 truncate" title={it.title}>
                {it.title}
              </span>
              {it.alsoRequested > 0 && (
                <span className="shrink-0 text-[11px] text-gray-400">
                  +{it.alsoRequested} other{it.alsoRequested === 1 ? '' : 's'}
                </span>
              )}
              <span className="shrink-0 text-[11px] text-gray-400">
                {relativeTime(it.openedAt)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => dismiss.mutate(it.prId)}
              disabled={dismiss.isPending}
              className="shrink-0 rounded px-1.5 text-[11px] text-gray-300 opacity-0 hover:text-gray-600 group-hover:opacity-100 dark:text-gray-600 dark:hover:text-gray-300"
              title="Dismiss — reappears if the PR is updated"
            >
              ✓ done
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
