import { useState } from 'react';
import { useMe } from '../hooks/useTriage.js';
import { useFilters } from '../store/filters.js';
import { relativeTime } from '../lib/ui.js';

// A dismissible "welcome back" digest shown once per page load when you've been away
// a while and there's something waiting: it reads back how long since your last visit
// and the current My Turn summary, with a one-click "Show My Turn" to isolate the
// board. The last-visit timestamp is captured + advanced exactly ONCE per load at
// module scope, so it survives StrictMode's double-mount (a useState initializer
// would re-read the just-written value on the second mount).
const KEY = 'pierre:lastVisitAt';
const MIN_GAP_MS = 60 * 60 * 1000; // 1h — don't nag on quick reloads / same-session navigations

let capturedPrev: string | null | undefined;
function readPrevVisitOnce(): string | null {
  if (capturedPrev === undefined) {
    try {
      capturedPrev = localStorage.getItem(KEY);
      localStorage.setItem(KEY, new Date().toISOString());
    } catch {
      capturedPrev = null;
    }
  }
  return capturedPrev;
}

export function WelcomeBackBanner(): JSX.Element | null {
  const prev = readPrevVisitOnce();
  const { data: me } = useMe();
  const setMyTurnOnly = useFilters((s) => s.setMyTurnOnly);
  const clearSelection = useFilters((s) => s.clearSelection);
  const myTurnOnly = useFilters((s) => s.myTurnOnly);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || prev == null || !me?.user) return null;
  // Already isolated to My Turn (e.g. restored from the URL) → the board already
  // shows this; no nag.
  if (myTurnOnly) return null;
  const gap = Date.now() - Date.parse(prev);
  if (Number.isNaN(gap) || gap < MIN_GAP_MS) return null;

  const c = me.counts;
  const total =
    c.awaitingReview + c.yourPrsActivity + c.threadsAwaiting + c.claudeReviewsToAction;
  if (total === 0) return null;

  const parts: string[] = [];
  if (c.awaitingReview > 0) parts.push(`${c.awaitingReview} awaiting your review`);
  if (c.yourPrsActivity > 0) parts.push(`${c.yourPrsActivity} of your PRs active`);
  if (c.threadsAwaiting > 0)
    parts.push(`${c.threadsAwaiting} thread${c.threadsAwaiting === 1 ? '' : 's'} awaiting you`);
  if (c.claudeReviewsToAction > 0)
    parts.push(
      `${c.claudeReviewsToAction} Claude review${c.claudeReviewsToAction === 1 ? '' : 's'} to action`,
    );

  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
      <span className="font-medium">Welcome back</span>
      <span className="min-w-0 truncate text-amber-700/80 dark:text-amber-300/80">
        · last here {relativeTime(prev)} · {parts.join(' · ')}
      </span>
      <button
        type="button"
        onClick={() => {
          setMyTurnOnly(true);
          clearSelection();
          setDismissed(true);
        }}
        className="ml-auto shrink-0 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
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
