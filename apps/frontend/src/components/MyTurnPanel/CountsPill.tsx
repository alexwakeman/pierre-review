import { useMe } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';

// Header "My Turn" button: a label + the queue sizes
// [awaiting review · your PRs · threads awaiting · watched · claude]. Clicking it ENTERS
// My Turn Focus Mode — the timeline isolates to your inbox PRs (fitted to span them all)
// and the My Turn panel (To Do list) shows. It is "active" (aria-pressed) whenever that
// mode is on. Calling enterMyTurnFocus() repeatedly is safe: from a drilled-in To Do
// (level 2, a PR selected) it steps back to the To Do list (level 1); when already on the
// To Do list it's a no-op. Leave the mode via the FilterBar "My Turn focus" pill, the
// "Feed" pill, Esc, or the browser Back button.
//
// Disabled only while a PR-isolation focus overlay is up (focusActive) — that lens owns
// the board, mirroring the FilterBar's other disabled controls.
export function CountsPill(): JSX.Element | null {
  const { data: me } = useMe();
  const myTurnOnly = useFilters((s) => s.myTurnOnly);
  const enterMyTurnFocus = useFilters((s) => s.enterMyTurnFocus);
  const focusActive = useFilters((s) => s.focusActive);
  if (!me?.user) return null;

  const c = me.counts;
  return (
    <button
      type="button"
      data-testid="myturn-pill"
      disabled={focusActive}
      onClick={enterMyTurnFocus}
      aria-pressed={myTurnOnly}
      title={
        focusActive
          ? 'Leave focus mode (Esc / Back / the Focus-mode pill) to change the board'
          : 'My Turn — focus the board on your inbox: awaiting your review · your PRs with activity · threads awaiting your response. Esc / Back returns to the Feed.'
      }
      aria-label="Enter My Turn focus"
      className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
        myTurnOnly
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
        {c.approvedPrs > 0 && (
          <>
            <span className="text-gray-400">·</span>
            <span className="text-emerald-500" title="Your approved PRs (ready to merge)">
              {c.approvedPrs}
            </span>
          </>
        )}
        <span className="text-gray-400">·</span>
        <span className="text-amber-500" title="Threads awaiting you">
          {c.threadsAwaiting}
        </span>
        {c.watchedRepoPrs > 0 && (
          <>
            <span className="text-gray-400">·</span>
            <span className="text-sky-500" title="New PRs in watched repos">
              {c.watchedRepoPrs}
            </span>
          </>
        )}
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
