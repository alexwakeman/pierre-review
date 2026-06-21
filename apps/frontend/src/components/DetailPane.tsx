import { useDeferredValue } from 'react';
import { useFilters } from '../store/filters.js';
import { PrDetail } from './PrDetail.js';
import { MyTurnPanel } from './MyTurnPanel/index.js';
import { FeedPanel } from './FeedPanel.js';

// The bottom pane's content, by state (see store/filters.ts):
//  • a PR is selected      → its detail (PrDetail)
//  • else in My Turn focus → the My Turn inbox (To Do list, level 1)
//  • else (the default)    → the Feed home
// So a fresh load lands on the Feed; the My Turn panel only appears once you ENTER My
// Turn Focus Mode (the header pill / `m` / opening a To Do), never by default.
export function DetailPane(): JSX.Element {
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const selectedThreadId = useFilters((s) => s.selectedThreadId);
  const myTurnOnly = useFilters((s) => s.myTurnOnly);
  const clearSelection = useFilters((s) => s.clearSelection);

  // The ✕ and the timeline selection ring read `selectedPrId` urgently, so deselect
  // FEEDBACK is instant. The heavy panel body (unmount PrDetail → mount
  // FeedSection/MyTurnPanel) reads `bodyPrId`, which lags to null on deselect — so
  // that mount runs in a later, low-priority render instead of competing with the
  // ring teardown in the same frame. The `!= null` guard keeps SELECT/SWITCH
  // instant: only the swap-to-empty (deselect) is deferred.
  const deferredPrId = useDeferredValue(selectedPrId);
  const bodyPrId = selectedPrId != null ? selectedPrId : deferredPrId;

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

      {bodyPrId != null ? (
        <PrDetail
          key={bodyPrId}
          prId={bodyPrId}
          selectedThreadId={selectedThreadId}
        />
      ) : myTurnOnly ? (
        <MyTurnPanel />
      ) : (
        <FeedPanel />
      )}
    </div>
  );
}
