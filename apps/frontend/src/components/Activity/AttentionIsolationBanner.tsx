import { useFilters } from '../../store/filters.js';
import { useAttentionCards } from '../../hooks/useAttentionCards.js';
import { useDailyBrief } from '../../hooks/useDailyBrief.js';
import { KIND_LABEL } from './AttentionCards.js';
import {
  myTurnCapDisclosure,
  myTurnPersonalCapDisclosure,
  passesPersonalLens,
} from './AttentionView.js';

// The isolation banner on the "Needs attention" board ("Showing only Your turn …"). Modelled on
// FeedIsolationBanner: INLINE (it scrolls with the content — never fixed, never sticky, per the
// one-toast-column rule), dismissible, and null when nothing is narrowed.
//
// It carries TWO INDEPENDENT NARROWINGS, each with its own way out:
//
//  • the single KIND (`attentionIsolation`), set from the daily brief's lines — each of those is
//    ABOUT one card kind, so clicking "3 PRs stalled awaiting review" must land on those three
//    cards, not on an undifferentiated board of everything;
//  • the PERSONAL lens (`attentionPersonalOnly`), set by the notification surfaces — the
//    welcome-back banner, the Workspace-dropdown badges and the brief's "Elsewhere" rows all
//    count `myTurnPersonal`, so their click has to open that same population.
//
// ⚠ THE PERSONAL LENS HIDES REAL WORK, so it may never be invisible. A reader who arrives from a
// banner reading 4 and finds a board of 4 while 50 cards exist must be told which 46 are being
// held back and be one click from them — that is what "Show everyone's" is for. (`setActivityRepo`
// clears both lenses on any rail switch, which is also why a brief line must switch the rail FIRST
// and narrow SECOND — see setAttentionIsolation.)
//
// The counts come from the SAME `['attention-cards', ws:<id>]` query the board renders, so they
// are a cache hit rather than a second request, and the number here cannot disagree with the list
// below it. Bot cards are excluded there and can never be the isolated kind, so no filter is
// needed here beyond the kind test itself. (The my_turn CAP total is the one figure that does not
// live on that response — it rides the daily brief, through the shared rule below.)
export function AttentionIsolationBanner(): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const attentionIsolation = useFilters((s) => s.attentionIsolation);
  const setAttentionIsolation = useFilters((s) => s.setAttentionIsolation);
  const attentionPersonalOnly = useFilters((s) => s.attentionPersonalOnly);
  const setAttentionPersonalOnly = useFilters((s) => s.setAttentionPersonalOnly);
  const { data } = useAttentionCards(workspaceId);
  // Same source and same rule as the board header (myTurnCapDisclosure owns both) — the banner
  // and the count it sits above must never disagree about how many were left out.
  const { data: brief } = useDailyBrief(workspaceId);
  if (attentionIsolation == null && !attentionPersonalOnly) return null;
  const all = data?.cards ?? [];
  // The SAME two-step the board does, in the same order: lens first, kind second.
  const lensed = attentionPersonalOnly ? all.filter(passesPersonalLens) : all;
  const count =
    attentionIsolation == null
      ? lensed.length
      : lensed.filter((c) => c.kind === attentionIsolation).length;
  // The number of cards this lens is holding back — never left implicit.
  const hiddenByLens = all.length - lensed.length;
  // Only `my_turn` discloses its cap: it is the one kind that is a personal worklist rather than
  // a survey. Every other kind is capped at 15 and has always been silent about it.
  // ⚠ Under the personal lens the count IS the personal subset, so it must be qualified by the
  // PERSONAL total — the broad one would mix two populations, and the rule's same-snapshot guard
  // would drop the disclosure altogether.
  const cap =
    attentionIsolation === 'my_turn'
      ? attentionPersonalOnly
        ? myTurnPersonalCapDisclosure(count, brief?.counts)
        : myTurnCapDisclosure(count, brief?.counts)
      : null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 shadow-sm dark:border-sky-500/50 dark:bg-sky-950/60 dark:text-sky-200">
      <span aria-hidden="true">☰</span>
      <span className="min-w-0 flex-1 truncate" title={cap?.title}>
        Showing only{' '}
        {attentionIsolation != null && (
          <>
            <span className="font-medium">{KIND_LABEL[attentionIsolation]}</span>
            {attentionPersonalOnly ? ' ' : ''}
          </>
        )}
        {attentionPersonalOnly && (
          <span className="font-medium">
            {attentionIsolation != null ? 'that personally involves you' : 'what personally involves you'}
          </span>
        )}{' '}
        —{' '}
        {cap != null ? (
          <>
            {cap.shown} of {cap.total} items
          </>
        ) : (
          <>
            {count} item{count === 1 ? '' : 's'}
          </>
        )}
        {/* The held-back count, stated plainly: those PRs do still need a review, and this lens
            is the only thing standing between the reader and them. */}
        {attentionPersonalOnly && hiddenByLens > 0 && (
          <span className="text-sky-700/80 dark:text-sky-300/80">
            {' '}
            · {hiddenByLens} more in repos you don’t maintain
          </span>
        )}
      </span>
      {attentionPersonalOnly && (
        <button
          type="button"
          onClick={() => setAttentionPersonalOnly(false)}
          title="Show every card on this board, including PRs in repos you only read"
          className="shrink-0 rounded border border-sky-400 px-2 py-0.5 font-medium hover:bg-sky-100 dark:border-sky-500/60 dark:hover:bg-sky-900/40"
        >
          Show everyone’s
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          setAttentionIsolation(null);
          setAttentionPersonalOnly(false);
        }}
        className="shrink-0 rounded border border-sky-400 px-2 py-0.5 font-medium hover:bg-sky-100 dark:border-sky-500/60 dark:hover:bg-sky-900/40"
      >
        Clear
      </button>
    </div>
  );
}
