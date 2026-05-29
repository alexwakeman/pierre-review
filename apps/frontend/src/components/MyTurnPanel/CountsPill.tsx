import { useMe } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';

// Always-visible queue size: [awaiting review · your PRs · threads awaiting].
// Clicking it returns to the My-turn view (clears any PR selection).
export function CountsPill(): JSX.Element | null {
  const { data: me } = useMe();
  const clearSelection = useFilters((s) => s.clearSelection);
  const selectedPrId = useFilters((s) => s.selectedPrId);
  if (!me?.user) return null;

  const c = me.counts;
  return (
    <button
      type="button"
      onClick={() => {
        if (selectedPrId != null) clearSelection();
      }}
      title="My turn: awaiting your review · your PRs with activity · threads awaiting your response"
      className="flex items-center gap-1 rounded-full border border-gray-300 px-2 py-0.5 text-xs tabular-nums hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
    >
      <span className="text-blue-500">{c.awaitingReview}</span>
      <span className="text-gray-400">·</span>
      <span className="text-green-500">{c.yourPrsActivity}</span>
      <span className="text-gray-400">·</span>
      <span className="text-amber-500">{c.threadsAwaiting}</span>
    </button>
  );
}
