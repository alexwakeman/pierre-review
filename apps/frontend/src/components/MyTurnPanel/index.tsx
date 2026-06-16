import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMyTurn, useMe } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { api } from '../../api/client.js';
import { indexUsers } from '../../lib/ui.js';
import { SummaryStats } from '../SummaryStats.js';
import { AwaitingReviewSection } from './AwaitingReviewSection.js';
import { YourPrsSection } from './YourPrsSection.js';
import { WatchedRepoPrsSection } from './WatchedRepoPrsSection.js';
import { ThreadsAwaitingSection } from './ThreadsAwaitingSection.js';
import { ClaudeReviewsToActionSection } from './ClaudeReviewsToActionSection.js';
import { DismissedSection } from './DismissedSection.js';

// The Feed lives in its own panel + header pill now (see FeedPanel); this panel is the
// My Turn inbox shown while in My Turn Focus Mode: what needs you ("To do"), a "Done" tab
// of recently-completed items you can restore, then the window summary as context.
type Tab = 'todo' | 'done' | 'summary';
const TABS: { id: Tab; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'done', label: 'Done' },
  { id: 'summary', label: 'Summary' },
];

// The empty-detail-pane view: what needs you right now ("To do"), a "Done" tab of
// recently-completed items you can restore, then the window summary as context.
export function MyTurnPanel(): JSX.Element {
  const { data, isLoading } = useMyTurn();
  const { data: me } = useMe();
  const usersById = useMemo(() => indexUsers(data?.users), [data]);
  const [tab, setTab] = useState<Tab>('todo');
  const repoIds = useFilters((s) => s.repoIds);
  const qc = useQueryClient();
  // Bulk "mark all seen": clears every open PR's new-since badge (scoped to the
  // active repo filter). Refresh the triage queue + feeds that show the badges.
  const markAll = useMutation({
    mutationFn: () => api.markAllViewed(repoIds ?? undefined),
    onSuccess: () => {
      for (const key of ['my-turn', 'me', 'open-prs', 'timeline']) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const todoCount =
    (data?.awaitingReview.length ?? 0) +
    (data?.yourPrs.length ?? 0) +
    (data?.watchedRepoPrs.length ?? 0) +
    (data?.threadsAwaiting.length ?? 0) +
    (data?.claudeReviewsToAction.length ?? 0);
  const empty = !data || todoCount === 0;

  return (
    <div className="flex h-full flex-col" data-testid="myturn-panel">
      <div className="flex items-center gap-3 px-4 pt-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          My turn
        </h2>
        <div className="flex gap-1">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                tab === id
                  ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {label}
              {id === 'todo' && todoCount > 0 && (
                <span className="ml-1 opacity-60">{todoCount}</span>
              )}
            </button>
          ))}
        </div>
        {me?.user && (
          <button
            type="button"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
            title="Mark every open PR seen — clears all new-since badges (respects the active repo filter)"
            className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:border-gray-400 hover:text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-500 dark:hover:text-gray-200"
          >
            {markAll.isPending ? 'Marking…' : 'Mark all seen'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 pt-2">
        {tab === 'todo' ? (
          isLoading && !data ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : empty ? (
            <div className="text-sm text-gray-500">
              {me?.user
                ? `Nothing needs you right now, ${me.user.login}. 🎉 Check the Feed pill for watched-repo activity, or the Summary tab for repo stats.`
                : 'Sign in with the gh CLI to see your triage queue.'}
            </div>
          ) : (
            <div className="space-y-4">
              <AwaitingReviewSection
                items={data.awaitingReview}
                usersById={usersById}
              />
              <YourPrsSection items={data.yourPrs} usersById={usersById} />
              <WatchedRepoPrsSection
                items={data.watchedRepoPrs}
                usersById={usersById}
              />
              <ThreadsAwaitingSection
                items={data.threadsAwaiting}
                usersById={usersById}
              />
              <ClaudeReviewsToActionSection items={data.claudeReviewsToAction} />
            </div>
          )
        ) : tab === 'done' ? (
          <DismissedSection active={tab === 'done'} />
        ) : (
          <SummaryStats />
        )}
      </div>
    </div>
  );
}
