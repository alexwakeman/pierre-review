import type { User, YourPrActivityItem } from '@gh-team-monitor/shared';
import { useFilters } from '../../store/filters.js';

export function YourPrsSection({
  items,
}: {
  items: YourPrActivityItem[];
  usersById: Map<number, User>;
}): JSX.Element | null {
  const openPrFocused = useFilters((s) => s.openPrFocused);
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
          <li key={it.prId}>
            <button
              type="button"
              onClick={() => openPrFocused(it.prId)}
              className="w-full rounded px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
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
          </li>
        ))}
      </ul>
    </section>
  );
}
