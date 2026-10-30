import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_REPOS_PER_ACCOUNT, type Repo, type RepoSearchResponse } from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useRepos } from '../hooks/useTimeline.js';
import { ACTIVITY_QUERY_KEYS } from '../hooks/useActivity.js';
import { safeExternalUrl } from '../lib/ui.js';
import { ChevronIcon, ExternalLinkIcon, StarIcon } from './Icons.js';
import {
  BOT_MONITORING_REPOS,
  SUGGESTED_REPOS,
  type CuratedRepo,
} from '../lib/suggestedRepos.js';
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
  // An add changes a workspace's membership (the repo lands in Default server-side): the
  // selector/manager rosters and every workspaceRepoIds() read must see it immediately.
  'workspaces',
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
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ui-faint text-meta font-semibold text-ui-ink">
      {login.slice(0, 2).toUpperCase()}
    </span>
  );
}

// Small inline spinner (matches the convention used in the Claude Review tab).
function Spinner(): JSX.Element {
  return (
    <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-ui-line border-t-ui-line" />
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
  // Focus the box on mount, which opens the curated suggestions (focus with an empty query shows
  // them). WorkspaceManager sets it for a zero-repo account, so a first-time reader sees repos to
  // try without having to find the box first.
  autoFocus = false,
}: {
  onAdded?: (repo: Repo) => void;
  placeholder?: string;
  autoFocus?: boolean;
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
  // The "Bot monitoring" demo repos go through the SAME added/justAdded filter.
  const botSuggestions = useMemo(
    () =>
      BOT_MONITORING_REPOS.filter(
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
  // Suggestions are ONE global index space in visual order — the Bot-monitoring
  // section first, then the general section — so data-idx / option ids / Enter all
  // stay globally sequential across both. Memoized so identity stays stable across
  // renders (two effects dep on navItems).
  const suggestionNav = useMemo(
    () => [...botSuggestions, ...suggestions],
    [botSuggestions, suggestions],
  );
  const navItems = showSuggestions ? suggestionNav : results;

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

  // One curated-suggestion row. `idx` is the GLOBAL nav index (bot section first,
  // then general) so it matches navItems / data-idx / `${listboxId}-opt-${idx}`.
  function renderSuggestionRow(s: CuratedRepo, idx: number): JSX.Element {
    const adding =
      addRepo.isPending &&
      addRepo.variables?.owner === s.owner &&
      addRepo.variables?.name === s.name;
    return (
      <div
        key={`${s.owner}/${s.name}`}
        className={`flex items-stretch ${
          idx === active ? 'bg-ui-raise' : ''
        } hover:bg-ui-hover`}
      >
        <button
          id={`${listboxId}-opt-${idx}`}
          data-idx={idx}
          type="button"
          role="option"
          aria-selected={idx === active}
          disabled={addRepo.isPending || atRepoLimit}
          onMouseEnter={() => setActive(idx)}
          onClick={() => addRepo.mutate({ owner: s.owner, name: s.name })}
          className="hit flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left disabled:opacity-60"
        >
          <OwnerAvatar login={s.owner} src={null} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                className="truncate text-meta font-medium text-ui-ink"
                title={`${s.owner}/${s.name}`}
              >
                {s.owner}/{s.name}
              </span>
              <span className="shrink-0 rounded-ui bg-ui-raise px-1 text-meta uppercase tracking-wide text-ui-mute">
                {s.category}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-2 text-meta text-ui-mute">
              {s.why}
            </span>
          </span>
          <span className="mt-0.5 shrink-0 rounded-ui bg-ui-accent-fill px-1.5 py-0.5 text-meta text-ui-on-accent">
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
          className="hit flex shrink-0 items-center px-2 text-meta text-ui-faint hover:text-ui-ink"
        >
          <ExternalLinkIcon size={12} />
        </a>
      </div>
    );
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
        autoFocus={autoFocus}
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
        className="w-44 rounded-ui border border-ui-line bg-transparent px-2 py-0.5 text-meta focus:border-ui-accent/50 focus:outline-none"
      />

      {panelOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Repository search results"
          className="absolute left-0 top-full z-[60] mt-1 max-h-96 w-96 overflow-y-auto rounded-ui border border-ui-line bg-ui-surface shadow-lg"
        >
          {atRepoLimit && (
            <div className="sticky top-0 z-20 border-b border-ui-line bg-ui-raise px-3 py-1.5 text-meta text-ui-warn">
              You&rsquo;ve added the maximum of {MAX_REPOS_PER_ACCOUNT} repos.
              Remove one to add another.
            </div>
          )}
          {showSuggestions ? (
            // listRef wraps BOTH sections so the arrow-key scrollIntoView lookup
            // (data-idx, one global index space) finds rows in either.
            <div ref={listRef}>
              {botSuggestions.length === 0 && suggestions.length === 0 ? (
                <div>
                  <div className="sticky top-0 z-10 border-b border-ui-line bg-ui-surface px-3 py-1.5 text-meta font-semibold uppercase tracking-wide text-ui-faint">
                    Suggested repos
                  </div>
                  <div className="px-3 py-2 text-meta text-ui-mute">
                    You&rsquo;ve already added all the suggestions.
                  </div>
                </div>
              ) : (
                <>
                  {botSuggestions.length > 0 && (
                    <div>
                      <div className="sticky top-0 z-10 border-b border-ui-line bg-ui-surface px-3 py-1.5">
                        <div className="text-meta font-semibold uppercase tracking-wide text-ui-faint">
                          Bot monitoring demos
                        </div>
                        <div className="mt-0.5 text-meta leading-snug text-ui-faint">
                          Several AI review bots are active in these — good for
                          exploring the Bots tab. First sync can take a few
                          minutes.
                        </div>
                      </div>
                      {botSuggestions.map((s, idx) => renderSuggestionRow(s, idx))}
                    </div>
                  )}
                  {suggestions.length > 0 && (
                    <div>
                      <div className="sticky top-0 z-10 border-b border-ui-line bg-ui-surface px-3 py-1.5 text-meta font-semibold uppercase tracking-wide text-ui-faint">
                        Suggested repos
                      </div>
                      {suggestions.map((s, idx) =>
                        // Offset by the bot section so the global index space
                        // matches visual order exactly.
                        renderSuggestionRow(s, botSuggestions.length + idx),
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : query.isError ? (
            <div className="px-3 py-2 text-meta text-ui-danger">
              {query.error instanceof ApiError
                ? query.error.message
                : 'Search failed'}
            </div>
          ) : searching && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-meta text-ui-mute">
              <Spinner />
              <span>Searching…</span>
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-meta text-ui-mute">
              No matching repositories.
            </div>
          ) : (
            <div ref={listRef}>
              {searching && (
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ui-line bg-white/95 px-3 py-1.5 text-meta text-ui-mute backdrop-blur">
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
                      idx === active ? 'bg-ui-raise' : ''
                    } hover:bg-ui-hover`}
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
                      className="hit flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left disabled:opacity-60"
                    >
                      <OwnerAvatar login={r.owner} src={r.ownerAvatarUrl} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="truncate text-meta font-medium text-ui-ink"
                            title={r.fullName}
                          >
                            {r.fullName}
                          </span>
                          {r.isPrivate && (
                            <span className="shrink-0 rounded-ui bg-ui-hover px-1 text-meta uppercase tracking-wide text-ui-mute">
                              private
                            </span>
                          )}
                          {r.isOwnedOrMember && (
                            <span className="shrink-0 rounded-ui bg-ui-sel px-1 text-meta uppercase tracking-wide text-ui-accent">
                              yours
                            </span>
                          )}
                        </span>
                        {r.description && (
                          <span className="mt-0.5 line-clamp-2 text-meta text-ui-mute">
                            {r.description}
                          </span>
                        )}
                        <span className="mt-0.5 flex items-center gap-2 text-meta text-ui-faint">
                          <span
                            className="flex items-center gap-1"
                            title={`${r.stargazerCount} stars`}
                          >
                            <StarIcon size={10} />
                            {compactNumber(r.stargazerCount)}
                          </span>
                          <span aria-hidden>·</span>
                          <span title={`${r.openPrCount} open pull requests`}>
                            {compactNumber(r.openPrCount)} open PR
                            {r.openPrCount === 1 ? '' : 's'}
                          </span>
                        </span>
                      </span>
                      <span className="mt-0.5 shrink-0 rounded-ui bg-ui-accent-fill px-1.5 py-0.5 text-meta text-ui-on-accent">
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
                      className="hit flex shrink-0 items-center px-2 text-meta text-ui-faint hover:text-ui-ink"
                    >
                      <ExternalLinkIcon size={12} />
                    </a>
                  </div>
                );
              })}
            </div>
          )}

          {!showSuggestions && (pageIdx > 0 || hasNextPage) && (
            <div className="sticky bottom-0 flex items-center justify-between border-t border-ui-line bg-ui-surface px-3 py-1.5 text-meta">
              <button
                type="button"
                onClick={gotoPrev}
                disabled={pageIdx === 0}
                className="hit flex items-center gap-1 text-ui-mute hover:text-ui-ink disabled:opacity-30"
              >
                <ChevronIcon dir="left" size={11} />
                Prev
              </button>
              <span className="text-ui-faint">Page {pageIdx + 1}</span>
              <button
                type="button"
                onClick={gotoNext}
                disabled={!hasNextPage}
                className="hit flex items-center gap-1 text-ui-mute hover:text-ui-ink disabled:opacity-30"
              >
                Next
                <ChevronIcon dir="right" size={11} />
              </button>
            </div>
          )}

          {addRepo.error && (
            <div className="border-t border-ui-line px-3 py-1.5 text-meta text-ui-danger">
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
