import { useRef, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useSearchDropdown } from '../../hooks/useSearch.js';
import { useFilters } from '../../store/filters.js';
import { MagnifierIcon } from '../Icons.js';
import { KIND_ICON, KIND_LABEL, openSearchHit } from './searchNav.js';
import { highlightTerms } from './highlight.js';

// The global cross-repo search box (in the FilterBar). Debounced; a query ≥ 2 chars pops a panel of
// the top hits (PRs / reviews / threads / comments) + matching people. Clicking a hit opens it (a
// thread hit deep-links to its thread); Enter, or "See all results", opens the full results tab.
// Scoped to the ACTIVE WORKSPACE (useSearchDropdown reads `workspaceId` straight from the store, so
// a caller cannot widen it). Purely additive to the timeline-title TimelineSearch — this one
// searches the SERVER index (bodies, comments, people), not loaded PRs.
//
// The input carries a stable `id` because it is the `/` shortcut's target (hooks/useKeyboard.ts):
// this box is mounted on EVERY view, where the add-repo field only exists inside the
// "Manage repos & workspaces" modal.
export function GlobalSearch(): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openSearchDetail = useFilters((s) => s.openSearchDetail);

  const debounced = useDebouncedValue(query.trim(), 300);
  const { data, isFetching } = useSearchDropdown(debounced);

  const showPanel = open && query.trim().length >= 2;
  useClickOutside(rootRef, () => setOpen(false), showPanel);

  const hits = data?.hits ?? [];
  const people = data?.people ?? [];
  const total = data?.total ?? 0;
  // The panel opens on the LIVE query (>= 2 chars) but results track the LAGGING debounced value,
  // so between a keystroke and the 300ms settle the query hasn't fired yet — treat that as pending
  // (show "Searching…", not a premature "No matches.").
  const pending = query.trim() !== debounced || isFetching;

  const seeAll = (): void => {
    const q = query.trim();
    if (q.length === 0) return;
    openSearchDetail(q);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      seeAll();
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
        <MagnifierIcon size={13} />
      </div>
      <input
        id="global-search-input"
        type="search"
        value={query}
        placeholder="Search PRs, threads, people…"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search PRs, reviews, threads, comments and people across this workspace's repos"
        className="w-64 rounded border border-gray-300 bg-transparent py-0.5 pl-7 pr-2 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
      />
      {showPanel && (
        <div className="absolute left-0 top-full z-[60] mt-1 max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {hits.length === 0 && people.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              {pending ? 'Searching…' : 'No matches.'}
            </div>
          ) : (
            <>
              {people.length > 0 && (
                <div className="border-b border-gray-100 py-1 dark:border-gray-800">
                  <div className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    People
                  </div>
                  {people.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        openSearchDetail(p.login);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      {p.avatarUrl != null ? (
                        <img src={p.avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full" />
                      ) : (
                        <span className="h-4 w-4 shrink-0 rounded-full bg-gray-300 dark:bg-gray-700" />
                      )}
                      <span className="truncate text-xs">
                        {p.login}
                        {p.displayName ? (
                          <span className="text-gray-400"> · {p.displayName}</span>
                        ) : null}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                        {p.matchCount}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {hits.map((h) => {
                const KindIcon = KIND_ICON[h.kind];
                return (
                  <button
                    key={`${h.kind}:${h.refId}`}
                    type="button"
                    onClick={() => {
                      openSearchHit(h);
                      setOpen(false);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <span className="flex items-center gap-1 text-[10px] text-gray-400">
                      <KindIcon size={11} />
                      <span className="font-medium text-gray-500 dark:text-gray-400">
                        {KIND_LABEL[h.kind]}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="truncate">
                        {h.repoFullName} #{h.prNumber}
                      </span>
                    </span>
                    <span className="truncate text-xs font-medium">
                      {highlightTerms(h.prTitle, debounced)}
                    </span>
                    {h.snippet && h.kind !== 'pr' ? (
                      <span className="line-clamp-1 text-[11px] text-gray-500 dark:text-gray-400">
                        {highlightTerms(h.snippet, debounced)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </>
          )}
          <button
            type="button"
            onClick={seeAll}
            className="sticky bottom-0 flex w-full items-center justify-center gap-1 border-t border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-sky-600 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-sky-400 dark:hover:bg-gray-800"
          >
            See all results{total > 0 ? ` (${total})` : ''} for “{query.trim()}”
          </button>
        </div>
      )}
    </div>
  );
}
