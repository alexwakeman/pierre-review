import { useFilters } from '../store/filters.js';
import { useFeedStore, selectNewCount } from '../store/feed.js';

// Header "Feed" button: shows the watched-repo activity Feed (the default home panel) and
// a badge with the count of entries new since you last viewed it. Clicking it returns to
// the Feed home — exitMyTurnFocus() un-isolates the board and clears any selection, so the
// Feed panel shows. It is "active" (aria-pressed) whenever the Feed is what's showing
// (no PR selected and not in My Turn Focus Mode).
//
// Disabled while a PR-isolation focus overlay is up (focusActive) — that lens owns the
// board, mirroring the "My Turn" pill and the FilterBar's disabled controls.
export function FeedPill(): JSX.Element {
  const myTurnOnly = useFilters((s) => s.myTurnOnly);
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const focusActive = useFilters((s) => s.focusActive);
  const exitMyTurnFocus = useFilters((s) => s.exitMyTurnFocus);
  const newCount = useFeedStore(selectNewCount);

  const feedShowing = !myTurnOnly && selectedPrId == null;
  return (
    <button
      type="button"
      data-testid="feed-pill"
      disabled={focusActive}
      onClick={exitMyTurnFocus}
      aria-pressed={feedShowing}
      title={
        focusActive
          ? 'Leave focus mode (Esc / Back / the Focus-mode pill) to change the board'
          : 'Feed — recent activity across your watched repos. New items since you last looked are badged.'
      }
      aria-label="Show the activity Feed"
      className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
        feedShowing
          ? 'border-blue-400 text-blue-600 dark:border-blue-600 dark:text-blue-400'
          : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
      }`}
    >
      <span>Feed</span>
      {newCount > 0 && (
        <span className="rounded bg-blue-500 px-1 text-[10px] font-semibold text-white tabular-nums">
          {newCount}
        </span>
      )}
    </button>
  );
}
