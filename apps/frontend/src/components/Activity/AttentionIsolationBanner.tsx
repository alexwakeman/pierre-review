import { useFilters } from '../../store/filters.js';
import { useAttentionCards } from '../../hooks/useAttentionCards.js';
import { useDailyBrief } from '../../hooks/useDailyBrief.js';
import { KIND_LABEL } from './AttentionCards.js';
import { myTurnCapDisclosure } from './AttentionView.js';

// The single-KIND isolation banner on the "Needs attention" board ("Showing only Your turn …").
// Modelled on FeedIsolationBanner: INLINE (it scrolls with the content — never fixed, never
// sticky, per the one-toast-column rule), dismissible with Clear, and null when nothing is
// isolated.
//
// Set from the daily brief's lines: each of those lines is ABOUT one card kind, so clicking
// "3 PRs stalled awaiting review" must land on those three cards, not on an undifferentiated
// board of everything. `setActivityRepo` clears the isolation on any rail switch — which is also
// why a brief line must switch the rail FIRST and isolate SECOND (see setAttentionIsolation).
//
// The count comes from the SAME `['attention-cards', ws:<id>]` query the board renders, so it is
// a cache hit rather than a second request, and the number here cannot disagree with the list
// below it. Bot cards are excluded there and can never be the isolated kind, so no filter is
// needed here beyond the kind test itself. (The my_turn CAP total is the one figure that does not
// live on that response — it rides the daily brief, through the shared rule below.)
export function AttentionIsolationBanner(): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const attentionIsolation = useFilters((s) => s.attentionIsolation);
  const setAttentionIsolation = useFilters((s) => s.setAttentionIsolation);
  const { data } = useAttentionCards(workspaceId);
  // Same source and same rule as the board header (myTurnCapDisclosure owns both) — the banner
  // and the count it sits above must never disagree about how many were left out.
  const { data: brief } = useDailyBrief(workspaceId);
  if (attentionIsolation == null) return null;
  const count = (data?.cards ?? []).filter((c) => c.kind === attentionIsolation).length;
  // Only `my_turn` discloses its cap: it is the one kind that is a personal worklist rather than
  // a survey. Every other kind is capped at 15 and has always been silent about it.
  const cap = attentionIsolation === 'my_turn' ? myTurnCapDisclosure(count, brief?.counts) : null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 shadow-sm dark:border-sky-500/50 dark:bg-sky-950/60 dark:text-sky-200">
      <span aria-hidden="true">☰</span>
      <span className="min-w-0 flex-1 truncate" title={cap?.title}>
        Showing only <span className="font-medium">{KIND_LABEL[attentionIsolation]}</span> —{' '}
        {cap != null ? (
          <>
            {cap.shown} of {cap.total} items
          </>
        ) : (
          <>
            {count} item{count === 1 ? '' : 's'}
          </>
        )}
      </span>
      <button
        type="button"
        onClick={() => setAttentionIsolation(null)}
        className="shrink-0 rounded border border-sky-400 px-2 py-0.5 font-medium hover:bg-sky-100 dark:border-sky-500/60 dark:hover:bg-sky-900/40"
      >
        Clear
      </button>
    </div>
  );
}
