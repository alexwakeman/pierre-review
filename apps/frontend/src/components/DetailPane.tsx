import { useDeferredValue } from 'react';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs, parseTabKey } from '../store/pinnedTabs.js';
import { PrDetail } from './PrDetail.js';

// The bottom pane's content:
//  • a PR is selected → its detail (PrDetail)
//  • else             → a hint to pick a PR
// The old My Turn / Feed panels are gone: that state-of-play now lives in the Inbox
// tab's consolidated Feed, so the detail pane only opens when you click a PR.
export function DetailPane(): JSX.Element {
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

  return (
    <div className="relative h-full" data-testid="detail-pane">
      {selectedPrId != null && (
        <div className="absolute right-2 top-1.5 z-10 flex items-center gap-2">
          <button
            type="button"
            data-testid="detail-clear"
            onClick={clearSelection}
            className="rounded px-2 py-0.5 text-xs text-gray-400 hover:text-gray-600"
            title="Clear selection (Esc)"
          >
            ✕
          </button>
        </div>
      )}

      {showBody ? (
        <PrDetail
          key={bodyPrId}
          prId={bodyPrId as number}
          selectedThreadId={selectedThreadId}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-400">
          Select a PR on the timeline to see its details — your relevance-ranked state
          of play lives in the Inbox.
        </div>
      )}
    </div>
  );
}
