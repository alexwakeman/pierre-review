import { useReopenPr } from '../hooks/usePrWrites.js';
import { ApiError } from '../api/client.js';
import { ReopenIcon } from './Icons.js';

// Reopen control for the Overview "Actions" row (CORE / free tier), rendered when the viewer may
// reopen the PR (pr.viewerCanReopen — write access OR the PR author) and it is CLOSED and
// unmerged. No confirm step, unlike ClosePrControl: reopening is the undo of a close and is
// itself undone by the Close button beside it, so a two-click gate would be ceremony around a
// reversible act. The server re-checks permission + closed-state (403/409) and, when GitHub
// refuses — almost always because the head branch was deleted after the close — sends the
// sentence GitHub gave, which is what this prints.
export function ReopenPrControl({ prId }: { prId: number }): JSX.Element {
  const reopen = useReopenPr(prId);

  const error =
    reopen.error instanceof ApiError
      ? reopen.error.message
      : reopen.error
        ? 'Couldn’t reopen the PR.'
        : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => reopen.mutate()}
        disabled={reopen.isPending}
        className="hit inline-flex items-center gap-1 rounded-ui border border-ui-line px-2 py-0.5 text-body font-medium text-ui-mute hover:bg-ui-hover disabled:opacity-50"
        title="Reopen this PR on GitHub"
      >
        <ReopenIcon /> {reopen.isPending ? 'Reopening…' : 'Reopen'}
      </button>
      {error && <span className="text-meta text-ui-danger">{error}</span>}
    </div>
  );
}
