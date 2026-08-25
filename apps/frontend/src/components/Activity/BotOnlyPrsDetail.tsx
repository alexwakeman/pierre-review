import { useMemo, useState } from 'react';
import type { BotOnlyPrItem, BotWindowKind, User } from '@pierre-review/shared';
import { useBotOnlyPrs } from '../../hooks/useBotTriage.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { indexUsers, relativeTime, userLabel } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { SortHeader, type SortState, compare, nextSort } from './sortableTable.js';

// The bot-only-PRs DRILL-DOWN — a persistent, singleton tab opened by the amber "only a bot
// reviewed these" caption in BotsView. Shows currently-OPEN bot-only PRs by DEFAULT (the
// actionable "needs a human before it merges" set — this matches the banner's `totals.botOnlyPrs`
// count, which is now open-only); a "Show merged" checkbox adds the merged-in-window rows the
// route also returns (client-side filter on `state`, so toggling is instant). A SORTABLE table
// (age, last-update, author, bot, state); the cross-repo tab adds a Repo column + a repo filter
// dropdown. Bot-touch is judged over the PR's whole history and open PRs are unwindowed, so rows
// may predate the feed window. Clicking a row opens its detail tab; "Show in feed" returns to the
// matching Bots rail entry with the PR isolated (bypasses the feed window); a Pierre-verbatim row
// has no bot-actor events, so it explains instead.

// The window picker options — kept in lockstep with BotRoiPanel's WINDOWS (same store field).
const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

type SortCol = 'pr' | 'repo' | 'bot' | 'state' | 'author' | 'age' | 'updated';

const DEFAULT_DIR: Record<SortCol, 'asc' | 'desc'> = {
  pr: 'desc',
  repo: 'asc',
  bot: 'asc',
  state: 'asc',
  author: 'asc',
  age: 'asc', // oldest-open first
  updated: 'desc', // most-recently-updated first
};

function sortValue(pr: BotOnlyPrItem, col: SortCol, usersById: Map<number, User>): number | string {
  switch (col) {
    case 'pr':
      return pr.number;
    case 'repo':
      return pr.repoFullName.toLowerCase();
    case 'bot':
      return pr.botLabel.toLowerCase();
    case 'state':
      return pr.state;
    case 'author': {
      const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
      return (u?.githubLogin ?? userLabel(u, pr.authorId)).toLowerCase();
    }
    case 'age':
      return pr.openedAt;
    case 'updated':
      return pr.updatedAt;
  }
}

function Row({
  pr,
  usersById,
  showRepo,
  onOpen,
  onShowInFeed,
  isolated,
}: {
  pr: BotOnlyPrItem;
  usersById: Map<number, User>;
  showRepo: boolean;
  onOpen: (pr: BotOnlyPrItem) => void;
  onShowInFeed: (pr: BotOnlyPrItem) => void;
  isolated: boolean;
}): JSX.Element {
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  return (
    <tr
      onClick={() => onOpen(pr)}
      title={`Open #${pr.number} in its own tab`}
      className="cursor-pointer border-t border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-800/60 dark:hover:bg-gray-900/40"
    >
      <td className="max-w-md py-1.5 pr-3">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-gray-400">#{pr.number}</span>
          <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
            {pr.title}
          </span>
        </span>
      </td>
      {showRepo && (
        <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="block max-w-[12rem] truncate font-mono">{pr.repoFullName}</span>
        </td>
      )}
      <td className="py-1.5 pr-3">
        <span className="rounded border border-amber-300 bg-amber-100/70 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-300">
          🤖 {pr.botLabel}
        </span>
      </td>
      <td className="py-1.5 pr-3 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {pr.state}
      </td>
      <td className="py-1.5 pr-3">
        <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
          <Avatar user={author} size={14} />
          <span className="max-w-[8rem] truncate">{userLabel(author, pr.authorId)}</span>
        </span>
      </td>
      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
        {relativeTime(pr.openedAt)}
      </td>
      <td className="py-1.5 pr-3 text-[11px] text-gray-500 dark:text-gray-400">
        {relativeTime(pr.updatedAt)}
      </td>
      <td className="py-1.5 pr-3">
        <a
          href={pr.githubUrl}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className="text-[11px] text-gray-500 hover:underline dark:text-gray-400"
          title="Open on GitHub"
        >
          GitHub ↗
        </a>
      </td>
      <td className="py-1.5" onClick={(e) => e.stopPropagation()}>
        {pr.viaPierreOnly ? (
          // A Pierre-verbatim review is posted with the HUMAN's token, so the PR has no
          // bot-ACTOR events — isolating it in the bot feed would show nothing. Explain
          // instead of offering a dead-end button.
          <span
            className="cursor-help rounded border border-amber-300/60 px-1.5 py-0.5 text-[10px] text-amber-500 dark:border-amber-700/50 dark:text-amber-400/70"
            title="This review was posted via Limn with your token, so it has no bot activity to show in the bot feed — open it on GitHub instead."
          >
            via Limn
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onShowInFeed(pr)}
            aria-pressed={isolated}
            className="rounded border border-amber-400 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-600/70 dark:text-amber-300 dark:hover:bg-amber-900/30"
            title="Return to the Bots console with this PR isolated in the bot feed (bypasses the feed window)"
          >
            Show in feed
          </button>
        )}
      </td>
    </tr>
  );
}

export function BotOnlyPrsDetail(): JSX.Element {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  // The ACTIVE WORKSPACE decides which reviewers are automated — i.e. which PRs are "bot-only" —
  // and it is the same id the banner's count was computed at, so caption ≡ list.
  const workspaceId = useFilters((s) => s.workspaceId);
  // The repo the drill-down was opened from (per-repo Bots tab) — narrows the tab's DATA to that
  // repo; null (the cross-repo Bots rail) lists the whole workspace. Read (not consumed) so it
  // persists for the tab's lifetime; only reset when the next drill-down opens.
  const focusRepoId = useFilters((s) => s.botOnlyFocusRepoId);
  const repoScope = useMemo(() => (focusRepoId != null ? [focusRepoId] : null), [focusRepoId]);
  const { data, isLoading, isError, refetch, isFetching } = useBotOnlyPrs(
    workspaceId,
    window,
    true,
    repoScope,
  );
  const prs = useMemo(() => data?.prs ?? [], [data]);

  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const showActivity = usePinnedTabs((s) => s.showActivity);
  const setRepoConsoleTab = useFilters((s) => s.setRepoConsoleTab);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const feedIsolatedPrId = useFilters((s) => s.feedIsolatedPrId);

  // Cross-repo repo filter (the drill-down opened from the cross-repo Bots rail). Built from the
  // distinct repos actually present in the result; not shown for a single-repo tab.
  const isCrossRepo = focusRepoId == null;
  const repoOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of prs) if (!m.has(p.repoId)) m.set(p.repoId, p.repoFullName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [prs]);
  const [repoFilter, setRepoFilter] = useState<number | 'all'>('all');
  // A repo that dropped out of the result (window flip) falls back to 'all'.
  const effectiveRepoFilter = repoFilter !== 'all' && repoOptions.some(([id]) => id === repoFilter)
    ? repoFilter
    : 'all';
  const showRepoCol = isCrossRepo && effectiveRepoFilter === 'all';

  const [sort, setSort] = useState<SortState<SortCol> | null>({ col: 'updated', dir: 'desc' });
  const onSort = (col: SortCol): void => setSort((cur) => nextSort(cur, col, DEFAULT_DIR));
  // OPEN PRs by default — the actionable "needs a human before it merges" set, matching the
  // banner count. "Show merged" adds the merged-in-window rows (already shipped) the route
  // also returns; the split is client-side on `state`, so toggling is instant (no refetch).
  const [showMerged, setShowMerged] = useState(false);

  // Repo-filtered set (BEFORE the open/merged split) — the basis for the open/merged counts.
  const repoFiltered = useMemo(
    () => (effectiveRepoFilter === 'all' ? prs : prs.filter((p) => p.repoId === effectiveRepoFilter)),
    [prs, effectiveRepoFilter],
  );
  const openCount = useMemo(
    () => repoFiltered.filter((p) => p.state === 'open').length,
    [repoFiltered],
  );
  const mergedCount = useMemo(
    () => repoFiltered.filter((p) => p.state === 'merged').length,
    [repoFiltered],
  );

  const rows = useMemo(() => {
    const filtered = showMerged ? repoFiltered : repoFiltered.filter((p) => p.state === 'open');
    if (sort == null) return filtered;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort(
      (a, b) =>
        mul * compare(sortValue(a, sort.col, usersById), sortValue(b, sort.col, usersById)) ||
        b.number - a.number,
    );
  }, [repoFiltered, showMerged, sort, usersById]);

  const openPr = (pr: BotOnlyPrItem): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    const meta: TabMeta = {
      id: pr.prId,
      number: pr.number,
      title: pr.title,
      repoFullName: pr.repoFullName,
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
    openPrDetailTab(meta, { fromActivity: true });
  };

  // Return to the matching Bots rail entry with this PR isolated in the bot feed. ORDER IS
  // LOAD-BEARING: setActivityRepo clears feedIsolatedPrId, so isolate AFTER the rail move.
  const showInFeed = (pr: BotOnlyPrItem): void => {
    if (focusRepoId != null) {
      setRepoConsoleTab(focusRepoId, 'bots');
      setActivityRepo(focusRepoId);
    } else {
      setActivityRepo('bots');
    }
    setFeedIsolatedPrId(pr.prId);
    showActivity();
  };

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Bot-only PRs</h2>
        <span className="text-[11px] text-gray-400">
          only a bot reviewed these — no human review or comment.{' '}
          <span className="text-amber-600 dark:text-amber-400">
            {showMerged ? `${openCount} open · ${mergedCount} merged` : `${openCount} open`}
          </span>{' '}
          · click a column to sort · click a row to open it
        </span>
        {/* Cross-repo repo filter — narrows the list to one repo (single-repo tabs omit it). */}
        {isCrossRepo && repoOptions.length > 1 && (
          <select
            value={effectiveRepoFilter}
            onChange={(e) =>
              setRepoFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
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
        {/* Show-merged toggle — OPEN bot-only PRs show by default (the actionable set, matching
            the banner); ticking adds the merged-in-window rows (already shipped). */}
        <label
          className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400"
          title="Also show bot-only PRs that already merged in this window — open PRs are the actionable set"
        >
          <input
            type="checkbox"
            checked={showMerged}
            onChange={(e) => setShowMerged(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-ai-signal"
          />
          Show merged{mergedCount > 0 ? ` (${mergedCount})` : ''}
        </label>
        {/* Window picker (shared with the Bot-ROI panel via botAnalyticsWindow). */}
        <div className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
          {WINDOWS.map((wOpt) => (
            <button
              key={wOpt.key}
              type="button"
              onClick={() => setWindow(wOpt.key)}
              className={`px-2 py-0.5 text-[11px] font-medium ${
                window === wOpt.key
                  ? 'bg-ai-signal/15 text-ai-signal'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {wOpt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
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
        <div className="text-sm text-red-500">Couldn’t load the PR list.</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          {!showMerged && mergedCount > 0
            ? `No open bot-only PRs — ${mergedCount} merged in this window. Tick “Show merged” to see them.`
            : 'No bot-only PRs in this window. 🎉'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                <SortHeader col="pr" label="Pull request" sort={sort} onSort={onSort} />
                {showRepoCol && <SortHeader col="repo" label="Repo" sort={sort} onSort={onSort} />}
                <SortHeader col="bot" label="Bot" sort={sort} onSort={onSort} />
                <SortHeader col="state" label="State" sort={sort} onSort={onSort} />
                <SortHeader col="author" label="Author" sort={sort} onSort={onSort} />
                <SortHeader col="age" label="Age" sort={sort} onSort={onSort} title="Time since the PR opened" />
                <SortHeader col="updated" label="Updated" sort={sort} onSort={onSort} />
                <th className="pb-1 pr-3 font-semibold">Link</th>
                <th className="pb-1 font-semibold" aria-label="Feed action" />
              </tr>
            </thead>
            <tbody>
              {rows.map((pr) => (
                <Row
                  key={pr.prId}
                  pr={pr}
                  usersById={usersById}
                  showRepo={showRepoCol}
                  onOpen={openPr}
                  onShowInFeed={showInFeed}
                  isolated={feedIsolatedPrId === pr.prId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
