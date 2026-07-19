import { useMemo } from 'react';
import type { BotOnlyPrItem, BotWindowKind, User } from '@pierre-review/shared';
import { useBotOnlyPrs } from '../../hooks/useBotTriage.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { indexUsers, userLabel } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';

// The bot-only-PRs DRILL-DOWN — a persistent, singleton tab opened by the amber "only a bot
// reviewed these" caption in BotsView. Lists the EXACT PR set behind the analytics
// `totals.botOnlyPrs` count (the dedicated route shares the analytics' window/scope
// resolution, so caption ≡ list). The count is a review-STATE snapshot — merged-in-window OR
// open-and-mergeable at any age, bot-touch judged over the PR's whole history — so rows may
// predate the feed window (the header says so). Clicking a PR opens its detail tab; "Show in
// feed" returns to the matching Bots rail entry with the PR isolated (bypasses the feed
// window); a Pierre-verbatim row has no bot-actor events, so it explains instead.

// The window picker options — kept in lockstep with BotRoiPanel's WINDOWS (same store field).
const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

function Row({
  pr,
  usersById,
  onOpen,
  onShowInFeed,
  isolated,
}: {
  pr: BotOnlyPrItem;
  usersById: Map<number, User>;
  onOpen: (pr: BotOnlyPrItem) => void;
  onShowInFeed: (pr: BotOnlyPrItem) => void;
  isolated: boolean;
}): JSX.Element {
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  return (
    <tr className="border-t border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-800/60 dark:hover:bg-gray-900/40">
      <td className="py-1.5 pr-3">
        {/* Two lines per PR: the repo/number pointer, then the title. */}
        <button
          type="button"
          onClick={() => onOpen(pr)}
          className="block max-w-md text-left hover:underline"
          title={`${pr.repoFullName} #${pr.number} — ${pr.title}`}
        >
          <span className="block truncate font-mono text-[11px] text-gray-400">
            {pr.repoFullName} #{pr.number}
          </span>
          <span className="block truncate text-sm font-medium text-gray-800 dark:text-gray-100">
            {pr.title}
          </span>
        </button>
      </td>
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
      <td className="py-1.5 pr-3">
        <a
          href={pr.githubUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[11px] text-gray-500 hover:underline dark:text-gray-400"
          title="Open on GitHub"
        >
          GitHub ↗
        </a>
      </td>
      <td className="py-1.5">
        {pr.viaPierreOnly ? (
          // A Pierre-verbatim review is posted with the HUMAN's token, so the PR has no
          // bot-ACTOR events — isolating it in the bot feed would show nothing. Explain
          // instead of offering a dead-end button.
          <span
            className="cursor-help rounded border border-amber-300/60 px-1.5 py-0.5 text-[10px] text-amber-500 dark:border-amber-700/50 dark:text-amber-400/70"
            title="This review was posted via Pierre with your token, so it has no bot activity to show in the bot feed — open it on GitHub instead."
          >
            via Pierre
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
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  // The repo the drill-down was opened from (per-repo Bots tab) — scopes the whole tab to that
  // repo; null (the cross-repo Bots rail) falls back to the team scope. Read (not consumed) so
  // the scope persists for the tab's lifetime; only reset when the next drill-down opens.
  const focusRepoId = useFilters((s) => s.botOnlyFocusRepoId);
  const repoScope = useMemo(() => (focusRepoId != null ? [focusRepoId] : null), [focusRepoId]);
  const { data, isLoading, isError, refetch, isFetching } = useBotOnlyPrs(
    window,
    true,
    scope,
    repoScope,
  );
  const prs = data?.prs ?? [];

  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const showActivity = usePinnedTabs((s) => s.showActivity);
  const setRepoConsoleTab = useFilters((s) => s.setRepoConsoleTab);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const setFeedIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const feedIsolatedPrId = useFilters((s) => s.feedIsolatedPrId);

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
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          Bot-only PRs
        </h2>
        <span className="text-[11px] text-gray-400">
          only a bot reviewed these — no human review or comment.{' '}
          {/* The snapshot invariant, tersely: review-state, not the feed event stream. */}
          <span className="text-amber-600 dark:text-amber-400">
            Counted by review state — may predate the window.
          </span>
        </span>
        {/* Window picker (shared with the Bot-ROI panel via botAnalyticsWindow). */}
        <div className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
          {WINDOWS.map((wOpt) => (
            <button
              key={wOpt.key}
              type="button"
              onClick={() => setWindow(wOpt.key)}
              className={`px-2 py-0.5 text-[11px] font-medium ${
                window === wOpt.key
                  ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
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
      ) : prs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No bot-only PRs in this window. 🎉
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                <th className="pb-1 pr-3 font-semibold">Pull request</th>
                <th className="pb-1 pr-3 font-semibold">Bot</th>
                <th className="pb-1 pr-3 font-semibold">State</th>
                <th className="pb-1 pr-3 font-semibold">Author</th>
                <th className="pb-1 pr-3 font-semibold">Link</th>
                <th className="pb-1 font-semibold" aria-label="Feed action" />
              </tr>
            </thead>
            <tbody>
              {prs.map((pr) => (
                <Row
                  key={pr.prId}
                  pr={pr}
                  usersById={usersById}
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
