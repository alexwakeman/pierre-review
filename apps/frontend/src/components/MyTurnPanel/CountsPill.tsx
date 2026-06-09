import { useMe } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';

// Header "My Turn" button: a label + the queue sizes
// [awaiting review · your PRs · threads awaiting]. Clicking it returns to the
// My-turn view (clears any PR selection).
export function CountsPill(): JSX.Element | null {
  const { data: me } = useMe();
  const clearSelection = useFilters((s) => s.clearSelection);
  const selectedPrId = useFilters((s) => s.selectedPrId);
  if (!me?.user) return null;

  const c = me.counts;
  const onMyTurn = selectedPrId == null;
  return (
    <button
      type="button"
      onClick={() => {
        if (selectedPrId != null) clearSelection();
      }}
      title="My Turn — awaiting your review · your PRs with activity · threads awaiting your response"
      aria-label="My Turn"
      className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold ${
        onMyTurn
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
