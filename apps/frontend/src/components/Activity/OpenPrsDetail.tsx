import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OpenPrsResponse, TimelinePr, User } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import { buildOpenPrsSearch, useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import {
  CI_META,
  indexUsers,
  relativeTime,
  sortOpenPrsByActivity,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { NewTabIcon } from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';

// The all-open-PRs DRILL-DOWN — a persistent, singleton tab opened by the "Show all N open
// PRs" footer under the Activity open-PR lists. Lists the scope's open PRs (the `openPrsScope`
// seed: one repo, or 'feed' = the FilterBar-visible scope) as a SORTABLE table — age, staleness,
// LoC, thread backlog, CI, approval — so a lead can order the open work however the question
// demands. Default order = sortOpenPrsByActivity (the same order the inline lists use).
// Clicking a row returns to the matching Feed rail entry with the PR isolated as the feed
// filter; the trailing ⧉ opens the PR's own detail tab.

type SortCol =
  | 'pr'
  | 'repo'
  | 'author'
  | 'age'
  | 'updated'
  | 'loc'
  | 'threads'
  | 'ci'
  | 'approval';

interface SortState {
  col: SortCol;
  dir: 'asc' | 'desc';
}

// Each column's "natural" first-click direction (a second click flips it): text columns read
// A→Z, time/size/backlog columns lead with the most pressing end (longest-open, most-recently
// -updated, biggest, most-untouched, failing-first, changes-first).
const DEFAULT_DIR: Record<SortCol, 'asc' | 'desc'> = {
  pr: 'desc',
  repo: 'asc',
  author: 'asc',
  age: 'asc',
  updated: 'desc',
  loc: 'desc',
  threads: 'desc',
  ci: 'asc',
  approval: 'asc',
};

// CI rollup → a sortable rank (failing first under 'asc').
const CI_RANK: Record<TimelinePr['ciStatus'], number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  expected: 3,
  unknown: 4,
};

// Approval standing → a sortable rank (changes-requested first under 'asc').
function approvalRank(pr: TimelinePr): number {
  if (pr.isChangesRequested) return 0;
  if (pr.isApproved) return 2;
  return 1;
}

// The per-column sort value. Strings compare via localeCompare below; ISO-8601 timestamps
// sort chronologically as strings (same trick as sortOpenPrsByActivity).
function sortValue(
  pr: TimelinePr,
  col: SortCol,
  usersById: Map<number, User>,
  repoNameById: Map<number, string>,
): number | string {
  switch (col) {
    case 'pr':
      return pr.number;
    case 'repo':
      return repoNameById.get(pr.repoId) ?? '';
    case 'author': {
      const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      return (u?.githubLogin ?? userLabel(u, pr.authorId)).toLowerCase();
    }
    case 'age':
      return pr.openedAt;
    case 'updated':
      return pr.updatedAt;
    case 'loc':
      return pr.additions + pr.deletions;
    case 'threads':
      return pr.threadCounts.untouched;
    case 'ci':
      return CI_RANK[pr.ciStatus];
    case 'approval':
      return approvalRank(pr);
  }
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return (a as number) - (b as number);
}

// A clickable column header: toggles asc/desc on the active column, or activates a new one
// with its natural direction. The ▲/▼ indicator only shows on the active column.
function SortHeader({
  col,
  label,
  sort,
  onSort,
  title,
}: {
  col: SortCol;
  label: string;
  sort: SortState | null;
  onSort: (col: SortCol) => void;
  title?: string;
}): JSX.Element {
  const dir = sort != null && sort.col === col ? sort.dir : null;
  return (
    <th
      className="pb-1 pr-3 font-semibold"
      aria-sort={dir != null ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        title={title}
        className={`inline-flex items-center gap-0.5 uppercase tracking-wide hover:text-gray-600 dark:hover:text-gray-300 ${
          dir != null ? 'text-gray-600 dark:text-gray-300' : ''
        }`}
      >
        {label}
        <span aria-hidden className={dir != null ? '' : 'invisible'}>
          {dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

function CiCell({ ci }: { ci: TimelinePr['ciStatus'] }): JSX.Element {
  const meta = CI_META[ci];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-gray-500 dark:text-gray-400">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={meta ? { background: meta.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
        aria-hidden
      />
      {meta?.label ?? 'no checks'}
    </span>
  );
}

function LocCell({ pr }: { pr: TimelinePr }): JSX.Element {
  return (
    <span className="whitespace-nowrap text-[11px]">
      <span className="text-gray-400">{pr.changedFiles}f</span>{' '}
      <span className="font-mono text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
      <span className="font-mono text-red-500 dark:text-red-400">−{pr.deletions}</span>
    </span>
  );
}

// Untouched-thread count + the compact 4-state mini-bar (the shared thread vocabulary).
function ThreadsCell({ pr }: { pr: TimelinePr }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] tabular-nums">
      <span
        className={
          pr.threadCounts.untouched > 0
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-gray-400'
        }
        title={`${pr.threadCounts.untouched} untouched thread${pr.threadCounts.untouched === 1 ? '' : 's'}`}
      >
        {pr.threadCounts.untouched}
      </span>
      <ThreadStateBar counts={pr.threadCounts} compact />
    </span>
  );
}

function ApprovalCell({ pr }: { pr: TimelinePr }): JSX.Element {
  const standing = pr.isApproved
    ? { label: 'approved', color: '#22c55e' }
    : pr.isChangesRequested
      ? { label: 'changes', color: '#ef4444' }
      : null;
  if (standing == null) return <span className="text-[11px] text-gray-300 dark:text-gray-600">—</span>;
  return (
    <span
      className="rounded px-1 text-[10px] font-semibold"
      style={{ color: standing.color, background: standing.color + '1a' }}
    >
      {standing.label}
    </span>
  );
}

export function OpenPrsDetail(): JSX.Element {
  // The scope seed — read (not consumed) for the tab's lifetime, like botPrsFocusRepoId. A
  // stale null (can't normally happen — the tab is ephemeral) falls back to the feed scope.
  const scope = useFilters((s) => s.openPrsScope);
  const repoScopeId = typeof scope === 'number' ? scope : null;
  // Member-AGNOSTIC fetch (Members is a Timeline-only filter — the Activity lists never
  // narrow by it): a repo scope fetches just that repo; 'feed' reuses the FilterBar-visible
  // repo scope (the same query string as useSearchOpenPrs → shared cache entry).
  const search = useFilters((s) =>
    repoScopeId != null ? `repoIds=${repoScopeId}` : buildOpenPrsSearch(s, false),
  );
  const { data, isLoading, isError, refetch, isFetching } = useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', search],
    queryFn: () => api.openPrs(search),
    placeholderData: (prev) => prev,
  });

  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const maintainersByRepo = useMaintainersByRepo();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(
    () => new Map((repos ?? []).map((r) => [r.id, r.fullName])),
    [repos],
  );

  const setRepoConsoleTab = useFilters((s) => s.setRepoConsoleTab);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const showActivity = usePinnedTabs((s) => s.showActivity);

  // null = the default activity order (sortOpenPrsByActivity — same as the inline lists).
  const [sort, setSort] = useState<SortState | null>(null);
  const onSort = (col: SortCol): void =>
    setSort((cur) =>
      cur?.col === col
        ? { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: DEFAULT_DIR[col] },
    );

  const prs = data?.prs ?? [];
  const rows = useMemo(() => {
    if (sort == null) {
      return sortOpenPrsByActivity(prs, (pr) => {
        const set = maintainersByRepo.get(pr.repoId);
        return pr.authorId != null && set != null && set.has(pr.authorId);
      });
    }
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...prs].sort(
      (a, b) =>
        mul *
          compare(
            sortValue(a, sort.col, usersById, repoNameById),
            sortValue(b, sort.col, usersById, repoNameById),
          ) || b.number - a.number, // stable final tiebreak
    );
  }, [prs, sort, maintainersByRepo, usersById, repoNameById]);

  // Row click → the matching Feed rail entry with this PR isolated as the feed filter.
  // ORDER IS LOAD-BEARING: setActivityRepo clears feedIsolatedPrId, so isolate AFTER it.
  const showInFeed = (pr: TimelinePr): void => {
    if (repoScopeId != null) {
      setRepoConsoleTab(repoScopeId, 'activity');
      setActivityRepo(repoScopeId);
    } else {
      setActivityRepo('feed');
    }
    setFeedIsolatedPrId(pr.id);
    showActivity();
  };

  const openTab = (pr: TimelinePr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    const meta: TabMeta = {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repoFullName: repoNameById.get(pr.repoId) ?? '',
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
    openPrDetailTab(meta, { fromActivity: true });
  };

  const scopeLabel =
    repoScopeId != null
      ? repoNameById.get(repoScopeId) ?? `repo ${repoScopeId}`
      : 'all visible repos';
  const draftCount = rows.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Open PRs</h2>
        <span className="text-[11px] text-gray-400">
          {scopeLabel} · {rows.length} open
          {draftCount > 0 && ` (${draftCount} draft${draftCount === 1 ? '' : 's'})`} · click a
          column to sort · click a row to filter its feed
        </span>
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
        <div className="text-sm text-red-500">Couldn’t load the open PRs.</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No open PRs in this scope. 🎉
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                <SortHeader col="pr" label="Pull request" sort={sort} onSort={onSort} />
                {repoScopeId == null && (
                  <SortHeader col="repo" label="Repo" sort={sort} onSort={onSort} />
                )}
                <SortHeader col="author" label="Author" sort={sort} onSort={onSort} />
                <SortHeader col="age" label="Age" sort={sort} onSort={onSort} title="Time since the PR opened" />
                <SortHeader col="updated" label="Updated" sort={sort} onSort={onSort} />
                <SortHeader col="loc" label="LoC" sort={sort} onSort={onSort} title="Diff size (added + deleted lines)" />
                <SortHeader col="threads" label="Threads" sort={sort} onSort={onSort} title="Untouched review threads + the state mix" />
                <SortHeader col="ci" label="CI" sort={sort} onSort={onSort} />
                <SortHeader col="approval" label="Approval" sort={sort} onSort={onSort} />
                <th className="pb-1 font-semibold" aria-label="Open in tab" />
              </tr>
            </thead>
            <tbody>
              {rows.map((pr) => {
                const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
                return (
                  <tr
                    key={pr.id}
                    onClick={() => showInFeed(pr)}
                    title="Show this PR isolated in its feed"
                    className="cursor-pointer border-t border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-800/60 dark:hover:bg-gray-900/40"
                  >
                    <td className="max-w-md py-1.5 pr-3">
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-gray-400">#{pr.number}</span>
                        <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                          {pr.title}
                        </span>
                        {pr.isDraft && (
                          <span className="shrink-0 rounded bg-gray-500/15 px-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
                            draft
                          </span>
                        )}
                      </span>
                    </td>
                    {repoScopeId == null && (
                      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
                        <span className="block max-w-[12rem] truncate">
                          {repoNameById.get(pr.repoId) ?? `repo ${pr.repoId}`}
                        </span>
                      </td>
                    )}
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
                        <Avatar user={author} size={14} />
                        <span className="max-w-[8rem] truncate">
                          {userLabel(author, pr.authorId)}
                        </span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
                      {relativeTime(pr.openedAt)}
                    </td>
                    <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
                      {relativeTime(pr.updatedAt)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <LocCell pr={pr} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <ThreadsCell pr={pr} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <CiCell ci={pr.ciStatus} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <ApprovalCell pr={pr} />
                    </td>
                    <td className="py-1.5">
                      {/* stopPropagation so the ⧉ opens the tab without also firing the
                          row's feed navigation. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openTab(pr);
                        }}
                        title={`Open #${pr.number} in its own tab`}
                        aria-label={`Open PR #${pr.number} in its own tab`}
                        className="flex items-center px-1 text-gray-400 hover:text-sky-600 dark:hover:text-sky-300"
                      >
                        <NewTabIcon size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
