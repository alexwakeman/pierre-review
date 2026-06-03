import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RepoSearchResponse,
  RepoSearchResult,
} from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useFilters } from '../store/filters.js';

// Don't fire a search until there's something to match on.
const MIN_QUERY = 2;
// The same cache cascade AddRepo used to run on success.
const INVALIDATE_KEYS = [
  'repos',
  'timeline',
  'open-prs',
  'users',
  'my-turn',
  'me',
];

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function OwnerAvatar({
  login,
  src,
}: {
  login: string;
  src: string | null;
}): JSX.Element {
  if (src) {
    return (
      <img
        src={src}
        alt={login}
        width={20}
        height={20}
        className="mt-0.5 h-5 w-5 shrink-0 rounded-full"
      />
    );
  }
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-300 text-[9px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
      {login.slice(0, 2).toUpperCase()}
    </span>
  );
}

// Debounced, search-on-keypress repository picker that replaces the old plain
// "owner/repo" input. Results come live from GitHub (best-match order), already-
// watched repos are filtered server-side, and repos you own / are an org member
// of are floated to the top. Picking a result adds the repo (the existing add
// flow) and refetches the list so it drops out of the results.
export function RepoSearch(): JSX.Element {
  const qc = useQueryClient();
  const requestSyncModal = useFilters((s) => s.requestSyncModal);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Cursor stack for pagination: cursors[i] is the GitHub `after` cursor for
  // page i (page 0 = null/first page). pageIdx indexes into it.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIdx, setPageIdx] = useState(0);

  const debounced = useDebouncedValue(value.trim(), 300);
  const showPanel = open && debounced.length >= MIN_QUERY;
  const cursor = cursors[pageIdx] ?? null;

  // A fresh search term resets pagination back to the first page.
  useEffect(() => {
    setCursors([null]);
    setPageIdx(0);
    setActive(0);
  }, [debounced]);

  const query = useQuery<RepoSearchResponse>({
    queryKey: ['repo-search', debounced, cursor],
    queryFn: () => api.searchRepos(debounced, cursor ?? undefined),
    enabled: showPanel,
    placeholderData: (prev) => prev, // keep the list while paging / re-typing
    staleTime: 60_000,
  });

  const addRepo = useMutation({
    mutationFn: (r: RepoSearchResult) =>
      api.addRepo({ owner: r.owner, name: r.name }),
    onSuccess: (repo) => {
      for (const key of INVALIDATE_KEYS) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
      // Refetch the search so the just-added repo drops out of the results.
      void qc.invalidateQueries({ queryKey: ['repo-search'] });
      // Surface the sync-progress modal so the user sees the initial backfill is
      // underway (it can take a while for a busy repo). Scope it to JUST this repo
      // so a concurrent scheduled sync of the others doesn't bounce their bars.
      requestSyncModal(repo.id);
    },
  });

  const results = query.data?.results ?? [];
  const hasNextPage = query.data?.hasNextPage ?? false;

  // Keep the active index in range when the result set shrinks/changes.
  useEffect(() => {
    setActive((a) => (results.length ? Math.min(a, results.length - 1) : 0));
  }, [results]);

  // Outside-click + Escape close (mirrors UserSelectPanel).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Scroll the active row into view as the user arrow-keys through results.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  function gotoNext(): void {
    const next = query.data?.cursor;
    if (!hasNextPage || next == null) return;
    setCursors((cs) => [...cs.slice(0, pageIdx + 1), next]);
    setPageIdx((p) => p + 1);
    setActive(0);
  }

  function gotoPrev(): void {
    if (pageIdx === 0) return;
    setPageIdx((p) => p - 1);
    setActive(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!showPanel) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active];
      if (r && !addRepo.isPending) addRepo.mutate(r);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        id="add-repo-input"
        type="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search repos to add…"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listboxId}
        aria-autocomplete="list"
        className="w-44 rounded border border-gray-300 bg-transparent px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
      />

      {showPanel && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Repository search results"
          className="absolute left-0 top-full z-[60] mt-1 max-h-96 w-96 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {query.isError ? (
            <div className="px-3 py-2 text-xs text-red-500">
              {query.error instanceof ApiError
                ? query.error.message
                : 'Search failed'}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500">
              {query.isFetching ? 'Searching…' : 'No matching repositories.'}
            </div>
          ) : (
            <div ref={listRef}>
              {results.map((r, idx) => {
                const adding =
                  addRepo.isPending &&
                  addRepo.variables?.githubNodeId === r.githubNodeId;
                return (
                  <button
                    key={r.githubNodeId}
                    data-idx={idx}
                    type="button"
                    role="option"
                    aria-selected={idx === active}
                    disabled={addRepo.isPending}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => addRepo.mutate(r)}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left disabled:opacity-60 ${
                      idx === active ? 'bg-gray-100 dark:bg-gray-800' : ''
                    } hover:bg-gray-100 dark:hover:bg-gray-800`}
                  >
                    <OwnerAvatar login={r.owner} src={r.ownerAvatarUrl} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="truncate text-xs font-medium text-gray-800 dark:text-gray-100"
                          title={r.fullName}
                        >
                          {r.fullName}
                        </span>
                        {r.isPrivate && (
                          <span className="shrink-0 rounded bg-gray-200 px-1 text-[9px] uppercase tracking-wide text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                            private
                          </span>
                        )}
                        {r.isOwnedOrMember && (
                          <span className="shrink-0 rounded bg-sky-100 px-1 text-[9px] uppercase tracking-wide text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
                            yours
                          </span>
                        )}
                      </span>
                      {r.description && (
                        <span className="mt-0.5 line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">
                          {r.description}
                        </span>
                      )}
                      <span className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-400">
                        <span title={`${r.stargazerCount} stars`}>
                          ★ {compactNumber(r.stargazerCount)}
                        </span>
                        <span aria-hidden>·</span>
                        <span title={`${r.openPrCount} open pull requests`}>
                          {compactNumber(r.openPrCount)} open PR
                          {r.openPrCount === 1 ? '' : 's'}
                        </span>
                      </span>
                    </span>
                    <span className="mt-0.5 shrink-0 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white">
                      {adding ? 'Adding…' : 'Add'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {(pageIdx > 0 || hasNextPage) && (
            <div className="sticky bottom-0 flex items-center justify-between border-t border-gray-200 bg-white px-3 py-1.5 text-[11px] dark:border-gray-700 dark:bg-gray-900">
              <button
                type="button"
                onClick={gotoPrev}
                disabled={pageIdx === 0}
                className="text-gray-500 hover:text-gray-800 disabled:opacity-30 dark:text-gray-400 dark:hover:text-gray-100"
              >
                ← Prev
              </button>
              <span className="text-gray-400">Page {pageIdx + 1}</span>
              <button
                type="button"
                onClick={gotoNext}
                disabled={!hasNextPage}
                className="text-gray-500 hover:text-gray-800 disabled:opacity-30 dark:text-gray-400 dark:hover:text-gray-100"
              >
                Next →
              </button>
            </div>
          )}

          {addRepo.error && (
            <div className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-red-500 dark:border-gray-700">
              {addRepo.error instanceof ApiError
                ? addRepo.error.message
                : 'Failed to add repo'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
