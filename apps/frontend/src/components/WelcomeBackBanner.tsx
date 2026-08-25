import { useState } from 'react';
import { useMe } from '../hooks/useTriage.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { useFilters } from '../store/filters.js';
import { relativeTime } from '../lib/ui.js';

// A dismissible "welcome back" banner shown when there are "My Turn" feed items you haven't
// seen yet. "Seen" is a SERVER-SIDE marker (accounts.feedLastSeenAt, bumped when you view the
// Activity Feed), surfaced via /api/me as `newFeedItems` — the successor to the removed
// per-item "Done". This makes the count consistent across devices/sessions (vs the old
// client-only localStorage heuristic), and it self-resets: viewing the feed marks it seen →
// newFeedItems drops to 0 → the banner disappears. My Turn is CORE / free, so this shows on
// every tier. Hidden while you're already on the Activity console.
export function WelcomeBackBanner(): JSX.Element | null {
  const { data: me } = useMe();
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const showActivity = usePinnedTabs((s) => s.showActivity);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const setFeedMyTurnOnly = useFilters((s) => s.setFeedMyTurnOnly);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !me?.user) return null;
  // Already in the Activity console → no nag (and it's being marked seen there anyway).
  if (activeTab === 'activity') return null;
  const n = me.newFeedItems ?? 0;
  if (n <= 0) return null;
  const since = me.feedLastSeenAt;

  // Open the Activity console's Feed, filtered to My Turn (the yellow-bordered items that
  // need you). Viewing it marks the feed seen server-side, resetting the count. (This used to
  // also call suppressInsightsDefault() — that one-shot "default to Insights" effect is gone:
  // the Feed IS the default landing for every tier now, brief strip on top.)
  const showFeed = (): void => {
    setActivityRepo('feed');
    setFeedMyTurnOnly(true);
    showActivity();
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
      <button
        type="button"
        onClick={showFeed}
        title="Show your feed"
        className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
      >
        <span className="font-medium">Welcome back</span>
        <span className="min-w-0 truncate text-amber-700/80 dark:text-amber-300/80">
          · {n} new item{n === 1 ? '' : 's'} in your feed
          {since ? ` since you were last here ${relativeTime(since)}` : ''}
        </span>
      </button>
      <button
        type="button"
        onClick={showFeed}
        className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
      >
        Show feed
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        className="shrink-0 rounded px-1 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
      >
        ✕
      </button>
    </div>
  );
}
