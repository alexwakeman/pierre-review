import { useFilters } from '../store/filters.js';
import { PrDetail } from './PrDetail.js';
import { MyTurnPanel } from './MyTurnPanel/index.js';
import { CountsPill } from './MyTurnPanel/CountsPill.js';

export function DetailPane(): JSX.Element {
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const selectedThreadId = useFilters((s) => s.selectedThreadId);
  const clearSelection = useFilters((s) => s.clearSelection);

  return (
    <div className="relative h-full">
      <div className="absolute right-2 top-1.5 z-10 flex items-center gap-2">
        <CountsPill />
        {selectedPrId != null && (
          <button
            type="button"
            onClick={clearSelection}
            className="rounded px-2 py-0.5 text-xs text-gray-400 hover:text-gray-600"
            title="Clear selection (Esc)"
          >
            ✕
          </button>
        )}
      </div>

      {selectedPrId == null ? (
        <MyTurnPanel />
      ) : (
        <PrDetail
          key={selectedPrId}
          prId={selectedPrId}
          selectedThreadId={selectedThreadId}
        />
      )}
    </div>
  );
}
