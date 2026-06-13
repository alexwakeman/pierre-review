import { useMe } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';

// Header "My Turn" button: a label + the queue sizes
// [awaiting review · your PRs · threads awaiting]. It toggles the timeline's
// "My Turn" isolate filter — turning it on collapses the board to just the PRs in
// your inbox and clears any PR selection, so you land on the isolated timeline
// with the My-Turn panel showing the list. Turning it off lifts the filter.
//
// Disabled while a PR-isolation focus overlay is up: My Turn is a board filter, and
// the focus lens treats the board as the layer beneath it (the FilterBar disables
// every other filter for the same reason). You leave focus — Esc / Back / the
// "Focus mode" pill — to change the board; exiting restores the (still My-Turn-
// filtered, if it was on) view, so nothing is lost by locking the toggle mid-focus.
export function CountsPill(): JSX.Element | null {
  const { data: me } = useMe();
  const myTurnOnly = useFilters((s) => s.myTurnOnly);
  const setMyTurnOnly = useFilters((s) => s.setMyTurnOnly);
  const clearSelection = useFilters((s) => s.clearSelection);
  const focusActive = useFilters((s) => s.focusActive);
  if (!me?.user) return null;

  const c = me.counts;
  return (
    <button
      type="button"
      disabled={focusActive}
      onClick={() => {
        const next = !myTurnOnly;
        setMyTurnOnly(next);
        if (next) clearSelection(); // land on the isolated board + the My-Turn panel
      }}
      aria-pressed={myTurnOnly}
      title={
        focusActive
          ? 'Leave focus mode (Esc / Back / the Focus-mode pill) to change the board'
          : 'My Turn — isolate the timeline to the PRs that need you now: awaiting your review · your PRs with activity · threads awaiting your response'
      }
      aria-label="Toggle the My Turn filter"
      className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
        myTurnOnly
          ? 'border-blue-400 text-blue-600 dark:border-blue-600 dark:text-blue-400'
          : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
      }`}
    >
      <span>My Turn</span>
      <span className="flex items-center gap-1 font-normal tabular-nums">
        <span className="text-blue-500">{c.awaitingReview}</span>
        <span className="text-gray-400">·</span>
        <span className="text-green-500">{c.yourPrsActivity}</span>
        <span className="text-gray-400">·</span>
        <span className="text-amber-500">{c.threadsAwaiting}</span>
      </span>
    </button>
  );
}
