import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { User, YourPrActivityItem } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';

export function YourPrsSection({
  items,
}: {
  items: YourPrActivityItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const qc = useQueryClient();
  // "Seen" = mark the PR viewed; its new-activity badge clears and it drops out.
  const dismiss = useMutation({
    mutationFn: (prId: number) => api.dismissPr(prId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
    },
  });
  if (items.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <span className="text-green-500">●</span>
        Your PRs with new activity
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li key={it.prId} className="group flex items-stretch">
            <button
              type="button"
              onClick={() => openPrFocused(it.prId)}
              className="min-w-0 flex-1 rounded px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <div className="flex items-baseline gap-2 text-sm">
                <span className="shrink-0 text-xs text-gray-400">
                  {it.repoFullName} #{it.number}
                </span>
                <span className="min-w-0 flex-1 truncate" title={it.title}>
                  {it.title}
                </span>
              </div>
              <div className="pl-1 text-[11px] font-medium text-sky-500">
                {it.summary}
              </div>
            </button>
            <button
              type="button"
              onClick={() => dismiss.mutate(it.prId)}
              disabled={dismiss.isPending}
              className="shrink-0 self-start rounded px-1.5 py-1 text-[11px] text-gray-300 opacity-0 hover:text-gray-600 group-hover:opacity-100 dark:text-gray-600 dark:hover:text-gray-300"
              title="Mark seen — clears the new-activity badge"
            >
              ✓ seen
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
