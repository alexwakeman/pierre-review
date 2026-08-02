import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_REPOS_PER_ACCOUNT, type Repo, type RepoSearchResponse } from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useRepos } from '../hooks/useTimeline.js';
import { ACTIVITY_QUERY_KEYS } from '../hooks/useActivity.js';
import { safeExternalUrl } from '../lib/ui.js';
import { SUGGESTED_REPOS } from '../lib/suggestedRepos.js';
import { useFilters } from '../store/filters.js';

// Don't fire a search until there's something to match on.
const MIN_QUERY = 2;
// The same cache cascade AddRepo used to run on success. Includes the Activity/Insights
// surface so a newly-added repo shows up in the rail/feed/Insights live.
const INVALIDATE_KEYS = [
  'repos',
  'timeline',
  'open-prs',
  'users',
  'my-turn',
  'me',
  ...ACTIVITY_QUERY_KEYS,
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

// Small inline spinner (matches the convention used in the Claude Review tab).
function Spinner(): JSX.Element {
  return (
    <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-gray-600 dark:border-t-blue-400" />
  );
}

// Debounced, search-on-keypress repository picker that replaces the old plain
// "owner/repo" input. Results come live from GitHub (best-match order), repos
// already added to the account are filtered server-side, and repos you own / are
// an org member of are floated to the top. Picking a result adds the repo (the
// existing add flow) and refetches the list so it drops out of the results.
export function RepoSearch({
  // Optional: called with the freshly-added repo after a successful add (in addition to the
  // usual sync-modal + cache-invalidation). WorkspaceManager uses it to MOVE a brand-new repo
  // (which lands in Default server-side) into the workspace the user is looking at.
  onAdded,
  // Optional placeholder override (e.g. "Add a repo to Platform…" in WorkspaceManager).
  placeholder = 'Search repos to add…',
}: {
  onAdded?: (repo: Repo) => void;
  placeholder?: string;
} = {}): JSX.Element {
  const qc = useQueryClient();
  const requestSyncModal = useFilters((s) => s.requestSyncModal);
  const showRepo = useFilters((s) => s.showRepo);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Repos added this session, keyed by `owner/name` lowercased. Used to hide a
  // just-added repo from the results/suggestions INSTANTLY (the POST /api/repos
  // response has no githubNodeId, so we key on owner/name — available on every
  // live result, every suggestion, and the mutation variables). The eventual
  // source of truth is still the ['repo-search'] / ['repos'] refetch.
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const addedKey = (r: { owner: string; name: string }): string =>
    `${r.owner}/${r.name}`.toLowerCase();
  // Cursor stack for pagination: cursors[i] is the GitHub `after` cursor for
  // page i (page 0 = null/first page). pageIdx indexes into it.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIdx, setPageIdx] = useState(0);

  const trimmed = value.trim();
  const debounced = useDebouncedValue(trimmed, 300);
  const showPanel = open && debounced.length >= MIN_QUERY;
  // Focusing the box with an empty (or <2-char) query shows curated suggestions.
  const showSuggestions = open && debounced.length < MIN_QUERY;
  const panelOpen = showPanel || showSuggestions;
  const cursor = cursors[pageIdx] ?? null;

  // Curated suggestions for the empty-query state, minus repos already added.
  const { data: repos } = useRepos();
  // Per-account repo cap (backend enforces it; we disable adds + explain here).
  const atRepoLimit = (repos?.length ?? 0) >= MAX_REPOS_PER_ACCOUNT;
  const added = useMemo(
    () => new Set((repos ?? []).map((r) => `${r.owner}/${r.name}`.toLowerCase())),
    [repos],
  );
  const suggestions = useMemo(
    () =>
      SUGGESTED_REPOS.filter(
        (s) =>
          !added.has(`${s.owner}/${s.name}`.toLowerCase()) &&
          !justAdded.has(`${s.owner}/${s.name}`.toLowerCase()),
      ),
    [added, justAdded],
  );

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
    // Accepts a live search result OR a curated suggestion — both carry owner+name,
    // which is all the POST needs (CreateRepoBody). There is no second visibility axis:
    // an added repo lands in the account's Default workspace and is immediately live.
    mutationFn: (r: { owner: string; name: string }) =>
      api.addRepo({ owner: r.owner, name: r.name }),
    // Hide the row IMMEDIATELY (before the search/repos refetch round-trips), keyed
    // on owner/name from the mutation variables.
    onMutate: (r) => {
      setJustAdded((prev) => new Set(prev).add(addedKey(r)));
    },
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
      // Ensure the just-added repo is visible even when a repo filter is active —
      // append it to the visible set (no-op when all repos are already shown).
      showRepo(repo.id);
      // Let a host (e.g. WorkspaceManager) react to the new repo — move it into a workspace.
      onAdded?.(repo);
    },
  });

  // Hide just-added repos from the live results immediately (the search refetch is
  // the eventual source of truth, but it lags a round-trip).
  const results = (query.data?.results ?? []).filter(
    (r) => !justAdded.has(`${r.owner}/${r.name}`.toLowerCase()),
  );
  const hasNextPage = query.data?.hasNextPage ?? false;

  // Show a spinner as soon as a search is in flight, through the fetch, while
  // placeholderData keeps the previous term's rows on screen. For a REFINEMENT (an
  // already-active search) it appears on the first keystroke — debounce pending,
  // before any network; for the first search the panel shows suggestions until the
  // debounce settles, then the spinner. Gated on showPanel so clearing the box
  // (→ suggestions / closed) never spins forever.
  const debouncePending = trimmed.length >= MIN_QUERY && trimmed !== debounced;
  const searching =
    showPanel && (debouncePending || query.isFetching || query.isPlaceholderData);

  // The keyboard-navigable list is the live results, or the curated suggestions in
  // the empty-query state (both carry owner+name, so one Enter handler adds either).
  const navItems = showSuggestions ? suggestions : results;

  // Keep the active index in range when the active list shrinks/changes.
  useEffect(() => {
    setActive((a) => (navItems.length ? Math.min(a, navItems.length - 1) : 0));
  }, [navItems]);

  // Outside-click close (shared hook). Escape close stays inline in onKeyDown.
  useClickOutside(rootRef, () => setOpen(false), open);

  // Scroll the active row into view as the user arrow-keys through the list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, navItems]);

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
    if (!panelOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(navItems.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = navItems[active];
      if (item && !addRepo.isPending && !atRepoLimit) {
        addRepo.mutate({ owner: item.owner, name: item.name });
      }
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
        placeholder={placeholder}
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          panelOpen && navItems[active]
            ? `${listboxId}-opt-${active}`
            : undefined
        }
        className="w-44 rounded border border-gray-300 bg-transparent px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
      />

      {panelOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Repository search results"
          className="absolute left-0 top-full z-[60] mt-1 max-h-96 w-96 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {atRepoLimit && (
            <div className="sticky top-0 z-20 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              You&rsquo;ve added the maximum of {MAX_REPOS_PER_ACCOUNT} repos.
              Remove one to add another.
            </div>
          )}
          {showSuggestions ? (
            <div>
              <div className="sticky top-0 z-10 border-b border-gray-200 bg-white px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:bg-gray-900">
                Suggested repos
              </div>
              {suggestions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-500">
                  You&rsquo;ve already added all the suggestions.
                </div>
              ) : (
                <div ref={listRef}>
                  {suggestions.map((s, idx) => {
                  const adding =
                    addRepo.isPending &&
                    addRepo.variables?.owner === s.owner &&
                    addRepo.variables?.name === s.name;
                  return (
                    <div
                      key={`${s.owner}/${s.name}`}
                      className={`flex items-stretch ${
                        idx === active ? 'bg-gray-100 dark:bg-gray-800' : ''
                      } hover:bg-gray-100 dark:hover:bg-gray-800`}
                    >
                      <button
                        id={`${listboxId}-opt-${idx}`}
                        data-idx={idx}
                        type="button"
                        role="option"
                        aria-selected={idx === active}
                        disabled={addRepo.isPending || atRepoLimit}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() =>
                          addRepo.mutate({ owner: s.owner, name: s.name })
                        }
                        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left disabled:opacity-60"
                      >
                        <OwnerAvatar login={s.owner} src={null} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="truncate text-xs font-medium text-gray-800 dark:text-gray-100"
                              title={`${s.owner}/${s.name}`}
                            >
                              {s.owner}/{s.name}
                            </span>
                            <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                              {s.category}
                            </span>
                          </span>
                          <span className="mt-0.5 line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">
                            {s.why}
                          </span>
                        </span>
                        <span className="mt-0.5 shrink-0 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white">
                          {adding ? 'Adding…' : 'Add'}
                        </span>
                      </button>
                      <a
                        href={`https://github.com/${s.owner}/${s.name}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title="Open on GitHub"
                        aria-label={`Open ${s.owner}/${s.name} on GitHub`}
                        className="flex shrink-0 items-center px-2 text-[10px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                      >
                        ↗
                      </a>
                    </div>
                  );
                  })}
                </div>
              )}
            </div>
          ) : query.isError ? (
            <div className="px-3 py-2 text-xs text-red-500">
              {query.error instanceof ApiError
                ? query.error.message
                : 'Search failed'}
            </div>
          ) : searching && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-gray-500">
              <Spinner />
              <span>Searching…</span>
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500">
              No matching repositories.
            </div>
          ) : (
            <div ref={listRef}>
              {searching && (
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-200 bg-white/95 px-3 py-1.5 text-[11px] text-gray-500 backdrop-blur dark:border-gray-700 dark:bg-gray-900/95 dark:text-gray-400">
                  <Spinner />
                  <span>Searching…</span>
                </div>
              )}
              {results.map((r, idx) => {
                const adding =
                  addRepo.isPending &&
                  addRepo.variables?.owner === r.owner &&
                  addRepo.variables?.name === r.name;
                return (
                  // The row is a flex container so the add <button> and the small
                  // "open on GitHub" <a> are SIBLINGS (a <button> can't legally
                  // contain an interactive <a>). The button keeps flex-1/min-w-0 so
                  // it still fills the row and remains the primary add affordance.
                  <div
                    key={r.githubNodeId}
                    className={`flex items-stretch ${
                      idx === active ? 'bg-gray-100 dark:bg-gray-800' : ''
                    } hover:bg-gray-100 dark:hover:bg-gray-800`}
                  >
                    <button
                      id={`${listboxId}-opt-${idx}`}
                      data-idx={idx}
                      type="button"
                      role="option"
                      aria-selected={idx === active}
                      disabled={addRepo.isPending}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => addRepo.mutate({ owner: r.owner, name: r.name })}
                      className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left disabled:opacity-60"
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
                    {/* Small, visually-subordinate link to open the repo on GitHub
                        in a new tab. stopPropagation keeps it from triggering the
                        row's add (belt-and-suspenders — it's a sibling, not nested). */}
                    <a
                      href={safeExternalUrl(r.url) ?? `https://github.com/${r.owner}/${r.name}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Open on GitHub"
                      aria-label={`Open ${r.fullName} on GitHub`}
                      className="flex shrink-0 items-center px-2 text-[10px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    >
                      ↗
                    </a>
                  </div>
                );
              })}
            </div>
          )}

          {!showSuggestions && (pageIdx > 0 || hasNextPage) && (
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
