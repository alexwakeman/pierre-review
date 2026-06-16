import { useFeedStore, selectNewCount } from '../store/feed.js';
import { FeedSection } from './MyTurnPanel/FeedSection.js';

// The default home panel (shown in the DetailPane when nothing is selected and you're
// not in My Turn Focus Mode): a reverse-chronological activity stream across your watched
// repos. Clicking an entry only navigates the MAIN timeline (FeedSection → showEventOnTimeline)
// — it never starts My Turn Focus Mode or any focus overlay. The new-item count lives on the
// header "Feed" pill; FeedSection marks the feed seen on mount, clearing that badge.
export function FeedPanel(): JSX.Element {
  const newCount = useFeedStore(selectNewCount);
  return (
    <div className="flex h-full flex-col" data-testid="feed-panel">
      <div className="flex items-center gap-3 px-4 pt-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Feed
        </h2>
        {newCount > 0 && (
          <span className="rounded bg-blue-500 px-1.5 text-[10px] font-semibold text-white">
            {newCount} new
          </span>
        )}
        <span className="text-[11px] text-gray-400">
          Activity across your watched repos · click to show on the timeline
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 pt-2">
        <FeedSection />
      </div>
    </div>
  );
}
