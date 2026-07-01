import { useEffect, useState } from 'react';
import { useMe } from '../hooks/useTriage.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { useFilters } from '../store/filters.js';
import { relativeTime } from '../lib/ui.js';

// A dismissible "welcome back" digest shown once per page load when you've been away
// a while and there's something waiting: it reads back how long since you were last
// active and the current My Turn summary, with a one-click way to show the My Turn
// board.
//
// "Last active" is heartbeated: while a tab is open and visible we re-stamp the
// timestamp (on mount, focus, tab-visible, and every minute), so a brief absence — or
// just keeping the app open in another tab — never reads back as a long one. The
// PREVIOUS value is captured exactly ONCE at module scope, before the first heartbeat
// write, so it reflects the last session (and survives StrictMode's double-mount).
const KEY = 'pierre:lastVisitAt';
const MIN_GAP_MS = 60 * 60 * 1000; // 1h — don't nag on quick reloads / same-session navigations
const HEARTBEAT_MS = 60 * 1000; // re-stamp last-active while the tab is visible

let capturedPrev: string | null | undefined;
function readPrevVisitOnce(): string | null {
  if (capturedPrev === undefined) {
    try {
      capturedPrev = localStorage.getItem(KEY);
    } catch {
      capturedPrev = null;
    }
  }
  return capturedPrev;
}

function markActive(): void {
  try {
    localStorage.setItem(KEY, new Date().toISOString());
  } catch {
    /* localStorage unavailable — banner just won't fire next time */
  }
}

export function WelcomeBackBanner(): JSX.Element | null {
  const prev = readPrevVisitOnce();
  const { data: me } = useMe();
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const showActivity = usePinnedTabs((s) => s.showActivity);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const setFeedMyTurnOnly = useFilters((s) => s.setFeedMyTurnOnly);
  const [dismissed, setDismissed] = useState(false);

  // Heartbeat the last-active timestamp. Runs regardless of whether the banner shows;
  // `prev` was already captured above (before the first write), so this drives the
  // NEXT session's banner, not this one.
  useEffect(() => {
    markActive();
    const onActive = (): void => {
      if (document.visibilityState === 'visible') markActive();
    };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);
    const timer = window.setInterval(onActive, HEARTBEAT_MS);
    return () => {
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
      window.clearInterval(timer);
    };
  }, []);

  if (dismissed || prev == null || !me?.user) return null;
  // Already in the Activity console → no nag.
  if (activeTab === 'activity') return null;
  const gap = Date.now() - Date.parse(prev);
  if (Number.isNaN(gap) || gap < MIN_GAP_MS) return null;

  const c = me.counts;
  const total =
    c.awaitingReview +
    c.yourPrsActivity +
    (c.approvedPrs ?? 0) +
    c.threadsAwaiting +
    c.watchedRepoPrs +
    c.claudeReviewsToAction;
  if (total === 0) return null;

  const parts: string[] = [];
  if (c.awaitingReview > 0) parts.push(`${c.awaitingReview} awaiting your review`);
  if (c.yourPrsActivity > 0) parts.push(`${c.yourPrsActivity} of your PRs active`);
  if (c.approvedPrs > 0)
    parts.push(`${c.approvedPrs} of your PRs approved`);
  if (c.threadsAwaiting > 0)
    parts.push(`${c.threadsAwaiting} thread${c.threadsAwaiting === 1 ? '' : 's'} awaiting you`);
  if (c.watchedRepoPrs > 0)
    parts.push(
      `${c.watchedRepoPrs} new PR${c.watchedRepoPrs === 1 ? '' : 's'} in watched repos`,
    );
  if (c.claudeReviewsToAction > 0)
    parts.push(
      `${c.claudeReviewsToAction} Claude review${c.claudeReviewsToAction === 1 ? '' : 's'} to action`,
    );

  // Open the Activity console's Feed, filtered to My Turn (the yellow-bordered items that
  // need you). The whole digest is clickable, plus the button.
  const showMyTurn = (): void => {
    setActivityRepo('feed');
    setFeedMyTurnOnly(true);
    showActivity();
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
      <button
        type="button"
        onClick={showMyTurn}
        title="Show My Turn"
        className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
      >
        <span className="font-medium">Welcome back</span>
        <span className="min-w-0 truncate text-amber-700/80 dark:text-amber-300/80">
          · last here {relativeTime(prev)} · {parts.join(' · ')}
        </span>
      </button>
      <button
        type="button"
        onClick={showMyTurn}
        className="shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
      >
        Show My Turn
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
