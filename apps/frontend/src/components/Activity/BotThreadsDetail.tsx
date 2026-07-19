import { useMemo, useRef, useState } from 'react';
import type { CiStatus, ResolvableThreadPr, User } from '@pierre-review/shared';
import {
  useResolvableBotThreads,
  useScopeResolveBotThreads,
} from '../../hooks/useBotTriage.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { type TabMeta } from '../../store/pinnedTabs.js';
import { CI_META, indexUsers, relativeTime, userLabel } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { ThreadCountChips } from '../ThreadList/ThreadCountChips.js';
import { SortHeader, type SortState, compare, nextSort } from './sortableTable.js';

// The resolvable-bot-threads DRILL-DOWN — a persistent, singleton tab opened by the Bot-ROI
// backlog banner ("Review & resolve"). The scope-wide review-and-resolve flow. Every PR with ≥1
// `likely_addressed` automated-reviewer thread is a SORTABLE tabular row (author · CI · age ·
// last-update · a bot thread-state mix · its resolvable count), with the bulk resolve pinned to
// the TOP. PRs are DESELECTED by default; per-PR checkboxes + "Select all" (across all pages) /
// "Clear" drive the batch. Selecting all resolves the ENTIRE backlog (uncapped) — chunked into
// sequential POSTs with a Stop control. The server RE-DERIVES eligibility (the heuristic only
// LOOKS addressed — a later commit touched the file). Clicking a row opens that PR's Threads tab
// with the 'likely_addressed' pill preselected — inspect before resolving.

const PAGE_SIZE = 50;

type SortCol = 'pr' | 'repo' | 'author' | 'age' | 'updated' | 'ci' | 'resolvable';

const DEFAULT_DIR: Record<SortCol, 'asc' | 'desc'> = {
  pr: 'desc',
  repo: 'asc',
  author: 'asc',
  age: 'asc', // oldest-open first
  updated: 'desc', // most-recently-updated first
  ci: 'asc', // failing first
  resolvable: 'desc', // biggest backlog first
};

// CI rollup → a sortable rank (failing first under 'asc'); mirrors OpenPrsDetail.
const CI_RANK: Record<CiStatus, number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  expected: 3,
  unknown: 4,
};

function sortValue(pr: ResolvableThreadPr, col: SortCol, usersById: Map<number, User>): number | string {
  switch (col) {
    case 'pr':
      return pr.prNumber;
    case 'repo':
      return pr.repoFullName.toLowerCase();
    case 'author': {
      const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      return (u?.githubLogin ?? userLabel(u, pr.authorId)).toLowerCase();
    }
    case 'age':
      return pr.openedAt;
    case 'updated':
      return pr.updatedAt;
    case 'ci':
      return CI_RANK[pr.ciStatus];
    case 'resolvable':
      return pr.resolvableCount;
  }
}

export function BotThreadsDetail(): JSX.Element {
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  // The repo the tab was opened from (per-repo Bots tab) — scopes the whole tab to that repo;
  // null (the cross-repo Bots rail) falls back to the team scope. Read (not consumed) so the
  // scope persists for the tab's lifetime; only reset when the next drill-down opens.
  const focusRepoId = useFilters((s) => s.botThreadsFocusRepoId);
  const repoScope = useMemo(() => (focusRepoId != null ? [focusRepoId] : null), [focusRepoId]);
  const { data, isLoading, isError, refetch, isFetching } = useResolvableBotThreads(
    true,
    scope,
    repoScope,
  );
  const resolve = useScopeResolveBotThreads();
  const openPrThreadsFiltered = useFilters((s) => s.openPrThreadsFiltered);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);

  const prs = useMemo(() => data?.prs ?? [], [data]);
  const totalThreads = data?.totalThreads ?? 0;

  const [confirming, setConfirming] = useState(false);
  // Empty by default — PRs are DESELECTED until the reviewer picks or "Select all"s. Tracks
  // SELECTED pr ids; a stale id (a resolved PR that dropped out) just contributes no threads.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    resolved: number;
    failed: number;
  } | null>(null);
  // Set by the Stop button; the resolve hook checks it before each chunk (clean halt).
  const stopRef = useRef(false);

  // Cross-repo repo filter (opened from the cross-repo Bots rail). Built from the repos actually
  // present; not shown for a single-repo tab.
  const isCrossRepo = focusRepoId == null;
  const repoOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of prs) if (!m.has(p.repoId)) m.set(p.repoId, p.repoFullName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [prs]);
  const [repoFilter, setRepoFilter] = useState<number | 'all'>('all');
  const effectiveRepoFilter =
    repoFilter !== 'all' && repoOptions.some(([id]) => id === repoFilter) ? repoFilter : 'all';
  const showRepoCol = isCrossRepo && effectiveRepoFilter === 'all';

  const [sort, setSort] = useState<SortState<SortCol> | null>({ col: 'updated', dir: 'desc' });
  const onSort = (col: SortCol): void => setSort((cur) => nextSort(cur, col, DEFAULT_DIR));
  const [page, setPage] = useState(0);

  // Repo-filtered set (all pages) — the basis for sorting, pagination and "Select all".
  const filtered = useMemo(
    () =>
      effectiveRepoFilter === 'all' ? prs : prs.filter((p) => p.repoId === effectiveRepoFilter),
    [prs, effectiveRepoFilter],
  );
  const sorted = useMemo(() => {
    if (sort == null) return filtered;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort(
      (a, b) =>
        mul * compare(sortValue(a, sort.col, usersById), sortValue(b, sort.col, usersById)) ||
        b.prNumber - a.prNumber,
    );
  }, [filtered, sort, usersById]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Selection → the resolve set (the whole selected set, regardless of page/filter).
  const selectedPrs = useMemo(() => prs.filter((p) => selected.has(p.prId)), [prs, selected]);
  const selectedThreadIds = useMemo(
    () => selectedPrs.flatMap((p) => p.threadIds),
    [selectedPrs],
  );
  const selectedPrIds = useMemo(() => selectedPrs.map((p) => p.prId), [selectedPrs]);

  const toggleRow = (prId: number): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(prId)) next.delete(prId);
      else next.add(prId);
      return next;
    });
  // Select all = every PR in the current (repo-filtered) set, across all pages.
  const selectAll = (): void => setSelected(new Set(filtered.map((p) => p.prId)));
  const clearSelection = (): void => setSelected(new Set());
  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.prId));

  const openPr = (g: ResolvableThreadPr): void => {
    const author = g.authorId != null ? usersById.get(g.authorId) : undefined;
    const meta: TabMeta = {
      id: g.prId,
      number: g.prNumber,
      title: g.prTitle,
      repoFullName: g.repoFullName,
      authorLogin: author?.githubLogin ?? null,
      authorDisplayName: author?.displayName ?? null,
      authorAvatarUrl: author?.avatarUrl ?? null,
    };
    openPrThreadsFiltered(meta, 'likely_addressed');
  };

  const runResolve = (): void => {
    // NEVER send an empty threadIds list — [] means resolve-NOTHING by design server-side.
    if (selectedThreadIds.length === 0) return;
    stopRef.current = false;
    setProgress({ done: 0, total: selectedThreadIds.length, resolved: 0, failed: 0 });
    resolve.mutate(
      {
        threadIds: selectedThreadIds,
        repoIds: repoScope,
        prIds: selectedPrIds,
        onProgress: (done, total, resolved, failed) =>
          setProgress({ done, total, resolved, failed }),
        shouldStop: () => stopRef.current,
      },
      { onSettled: () => setConfirming(false) },
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden>🧹</span> Resolve bot threads
        </h2>
        <span className="text-[11px] text-gray-400">
          PRs with likely-addressed automated-reviewer threads — a later commit touched their
          file, so they only LOOK resolved. Review, then resolve on GitHub. Click a PR to inspect.
        </span>
        {/* Cross-repo repo filter (single-repo tabs omit it). */}
        {isCrossRepo && repoOptions.length > 1 && (
          <select
            value={effectiveRepoFilter}
            onChange={(e) => {
              setRepoFilter(e.target.value === 'all' ? 'all' : Number(e.target.value));
              setPage(0);
            }}
            className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-900"
            title="Filter by repo"
          >
            <option value="all">All repos ({repoOptions.length})</option>
            {repoOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          <span aria-hidden className={isFetching ? 'animate-spin' : ''}>
            ↻
          </span>{' '}
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
          ))}
        </div>
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load the resolvable threads.</div>
      ) : prs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No likely-addressed bot threads to review. 🎉
        </div>
      ) : (
        <>
          {/* TOP action bar — the bulk resolve pinned above the list. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 dark:border-gray-800 dark:bg-gray-900/40">
            {resolve.isPending && progress ? (
              <>
                <span className="text-[12px] text-gray-500 tabular-nums">
                  Resolving… {progress.done}/{progress.total} ({progress.resolved} resolved
                  {progress.failed > 0 ? `, ${progress.failed} failed` : ''})
                </span>
                <button
                  type="button"
                  onClick={() => {
                    stopRef.current = true;
                  }}
                  className="rounded border border-amber-400 px-2 py-1 text-[12px] font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-900/30"
                  title="Stop after the current batch finishes"
                >
                  Stop
                </button>
              </>
            ) : confirming ? (
              <>
                <span className="text-[12px] text-gray-600 dark:text-gray-300">
                  Resolve {selectedThreadIds.length} likely-addressed thread
                  {selectedThreadIds.length === 1 ? '' : 's'} across {selectedPrIds.length} PR
                  {selectedPrIds.length === 1 ? '' : 's'} on GitHub?
                </span>
                <button
                  type="button"
                  disabled={resolve.isPending || selectedThreadIds.length === 0}
                  onClick={runResolve}
                  className="rounded bg-green-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-green-700 disabled:opacity-60"
                >
                  Yes, resolve
                </button>
                <button
                  type="button"
                  disabled={resolve.isPending}
                  onClick={() => setConfirming(false)}
                  className="rounded px-2 py-1 text-[12px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={selectedThreadIds.length === 0}
                  onClick={() => setConfirming(true)}
                  className="rounded border border-sky-400 px-2.5 py-1 text-[12px] font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50 dark:border-sky-600 dark:text-sky-200 dark:hover:bg-sky-900/30"
                  title="These threads only LOOK addressed (a later commit touched their file) — you approve the batch before it resolves on GitHub."
                >
                  Resolve {selectedThreadIds.length} thread
                  {selectedThreadIds.length === 1 ? '' : 's'} across {selectedPrIds.length} PR
                  {selectedPrIds.length === 1 ? '' : 's'}
                </button>
                <button
                  type="button"
                  onClick={selectAll}
                  disabled={allSelected}
                  className="rounded border border-gray-300 px-2 py-1 text-[12px] font-medium text-gray-600 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
                  title="Select every PR in scope (across all pages)"
                >
                  Select all{effectiveRepoFilter === 'all' ? '' : ' (repo)'}
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={selected.size === 0}
                  className="rounded px-2 py-1 text-[12px] text-gray-500 hover:text-gray-700 disabled:opacity-40 dark:hover:text-gray-300"
                >
                  Clear
                </button>
              </>
            )}
            <span className="text-[11px] text-gray-400 tabular-nums">
              {selectedPrIds.length} of {filtered.length} PR{filtered.length === 1 ? '' : 's'}{' '}
              selected · {totalThreads} thread{totalThreads === 1 ? '' : 's'} in backlog
            </span>
            {!resolve.isPending &&
              resolve.data &&
              (resolve.data.resolved > 0 || resolve.data.failed > 0 || resolve.data.stopped) && (
                <span className="text-[11px] text-gray-500">
                  Resolved {resolve.data.resolved}
                  {resolve.data.failed > 0 && ` · ${resolve.data.failed} failed`}
                  {resolve.data.stopped && ' · stopped'}.
                </span>
              )}
            {resolve.isError && (
              <span className="text-[11px] text-red-500">
                {(resolve.error as Error)?.message ?? 'Couldn’t resolve.'}
              </span>
            )}
          </div>

          {/* Sortable per-PR table — a checkbox to include, then a clickable body opening the PR's
              Threads tab (likely-addressed pill preset). No per-thread enumeration. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  <th className="pb-1 pr-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => (allSelected ? clearSelection() : selectAll())}
                      title={allSelected ? 'Deselect all' : 'Select all (across pages)'}
                      className="h-3.5 w-3.5 cursor-pointer accent-sky-500"
                    />
                  </th>
                  <SortHeader col="pr" label="Pull request" sort={sort} onSort={onSort} />
                  {showRepoCol && <SortHeader col="repo" label="Repo" sort={sort} onSort={onSort} />}
                  <SortHeader col="author" label="Author" sort={sort} onSort={onSort} />
                  <SortHeader col="age" label="Age" sort={sort} onSort={onSort} title="Time since the PR opened" />
                  <SortHeader col="updated" label="Updated" sort={sort} onSort={onSort} />
                  <SortHeader col="ci" label="CI" sort={sort} onSort={onSort} />
                  <SortHeader col="resolvable" label="Resolvable" sort={sort} onSort={onSort} title="Likely-addressed bot threads this row resolves" />
                  <th className="pb-1 font-semibold">Bot threads</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((g) => {
                  const isSel = selected.has(g.prId);
                  const author = g.authorId != null ? usersById.get(g.authorId) : undefined;
                  const ci = CI_META[g.ciStatus];
                  return (
                    <tr
                      key={g.prId}
                      onClick={() => openPr(g)}
                      title="Open this PR's Threads tab (likely-addressed threads)"
                      className={`cursor-pointer border-t border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-800/60 dark:hover:bg-gray-900/40 ${
                        isSel ? 'bg-sky-50/60 dark:bg-sky-950/20' : ''
                      }`}
                    >
                      <td className="py-1.5 pr-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleRow(g.prId)}
                          title={isSel ? 'Exclude this PR' : 'Include this PR'}
                          className="h-3.5 w-3.5 cursor-pointer accent-sky-500"
                        />
                      </td>
                      <td className="max-w-md py-1.5 pr-3">
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-[11px] text-gray-400">#{g.prNumber}</span>
                          <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                            {g.prTitle}
                          </span>
                        </span>
                      </td>
                      {showRepoCol && (
                        <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
                          <span className="block max-w-[12rem] truncate font-mono">
                            {g.repoFullName}
                          </span>
                        </td>
                      )}
                      <td className="py-1.5 pr-3">
                        <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
                          <Avatar user={author} size={14} />
                          <span className="max-w-[8rem] truncate">
                            {userLabel(author, g.authorId)}
                          </span>
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
                        {relativeTime(g.openedAt)}
                      </td>
                      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
                        {relativeTime(g.updatedAt)}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-gray-500 dark:text-gray-400">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
                            aria-hidden
                          />
                          {ci?.label ?? 'no checks'}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className="rounded bg-sky-100 px-1.5 py-px text-[11px] font-semibold tabular-nums text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                          {g.resolvableCount}
                        </span>
                      </td>
                      <td className="py-1.5">
                        <ThreadCountChips counts={g.botThreadCounts} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Client-side pager (selection + "Select all" span every page). */}
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3 text-[11px] text-gray-500">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="rounded border border-gray-300 px-2 py-0.5 font-medium hover:border-gray-400 disabled:opacity-40 dark:border-gray-700"
              >
                ← Prev
              </button>
              <span className="tabular-nums">
                Page {safePage + 1} of {pageCount} · {sorted.length} PRs
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
                className="rounded border border-gray-300 px-2 py-0.5 font-medium hover:border-gray-400 disabled:opacity-40 dark:border-gray-700"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
