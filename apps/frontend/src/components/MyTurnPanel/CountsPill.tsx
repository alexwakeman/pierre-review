import { useMe } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';

// Header "My Turn" button: a label + the queue sizes
// [awaiting review · your PRs · threads awaiting]. The button SHOWS the My Turn
// panel: clicking it clears any selection so the DetailPane renders the panel (it
// shows only when nothing is selected). It is "active" whenever the panel is showing
// (nothing selected) — including on first load, and after re-clicking it while in My
// Turn Focus Mode to re-view the panel without leaving focus. You ENTER My Turn Focus
// Mode by opening an inbox entry, not via this pill; you LEAVE it via Esc / the
// FilterBar "My Turn focus" pill.
//
// Disabled only while a PR-isolation focus overlay is up (focusActive) — that lens
// owns the board, mirroring the FilterBar's other disabled controls.
export function CountsPill(): JSX.Element | null {
  const { data: me } = useMe();
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const clearSelection = useFilters((s) => s.clearSelection);
  const focusActive = useFilters((s) => s.focusActive);
  if (!me?.user) return null;

  const panelShowing = selectedPrId == null; // the pill's "active" state
  const c = me.counts;
  return (
    <button
      type="button"
      disabled={focusActive}
      // Show the My Turn panel (clear the selection). In home this is a no-op (the
      // panel already shows); in My Turn Focus Mode it re-shows the panel WITHOUT
      // leaving focus (the board stays isolated to the inbox).
      onClick={clearSelection}
      aria-pressed={panelShowing}
      title={
        focusActive
          ? 'Leave focus mode (Esc / Back / the Focus-mode pill) to change the board'
          : 'My Turn — your inbox: awaiting your review · your PRs with activity · threads awaiting your response. Open an entry to focus the board on it.'
      }
      aria-label="Show the My Turn panel"
      className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
        panelShowing
          ? 'border-blue-400 text-blue-600 dark:border-blue-600 dark:text-blue-400'
          : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
      }`}
    >
      <span>My Turn</span>
      <span className="flex items-center gap-1 font-normal tabular-nums">
        <span className="text-blue-500" title="Awaiting your review">
          {c.awaitingReview}
        </span>
        <span className="text-gray-400">·</span>
        <span className="text-green-500" title="Your PRs with new activity">
          {c.yourPrsActivity}
        </span>
        <span className="text-gray-400">·</span>
        <span className="text-amber-500" title="Threads awaiting you">
          {c.threadsAwaiting}
        </span>
        {c.claudeReviewsToAction > 0 && (
          <>
            <span className="text-gray-400">·</span>
            <span className="text-purple-500" title="Claude reviews to action">
              {c.claudeReviewsToAction}
            </span>
          </>
        )}
      </span>
    </button>
  );
}
