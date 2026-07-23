import { useEffect, useState } from 'react';
import type { SearchHit, SearchHitKind } from '@pierre-review/shared';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useSearchResults } from '../../hooks/useSearch.js';
import { useFilters } from '../../store/filters.js';
import { MagnifierIcon } from '../Icons.js';
import { KIND_GLYPH, KIND_LABEL, openSearchHit } from './searchNav.js';

// The full cross-team search-results tab (a singleton drill-down overlay). Reads the query from the
// transient `searchSeed`, offers an editable box + kind filters + a People facet, lists every hit
// (paginated "Load more"), and opens a hit on click (thread hits deep-link to their thread). Scoped
// to the active team (via useSearchResults). Kept fully in the read layer — no writes.
const KIND_FILTERS: { key: SearchHitKind; label: string }[] = [
  { key: 'pr', label: 'PRs' },
  { key: 'review', label: 'Reviews' },
  { key: 'review_comment', label: 'Threads' },
  { key: 'pr_comment', label: 'Comments' },
];

export function SearchResultsTab(): JSX.Element {
  const seed = useFilters((s) => s.searchSeed);
  const openSearchDetail = useFilters((s) => s.openSearchDetail);
  const [q, setQ] = useState(seed ?? '');
  const [kinds, setKinds] = useState<SearchHitKind[]>([]);

  // If the seed changes from OUTSIDE (e.g. clicking a Person, or re-opening the tab for a new
  // query), adopt it into the box. Compare against the TRIMMED input, not `q` — our own debounced
  // sync effect writes the trimmed value back to the seed, so comparing to raw `q` would rewrite
  // the box and strip an in-progress trailing space ("foo " → "foo"). This only fires for a seed
  // that genuinely differs from what the user is typing.
  useEffect(() => {
    if (seed != null && seed !== q.trim()) setQ(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const debounced = useDebouncedValue(q.trim(), 300);
  // Keep the tab chip label in sync with what's actually being searched.
  useEffect(() => {
    if (debounced !== (useFilters.getState().searchSeed ?? '')) {
      useFilters.setState({ searchSeed: debounced });
    }
  }, [debounced]);

  const { hits, people, total, isLoading, isFetching, hasMore, fetchMore, isFetchingMore } =
    useSearchResults(debounced, kinds);

  const toggleKind = (k: SearchHitKind): void =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <div className="mx-auto max-w-[100rem] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Search</h2>
        <div className="relative">
          <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
            <MagnifierIcon size={14} />
          </div>
          <input
            type="search"
            value={q}
            autoFocus
            placeholder="Search PRs, reviews, threads, comments, people…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openSearchDetail(q.trim());
            }}
            className="w-96 rounded border border-gray-300 bg-transparent py-1 pl-8 pr-2 text-sm focus:border-blue-500 focus:outline-none dark:border-gray-700"
          />
        </div>
        <div className="flex items-center gap-1">
          {KIND_FILTERS.map((f) => {
            const on = kinds.includes(f.key);
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => toggleKind(f.key)}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  on
                    ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                {f.label}
              </button>
            );
          })}
          {kinds.length > 0 && (
            <button
              type="button"
              onClick={() => setKinds([])}
              className="px-2 py-0.5 text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Clear
            </button>
          )}
        </div>
        <span className="ml-auto text-xs text-gray-400">
          {debounced.length < 1
            ? 'Type to search'
            : isLoading
              ? 'Searching…'
              : `${hits.length} of ${total} result${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {people.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            People
          </span>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => openSearchDetail(p.login)}
              className="flex items-center gap-1.5 rounded-full border border-gray-200 px-2 py-0.5 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {p.avatarUrl != null ? (
                <img src={p.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
              ) : (
                <span className="h-4 w-4 rounded-full bg-gray-300 dark:bg-gray-700" />
              )}
              <span>{p.login}</span>
              <span className="text-gray-400">{p.matchCount}</span>
            </button>
          ))}
        </div>
      )}

      {debounced.length >= 1 && !isLoading && hits.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500 dark:border-gray-700">
          No matches for “{debounced}”{kinds.length > 0 ? ' with the selected filters' : ''}.
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {hits.map((h) => (
            <SearchRow key={`${h.kind}:${h.refId}`} hit={h} />
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={fetchMore}
            disabled={isFetchingMore}
            className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {isFetchingMore ? 'Loading…' : `Load more (${total - hits.length} more)`}
          </button>
        </div>
      )}
      {isFetching && !isLoading && (
        <div className="mt-2 text-center text-[11px] text-gray-400">Updating…</div>
      )}
    </div>
  );
}

function SearchRow({ hit }: { hit: SearchHit }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={() => openSearchHit(hit)}
        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
      >
        <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
          <span aria-hidden>{KIND_GLYPH[hit.kind]}</span>
          <span className="font-medium text-gray-500 dark:text-gray-400">{KIND_LABEL[hit.kind]}</span>
          <span aria-hidden>·</span>
          <span className="truncate font-medium text-gray-600 dark:text-gray-300">
            {hit.repoFullName} #{hit.prNumber}
          </span>
          {hit.authorLogin ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{hit.authorLogin}</span>
            </>
          ) : null}
          {hit.kind === 'review_comment' ? (
            <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              opens thread
            </span>
          ) : null}
        </span>
        <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
          {hit.prTitle}
        </span>
        {hit.snippet && hit.kind !== 'pr' ? (
          <span className="line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{hit.snippet}</span>
        ) : null}
      </button>
    </li>
  );
}
