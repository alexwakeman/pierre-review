import { useEffect, useRef, useState } from 'react';
import type { Repo } from '@pierre-review/shared';

// Show/hide dropdown for the watched repos. Replaces the old pill buttons: each
// repo is a checkbox row showing the full `owner/name` (so same-named repos under
// different owners are distinguishable). A checked row is visible on the timeline;
// unchecking hides it. Committed state lives in the store's `repoIds` (null = all
// shown); toggling is immediate (no Apply) — this is a visibility control, not a
// staged multi-select. Each row also carries a remove (stop-watching) affordance.
export function RepoSelectPanel({
  repos,
  repoIds,
  onToggle,
  onShowAll,
  onRemove,
  removePending,
}: {
  repos: Repo[];
  repoIds: number[] | null; // committed visibility filter (null = all visible)
  onToggle: (id: number) => void; // immediate show/hide of one repo
  onShowAll: () => void; // clear the filter → show every repo
  onRemove: (repo: Repo) => void; // stop watching (caller confirms + mutates)
  removePending: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const total = repos.length;
  const isVisible = (id: number): boolean =>
    repoIds == null || repoIds.includes(id);
  const shownCount = repoIds == null ? total : repoIds.length;
  const filtered = repoIds != null && shownCount < total;

  // Outside-click + Escape dismiss (mirrors UserSelectPanel). Escape is stopped
  // from bubbling to the global keyboard handler (which would clear the selection).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = filter.trim().toLowerCase();
  const rows = repos.filter((r) => !q || r.fullName.toLowerCase().includes(q));

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger + (when filtered) a clear-✕. Sibling buttons in one pill. */}
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-gray-300 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 py-0.5 pl-2.5 ${
            filtered ? 'pr-1' : 'pr-2.5'
          }`}
        >
          Repos
          {total > 0 ? ` (${filtered ? `${shownCount}/${total}` : total})` : ''}
          <span aria-hidden className="text-[9px]">
            ▾
          </span>
        </button>
        {filtered && (
          <button
            type="button"
            onClick={() => onShowAll()}
            title="Show all repos"
            aria-label="Show all repos"
            className="py-0.5 pl-0.5 pr-2 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Repositories"
          className="absolute left-0 top-full z-[60] mt-1 w-80 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {total > 8 && (
            <input
              autoFocus
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter repos…"
              aria-label="Filter repos"
              className="mb-2 w-full rounded border border-gray-300 bg-transparent px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
            />
          )}

          <div className="max-h-72 overflow-y-auto">
            {total === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-500">
                No repos yet — search to add one.
              </div>
            ) : rows.length === 0 ? (
              <div className="px-1 py-2 text-xs text-gray-500">No repos match.</div>
            ) : (
              rows.map((r) => {
                // Don't let the user hide the only visible repo (would leave an
                // empty timeline with everything unchecked). The checkbox for the
                // last shown repo is disabled.
                const lastShown = isVisible(r.id) && shownCount <= 1;
                return (
                  <div
                    key={r.id}
                    className="group flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <label
                      className={`flex min-w-0 flex-1 items-center gap-2 ${
                        lastShown ? 'cursor-default' : 'cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isVisible(r.id)}
                        disabled={lastShown}
                        onChange={() => onToggle(r.id)}
                        title={lastShown ? 'At least one repo must stay shown' : undefined}
                      />
                      <span className="min-w-0 truncate" title={r.fullName}>
                        <span className="text-gray-400">{r.owner}/</span>
                        <span className="font-medium text-gray-800 dark:text-gray-100">
                          {r.name}
                        </span>
                      </span>
                      {r.lastSyncStatus === 'error' && (
                        <span
                          className="shrink-0 text-red-500"
                          title={r.lastSyncError ?? 'Last sync failed'}
                          aria-label="Last sync failed"
                        >
                          ⚠
                        </span>
                      )}
                    </label>
                    <button
                      type="button"
                      onClick={() => onRemove(r)}
                      disabled={removePending}
                      title={`Stop watching ${r.fullName}`}
                      aria-label={`Stop watching ${r.fullName}`}
                      className="shrink-0 px-1 text-gray-400 opacity-0 hover:text-red-500 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {filtered && (
            <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
              <span className="text-[11px] text-gray-400">
                {shownCount} of {total} shown
              </span>
              <button
                type="button"
                onClick={() => onShowAll()}
                className="text-[11px] text-gray-400 hover:text-gray-600"
              >
                Show all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
