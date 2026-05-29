import { useMemo } from 'react';
import { useMyTurn, useMe } from '../../hooks/useTriage.js';
import { indexUsers } from '../../lib/ui.js';
import { SummaryStats } from '../SummaryStats.js';
import { AwaitingReviewSection } from './AwaitingReviewSection.js';
import { YourPrsSection } from './YourPrsSection.js';
import { ThreadsAwaitingSection } from './ThreadsAwaitingSection.js';

// The empty-detail-pane view: what needs you right now, then the window
// summary underneath as context.
export function MyTurnPanel(): JSX.Element {
  const { data, isLoading } = useMyTurn();
  const { data: me } = useMe();
  const usersById = useMemo(() => indexUsers(data?.users), [data]);

  if (isLoading && !data) {
    return <div className="p-4 text-sm text-gray-500">Loading…</div>;
  }

  const empty =
    !data ||
    (data.awaitingReview.length === 0 &&
      data.yourPrs.length === 0 &&
      data.threadsAwaiting.length === 0);

  if (empty) {
    return (
      <div className="flex h-full flex-col">
        <div className="px-4 pt-3 text-sm text-gray-500">
          {me?.user
            ? `Nothing needs you right now, ${me.user.login}. 🎉`
            : 'Sign in with the gh CLI to see your triage queue.'}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <SummaryStats />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
        My turn
      </h2>
      <div className="space-y-4">
        <AwaitingReviewSection items={data.awaitingReview} usersById={usersById} />
        <YourPrsSection items={data.yourPrs} usersById={usersById} />
        <ThreadsAwaitingSection items={data.threadsAwaiting} usersById={usersById} />
      </div>
    </div>
  );
}
