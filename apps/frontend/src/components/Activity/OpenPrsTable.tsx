import { useMemo, useState, type ReactNode } from 'react';
import type { TimelinePr, User } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import {
  CI_META,
  indexUsers,
  relativeTime,
  sortOpenPrsByActivity,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { CheckCircleIcon } from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { SortHeader, type SortState, compare, nextSort } from './sortableTable.js';

// THE open-PR table — the ONE component every open-PR list surface renders (the OpenPrsDetail
// drill-down, whether opened per-repo from a "Show all" footer or workspace-wide from the Flow
// metrics "Open PRs" tile). Sortable columns — age, staleness, LoC, thread backlog, CI,
// approval — over TimelinePr rows from /api/open-prs; drafts are included (marked with a badge).
// Owns its sort state; default order = sortOpenPrsByActivity (the same order the inline lists
// use). Rows are WHOLE-ROW clickable — the caller decides what a click opens (onOpenPr).

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
      // Sort by what the CELL SHOWS — userLabel's display-name-then-login answer. Sorting on
      // the raw login while rendering the display name made the column look broken: "Alex
      // Wakeman" sorts under 'a' by login, so an A→Z click left the visible names unordered.
      return userLabel(u, pr.authorId).toLowerCase();
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

export function OpenPrsTable({
  prs,
  isLoading,
  isError,
  showRepoColumn,
  onOpenPr,
  emptyLabel = (
    <>
      <CheckCircleIcon className="mr-1.5 inline-block align-[-0.15em] text-gray-300 dark:text-gray-600" />
      No open PRs here.
    </>
  ),
}: {
  prs: TimelinePr[];
  isLoading: boolean;
  isError: boolean;
  showRepoColumn: boolean;
  onOpenPr: (pr: TimelinePr) => void;
  // The zero-row copy — overridden when a client-side narrowing (not the data) emptied the list.
  // ReactNode, not string: the DEFAULT is the all-clear state and leads with a muted tick, while
  // an override ("adjust the repo filter") is plain prose that must NOT wear one.
  emptyLabel?: ReactNode;
}): JSX.Element {
  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const maintainersByRepo = useMaintainersByRepo();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(
    () => new Map((repos ?? []).map((r) => [r.id, r.fullName])),
    [repos],
  );

  // null = the default activity order (sortOpenPrsByActivity — same as the inline lists).
  const [sort, setSort] = useState<SortState<SortCol> | null>(null);
  const onSort = (col: SortCol): void => setSort((cur) => nextSort(cur, col, DEFAULT_DIR));

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

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
        ))}
      </div>
    );
  }
  if (isError) {
    return <div className="text-sm text-red-500">Couldn’t load the open PRs.</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            <SortHeader col="pr" label="Pull request" sort={sort} onSort={onSort} />
            {showRepoColumn && (
              <SortHeader col="repo" label="Repo" sort={sort} onSort={onSort} />
            )}
            <SortHeader col="author" label="Author" sort={sort} onSort={onSort} />
            <SortHeader col="age" label="Age" sort={sort} onSort={onSort} title="Time since the PR opened" />
            <SortHeader col="updated" label="Updated" sort={sort} onSort={onSort} />
            <SortHeader col="loc" label="LoC" sort={sort} onSort={onSort} title="Diff size (added + deleted lines)" />
            <SortHeader col="threads" label="Threads" sort={sort} onSort={onSort} title="Untouched review threads + the state mix" />
            <SortHeader col="ci" label="CI" sort={sort} onSort={onSort} />
            <SortHeader col="approval" label="Approval" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((pr) => {
            const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
            return (
              <tr
                key={pr.id}
                onClick={() => onOpenPr(pr)}
                title={`Open #${pr.number} in its own tab`}
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
                {showRepoColumn && (
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
