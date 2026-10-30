import { useDeferredValue } from 'react';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs, parseTabKey } from '../store/pinnedTabs.js';
import { PrDetail } from './PrDetail.js';
import { ChevronIcon, CloseIcon } from './Icons.js';
import { FOCUS_RING } from './ui/cx.js';

// The bottom pane's content — on a PR FOCUS tab only (App.tsx `paneVisible`; the shared board
// opens a PR as a popover, then its own tab — components/Timeline/PrPopover.tsx):
//  • a PR is selected → its detail (PrDetail)
//  • else             → a hint to pick a PR
// The old My Turn / Feed panels are gone: that state-of-play now lives in the Activity
// tab's consolidated Feed, so the detail pane only opens when you click a PR.
export function DetailPane({ sheet = false }: { sheet?: boolean } = {}): JSX.Element {
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const selectedThreadId = useFilters((s) => s.selectedThreadId);
  const clearSelection = useFilters((s) => s.clearSelection);

  // The ✕ and the timeline selection ring read `selectedPrId` urgently, so deselect
  // feedback is instant. The heavy panel body (unmount PrDetail) reads `bodyPrId`,
  // which lags to null on deselect — so the swap runs in a later, low-priority render
  // instead of competing with the ring teardown. The `!= null` guard keeps
  // SELECT/SWITCH instant: only the swap-to-empty (deselect) is deferred.
  const deferredPrId = useDeferredValue(selectedPrId);
  const bodyPrId = selectedPrId != null ? selectedPrId : deferredPrId;

  // When the SAME PR is shown full-screen in the pr-detail overlay, don't ALSO mount
  // it here (it would sit invisibly behind the overlay) — two PrDetail instances for one
  // PR would double the markViewed POST and let the hidden copy consume deep-link signals
  // meant for the visible one. A different tab renders normally.
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const activeDetail = parseTabKey(activeTab);
  const activeDetailPrId = activeDetail?.kind === 'pr-detail' ? activeDetail.prId : null;
  const showBody = bodyPrId != null && bodyPrId !== activeDetailPrId;

  // A PHONE (`sheet`, App.tsx): the pane is a full-screen sheet — Back, top left, is its way out
  // (it clears the selection, as Esc and the × do). The body scrolls under the bar.
  if (sheet) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="detail-pane">
        <div className="flex h-12 shrink-0 items-center gap-2 px-2">
          <button
            type="button"
            data-testid="detail-clear"
            onClick={clearSelection}
            aria-label="Clear selection (Esc)"
            className={`-ml-1 flex h-10 items-center gap-1 rounded-ui px-2 text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink ${FOCUS_RING}`}
          >
            <ChevronIcon dir="left" size={12} />
            Back
          </button>
          <span className="min-w-0 flex-1 truncate text-body text-ui-mute">Timeline</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {showBody && <PrDetail key={bodyPrId} prId={bodyPrId as number} selectedThreadId={selectedThreadId} placement="pane" />}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full" data-testid="detail-pane">
      {selectedPrId != null && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-2">
          <button
            type="button"
            data-testid="detail-clear"
            onClick={clearSelection}
            className={`flex h-8 w-8 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10 ${FOCUS_RING}`}
            aria-label="Clear selection (Esc)"
            title="Clear selection (Esc)"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {showBody ? (
        <PrDetail
          key={bodyPrId}
          prId={bodyPrId as number}
          selectedThreadId={selectedThreadId}
          placement="pane"
        />
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center text-body text-ui-mute">
          Select a PR on the timeline to see its details — your relevance-ranked state
          of play lives in the Activity.
        </div>
      )}
    </div>
  );
}
