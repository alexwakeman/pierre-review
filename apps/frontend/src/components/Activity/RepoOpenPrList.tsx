import { useCallback, useMemo } from 'react';
import type { Repo, TimelinePr, User } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { useRepoOpenPrsPanel } from '../../store/digestCollapse.js';
import {
  CI_META,
  REASON_META,
  indexUsers,
  mergeWarning,
  prNeedsAttention,
  relativeTime,
  sortOpenPrsByActivity,
  userLabel,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { NewTabIcon } from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';

// How many open-PR rows the inline lists show. Keeps a busy repo's list scannable — the sort
// floats maintainer + most-recently-active PRs onto the visible slice; the full, sortable
// list lives in the all-open-PRs drill-down tab (the "Show all" footer → onShowAll).
const OPEN_PRS_PAGE = 10;

// One open-PR row: CI dot · ⚠ needs-attention · #number title · author · draft / approval /
// merge chips · thread-state bar · my-turn reason or updated-time. Shared by the single-repo
// RepoOpenPrList and the Feed's team-grouped "open PRs" panel, so both read identically. The
// click action + selected highlight are injected (open a detail tab vs isolate the feed).
export function OpenPrRow({
  pr,
  author,
  onClick,
  onOpenTab,
  selected = false,
}: {
  pr: TimelinePr;
  author: User | undefined;
  onClick: () => void;
  // Open this PR in its own full-height pr-detail tab (the trailing ⧉ button). Distinct from
  // the row body's onClick, which filters the feed to this PR.
  onOpenTab: () => void;
  selected?: boolean;
}): JSX.Element {
  const ci = CI_META[pr.ciStatus];
  const reason = REASON_META[pr.reasonTag];
  const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
  const standing = pr.isApproved
    ? { label: 'approved', color: '#22c55e' }
    : pr.isChangesRequested
      ? { label: 'changes', color: '#ef4444' }
      : null;
  return (
    <li
      className={`flex items-stretch ${
        selected ? 'bg-sky-100 dark:bg-sky-900/40' : 'hover:bg-gray-50 dark:hover:bg-gray-800/40'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
      >
        {/* CI rollup dot (a hollow ring when there are no checks) */}
        <span
          aria-hidden="true"
          title={ci?.label ?? 'no checks'}
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={ci != null ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
        />
        {/* Item 1: the same ⚠ the rail shows next to attention-needing repos, now per-PR —
            flags the exact PRs driving that repo's attention count. */}
        {prNeedsAttention(pr) && (
          <span
            aria-hidden="true"
            title="Needs attention (your turn · stalled · untouched threads · CI / conflicts)"
            className="shrink-0 text-xs leading-none text-amber-500 dark:text-amber-400"
          >
            ⚠
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-gray-400">#{pr.number}</span>{' '}
          <span className="font-medium text-gray-700 dark:text-gray-200">{pr.title}</span>
        </span>
        {/* PR author — to the right of the title. */}
        <Avatar user={author} size={16} />
        <span
          className="max-w-[7rem] shrink-0 truncate text-gray-500 dark:text-gray-400"
          title={userLabel(author, pr.authorId)}
        >
          {userLabel(author, pr.authorId)}
        </span>

        {pr.isDraft && (
          <span className="shrink-0 rounded bg-gray-500/15 px-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
            draft
          </span>
        )}
        {standing != null && (
          <span
            className="shrink-0 rounded px-1 text-[10px] font-semibold"
            style={{ color: standing.color, background: standing.color + '1a' }}
          >
            {standing.label}
          </span>
        )}
        {warn != null && (
          <span className="shrink-0 rounded bg-orange-500/15 px-1 text-[10px] font-medium text-orange-600 dark:text-orange-400">
            {warn}
          </span>
        )}
        <ThreadStateBar counts={pr.threadCounts} compact />
        {reason.myTurn ? (
          <span
            className="hidden shrink-0 rounded px-1 text-[10px] font-medium sm:inline"
            style={{ color: reason.color, background: reason.color + '1a' }}
            title={userLabel(author, pr.authorId)}
          >
            {reason.label}
          </span>
        ) : (
          <span className="hidden shrink-0 text-[10px] text-gray-400 sm:inline">
            {relativeTime(pr.updatedAt)}
          </span>
        )}
      </button>
      {/* Trailing action: open this PR in its own full-height tab (its Show/Focus links then
          drive the timeline). Kept a SIBLING of the row button — not nested — so a click here
          opens the tab without also toggling the row's feed filter. */}
      <button
        type="button"
        onClick={onOpenTab}
        title={`Open #${pr.number} in its own tab`}
        aria-label={`Open PR #${pr.number} in its own tab`}
        className="flex shrink-0 items-center px-2.5 text-gray-400 hover:text-sky-600 dark:hover:text-sky-300"
      >
        <NewTabIcon size={14} />
      </button>
    </li>
  );
}

// A <ul> of the first OPEN_PRS_PAGE open-PR rows, shared by the per-repo list and the
// cross-repo Feed panel (one instance per team group). `prs` must ALREADY be sorted by the
// caller (sortOpenPrsByActivity). Anything beyond the first page lives in the all-open-PRs
// drill-down tab — the footer's "Show all N" calls `onShowAll` (the caller opens the tab with
// its own scope). Clicking a row isolates the feed to that PR (toggle). `keyPrefix` keeps
// React keys unique when the same PR appears under multiple team groups.
export function OpenPrRows({
  prs,
  usersById,
  keyPrefix = '',
  onShowAll,
}: {
  prs: TimelinePr[];
  usersById: Map<number, User>;
  keyPrefix?: string;
  // Open the sortable all-open-PRs drill-down for this list's scope (a repo | 'feed').
  onShowAll: () => void;
}): JSX.Element {
  const { data: repos } = useRepos();
  const isolatedPrId = useFilters((s) => s.feedIsolatedPrId);
  const setIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  const reposById = useMemo(() => {
    const m = new Map<number, Repo>();
    for (const r of repos ?? []) m.set(r.id, r);
    return m;
  }, [repos]);

  // Open the PR in its own pr-detail tab. Builds a TabMeta from the row's PR + resolved
  // repo/author (PrDetail.syncMeta backfills anything missing once the tab mounts).
  const openTab = useCallback(
    (pr: TimelinePr, author: User | undefined): void => {
      const meta: TabMeta = {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        repoFullName: reposById.get(pr.repoId)?.fullName ?? '',
        authorLogin: author?.githubLogin ?? null,
        authorDisplayName: author?.displayName ?? null,
        authorAvatarUrl: author?.avatarUrl ?? null,
      };
      openPrDetailTab(meta, { fromActivity: true });
    },
    [reposById, openPrDetailTab],
  );

  const shown = prs.slice(0, OPEN_PRS_PAGE);
  const remaining = prs.length - shown.length;

  return (
    <>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800/70">
        {shown.map((pr) => {
          const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
          return (
            <OpenPrRow
              key={`${keyPrefix}${pr.id}`}
              pr={pr}
              author={author}
              selected={isolatedPrId === pr.id}
              onClick={() => setIsolatedPrId(isolatedPrId === pr.id ? null : pr.id)}
              onOpenTab={() => openTab(pr, author)}
            />
          );
        })}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="flex w-full items-center justify-center gap-1 border-t border-gray-100 px-3 py-1.5 text-[11px] font-medium text-sky-600 hover:bg-gray-50 dark:border-gray-800/70 dark:text-sky-400 dark:hover:bg-gray-800/40"
        >
          Show all {prs.length} open PRs
          <span className="text-gray-400">· sortable</span>
        </button>
      )}
    </>
  );
}

// A compact, at-a-glance list of a repo's OPEN PRs, shown ABOVE the repo's activity feed.
// COLLAPSED BY DEFAULT (persisted, mirroring the cross-repo Feed panel) — the repo view
// opens on its feed with this list one click away. Ordered by sortOpenPrsByActivity
// (maintainer-authored first, then recency, then volume) and paginated (OpenPrRows).
// Clicking a PR ISOLATES the repo's feed to that PR (toggle: click the selected one again to
// clear), so this list doubles as the repo feed's per-PR filter.
export function RepoOpenPrList({
  repoId,
  prs,
}: {
  repoId: number;
  prs: TimelinePr[];
}): JSX.Element | null {
  const { data: users } = useUsers();
  const maintainersByRepo = useMaintainersByRepo();
  const collapsed = useRepoOpenPrsPanel((s) => s.collapsed);
  const toggleCollapsed = useRepoOpenPrsPanel((s) => s.toggle);
  const openOpenPrsDetail = useFilters((s) => s.openOpenPrsDetail);
  const usersById = useMemo(() => indexUsers(users), [users]);

  const sorted = useMemo(
    () =>
      sortOpenPrsByActivity(prs, (pr) => {
        const set = maintainersByRepo.get(pr.repoId);
        return pr.authorId != null && set != null && set.has(pr.authorId);
      }),
    [prs, maintainersByRepo],
  );

  if (prs.length === 0) return null;

  // "Open PRs" counts NON-DRAFT opens, matching the rail's [N] stat (repo.stats.openPrs =
  // non-draft), and drafts are called out separately — so the header reconciles with the rail
  // instead of contradicting it (the list itself still shows every open PR, drafts included).
  const draftCount = prs.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);
  const openCount = prs.length - draftCount;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/40"
      >
        <span aria-hidden="true" className="text-gray-400">
          {collapsed ? '▸' : '▾'}
        </span>
        Open PRs · {openCount}
        {draftCount > 0 && (
          <span className="font-normal normal-case text-gray-400">
            · {draftCount} draft{draftCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto font-normal normal-case text-gray-400">
          click a PR to filter the feed
        </span>
      </button>
      {!collapsed && (
        <div className="border-t border-gray-200 dark:border-gray-800">
          <OpenPrRows
            prs={sorted}
            usersById={usersById}
            onShowAll={() => openOpenPrsDetail(repoId)}
          />
        </div>
      )}
    </div>
  );
}
