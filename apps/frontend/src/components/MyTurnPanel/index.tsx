import { useMemo, useState } from 'react';
import { useMyTurn, useMe } from '../../hooks/useTriage.js';
import { indexUsers } from '../../lib/ui.js';
import { SummaryStats } from '../SummaryStats.js';
import { AwaitingReviewSection } from './AwaitingReviewSection.js';
import { YourPrsSection } from './YourPrsSection.js';
import { ThreadsAwaitingSection } from './ThreadsAwaitingSection.js';
import { DismissedSection } from './DismissedSection.js';

type Tab = 'todo' | 'done';

// The empty-detail-pane view: what needs you right now ("To do"), a "Done" tab of
// recently-completed items you can restore, then the window summary as context.
export function MyTurnPanel(): JSX.Element {
  const { data, isLoading } = useMyTurn();
  const { data: me } = useMe();
  const usersById = useMemo(() => indexUsers(data?.users), [data]);
  const [tab, setTab] = useState<Tab>('todo');

  const todoCount =
    (data?.awaitingReview.length ?? 0) +
    (data?.yourPrs.length ?? 0) +
    (data?.threadsAwaiting.length ?? 0);
  const empty = !data || todoCount === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 pt-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          My turn
        </h2>
        <div className="flex gap-1">
          {(['todo', 'done'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                tab === t
                  ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {t === 'todo' ? (
                <>To do{todoCount > 0 && <span className="ml-1 opacity-60">{todoCount}</span>}</>
              ) : (
                'Done'
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 pt-2">
        {tab === 'todo' ? (
          isLoading && !data ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : empty ? (
            <>
              <div className="text-sm text-gray-500">
                {me?.user
                  ? `Nothing needs you right now, ${me.user.login}. 🎉`
                  : 'Sign in with the gh CLI to see your triage queue.'}
              </div>
              <div className="mt-3">
                <SummaryStats />
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <AwaitingReviewSection
                items={data.awaitingReview}
                usersById={usersById}
              />
              <YourPrsSection items={data.yourPrs} usersById={usersById} />
              <ThreadsAwaitingSection
                items={data.threadsAwaiting}
                usersById={usersById}
              />
            </div>
          )
        ) : (
          <DismissedSection active={tab === 'done'} />
        )}
      </div>
    </div>
  );
}
