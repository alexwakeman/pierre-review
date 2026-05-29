import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ThreadAwaitingItem, User } from '@gh-team-monitor/shared';
import { api } from '../../api/client.js';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';

export function ThreadsAwaitingSection({
  items,
}: {
  items: ThreadAwaitingItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (threadId: number) => api.dismissMyTurn('thread', threadId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (items.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <span className="text-amber-500">●</span>
        Threads awaiting your response
        <span className="text-gray-400">({items.length})</span>
      </h3>
      <ul className="space-y-0.5">
        {items.map((it) => {
          const file = it.path.split('/').at(-1);
          return (
            <li key={it.threadId} className="group flex items-stretch">
              <button
                type="button"
                onClick={() => openPrFocused(it.prId, it.threadId)}
                className="min-w-0 flex-1 rounded px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="shrink-0 text-xs text-gray-400">
                    {it.repoFullName} #{it.prNumber}
                  </span>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs" title={it.path}>
                    {file}
                    {it.line != null ? `:${it.line}` : ''}
                  </code>
                  <span className="shrink-0 text-[11px] text-gray-400">
                    {relativeTime(it.lastReplyAt)}
                  </span>
                </div>
                <div className="truncate pl-1 text-[11px] italic text-gray-500" title={it.lastReplyExcerpt}>
                  “{it.lastReplyExcerpt}”
                </div>
              </button>
              <button
                type="button"
                onClick={() => dismiss.mutate(it.threadId)}
                disabled={dismiss.isPending}
                className="shrink-0 self-start rounded px-1.5 py-1 text-[11px] text-gray-300 opacity-0 hover:text-gray-600 group-hover:opacity-100 dark:text-gray-600 dark:hover:text-gray-300"
                title="Dismiss — reappears on a newer reply"
              >
                ✓ done
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
