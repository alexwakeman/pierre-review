import { useState } from 'react';
import { useClosePr } from '../hooks/usePrWrites.js';
import { ApiError } from '../api/client.js';

// Close control for the Overview "Actions" row (CORE / free tier), rendered when the viewer
// may close the PR (pr.viewerCanClose — write access OR the PR author) and it's still open +
// unmerged. Collapsed it's a single "Close ✕" button; clicking reveals a Confirm/Cancel pair
// so a close isn't an accidental single click. Closing does NOT merge and is reversible on
// GitHub (it can be reopened there). The server re-checks permission + open-state and 403/409s.
export function ClosePrControl({ prId }: { prId: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useClosePr(prId);

  const error =
    close.error instanceof ApiError
      ? close.error.message
      : close.error
        ? 'Failed to close the PR.'
        : null;

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded border border-gray-400 px-2 py-0.5 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          title="Close this PR without merging (reversible on GitHub)"
        >
          <span aria-hidden>✕</span> Close
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-500 dark:text-gray-400">Close without merging?</span>
      <button
        type="button"
        onClick={() =>
          close.mutate(undefined, {
            onSuccess: () => setOpen(false),
          })
        }
        disabled={close.isPending}
        className="whitespace-nowrap rounded border border-red-400 px-2 py-0.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-600 dark:text-red-400 dark:hover:bg-red-900/30"
      >
        {close.isPending ? 'Closing…' : 'Close PR'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          close.reset();
        }}
        disabled={close.isPending}
        className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
