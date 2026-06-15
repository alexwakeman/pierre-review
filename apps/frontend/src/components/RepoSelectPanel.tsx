import { useEffect, useRef, useState } from 'react';
import type { Repo } from '@pierre-review/shared';
import { useClickOutside } from '../hooks/useClickOutside.js';

// Show/hide dropdown for the added repos. Each repo is a checkbox row showing the
// full `owner/name` (so same-named repos under different owners are distinguishable).
// A checked row is visible on the timeline; unchecking hides it. Committed state lives
// in the store's `repoIds` (null = all shown); toggling is immediate (no Apply) — this
// is a visibility control, not a staged multi-select. Each row also carries a "Watch"
// toggle (new open PRs by others go to the My Turn inbox — independent of timeline
// visibility) and a Remove (delete) affordance.
export function RepoSelectPanel({
  repos,
  repoIds,
  onToggle,
  onOnly,
  onShowAll,
  onToggleWatch,
  watchPending,
  onRemove,
  removePending,
}: {
  repos: Repo[];
  repoIds: number[] | null; // committed visibility filter (null = all visible)
  onToggle: (id: number) => void; // immediate show/hide of one repo
  onOnly: (id: number) => void; // isolate to just this repo (deselect the rest)
  onShowAll: () => void; // clear the filter → show every repo
  onToggleWatch: (repo: Repo) => void; // toggle inbox watch (caller mutates)
  watchPending: boolean;
  onRemove: (repo: Repo) => void; // remove/delete the repo (caller confirms + mutates)
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

  // Outside-click dismiss via the shared hook. Escape stays INLINE below: it must
  // stopPropagation() so it doesn't bubble to the global keyboard handler (which
  // would clear the selection), so it can't be folded into the mousedown hook.
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
                    {/* Watch toggle: new open PRs by others in this repo go to the My
                        Turn inbox (independent of timeline visibility). Persistently
                        shown (in sky) when watching, so watched repos read at a glance;
                        a hover affordance otherwise. */}
                    <button
                      type="button"
                      onClick={() => onToggleWatch(r)}
                      disabled={watchPending}
                      aria-pressed={r.inboxWatch}
                      title={
                        r.inboxWatch
                          ? `Watching ${r.fullName} — new PRs go to your inbox. Click to stop.`
                          : `Watch ${r.fullName}: new open PRs go to your My Turn inbox`
                      }
                      aria-label={
                        r.inboxWatch
                          ? `Stop watching ${r.fullName} for the inbox`
                          : `Watch ${r.fullName} for the inbox`
                      }
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide disabled:opacity-30 ${
                        r.inboxWatch
                          ? 'text-sky-600 hover:bg-sky-100 dark:text-sky-400 dark:hover:bg-sky-900/40'
                          : 'text-gray-400 opacity-0 hover:bg-gray-200 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-200'
                      }`}
                    >
                      {r.inboxWatch ? 'watching' : 'watch'}
                    </button>
                    {/* Quick-isolate: show only this repo (deselect the rest), so
                        you can hop between repos without unchecking everything.
                        Hidden when this repo is already the sole visible one. */}
                    {!(isVisible(r.id) && shownCount === 1) && (
                      <button
                        type="button"
                        onClick={() => onOnly(r.id)}
                        title={`Show only ${r.fullName}`}
                        aria-label={`Show only ${r.fullName}`}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400 opacity-0 hover:bg-gray-200 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                      >
                        only
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemove(r)}
                      disabled={removePending}
                      title={`Remove ${r.fullName}`}
                      aria-label={`Remove ${r.fullName}`}
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
