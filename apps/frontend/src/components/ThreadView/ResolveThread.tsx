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
      {error && <span className="text-meta text-ui-danger">{error}</span>}
      <button
        type="button"
        onClick={() => resolve.mutate({ prId, threadId, resolved: !isResolved })}
        disabled={resolve.isPending}
        title={
          isResolved
            ? 'Reopen this thread on GitHub'
            : 'Mark this thread resolved on GitHub'
        }
        className="inline-flex items-center rounded-ui bg-ui-raise px-1.5 py-0.5 text-meta font-semibold text-ui-mute hover:bg-ui-hover disabled:opacity-50 touch:h-10 touch:px-3"
      >
        {isResolved ? 'Unresolve' : 'Resolve'}
      </button>
    </span>
  );
}
