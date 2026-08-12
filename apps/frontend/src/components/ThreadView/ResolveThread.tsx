import { useResolveThread } from '../../hooks/usePrWrites.js';
import { ApiError } from '../../api/client.js';

// Resolve / Unresolve a review thread on GitHub, right-aligned in the ThreadCard
// header. Always shown — the API enforces real permission and surfaces a 502
// (GitHubError) if the viewer can't resolve, which we render as small inline red
// text next to the button.
export function ResolveThread({
  prId,
  threadId,
  isResolved,
}: {
  prId: number;
  threadId: number;
  isResolved: boolean;
}): JSX.Element {
  const resolve = useResolveThread();
  const error =
    resolve.error instanceof ApiError
      ? resolve.error.message
      : resolve.error
        ? 'Failed to update the thread.'
        : null;
  return (
    <span className="flex items-center gap-1.5">
      {error && <span className="text-[10px] text-red-500">{error}</span>}
      <button
        type="button"
        onClick={() => resolve.mutate({ prId, threadId, resolved: !isResolved })}
        disabled={resolve.isPending}
        title={
          isResolved
            ? 'Reopen this thread on GitHub'
            : 'Mark this thread resolved on GitHub'
        }
        className="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
      >
        {isResolved ? 'Unresolve' : 'Resolve'}
      </button>
    </span>
  );
}
