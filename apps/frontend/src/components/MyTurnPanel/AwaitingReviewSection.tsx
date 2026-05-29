import type { AwaitingReviewItem, User } from '@gh-team-monitor/shared';
import { useFilters } from '../../store/filters.js';
import { relativeTime } from '../../lib/ui.js';

export function AwaitingReviewSection({
  items,
}: {
  items: AwaitingReviewItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openPrFocused = useFilters((s) => s.openPrFocused);
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
          <li key={it.prId}>
            <button
              type="button"
              onClick={() => openPrFocused(it.prId)}
              className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
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
          </li>
        ))}
      </ul>
    </section>
  );
}
