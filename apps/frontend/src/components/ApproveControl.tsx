import { useState } from 'react';
import { useApprovePr } from '../hooks/usePrWrites.js';
import { ApiError } from '../api/client.js';
import { MentionTextarea } from './MentionTextarea.js';
import { CheckIcon } from './Icons.js';

// Approve control for the Overview tab, rendered ONLY when the viewer has the
// right to approve (pr.viewerCanApprove — the server re-checks and 403s
// otherwise). Collapsed it's a single green "Approve" button; clicking reveals an
// optional approval message + a Confirm/Cancel pair. On success the invalidate
// refetch updates the Approvers row above; ApiError (incl. 403 NotPermitted /
// 502 GitHubError) surfaces inline.
//
// `alreadyApproved` (the viewer's standing review is 'approved') renders a disabled
// "Approved" state instead — re-approving would just stack a duplicate review.
export function ApproveControl({
  prId,
  alreadyApproved,
}: {
  prId: number;
  alreadyApproved: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const approve = useApprovePr(prId);

  // Render the disabled "Approved" state the instant the POST resolves — not just
  // once the server-derived `alreadyApproved` flips true. useApprovePr is
  // invalidate-only (no optimistic update), so between the POST resolving and the
  // ['pr', id] refetch landing there's a window where the control would otherwise
  // collapse back to a clickable green "Approve" — the momentary flicker users read
  // as lag. `approve.isSuccess` bridges that gap (the branch never calls
  // approve.reset(), so it persists), and `alreadyApproved` holds it thereafter.
  if (alreadyApproved || approve.isSuccess) {
    return (
      <button
        type="button"
        disabled
        title="You've already approved this PR — your approval still stands"
        className="inline-flex cursor-default items-center gap-1 rounded border border-green-500/40 px-2 py-0.5 text-sm font-medium text-green-700/70 dark:border-green-700/50 dark:text-green-400/70"
      >
        <CheckIcon /> Approved
      </button>
    );
  }

  const error =
    approve.error instanceof ApiError
      ? approve.error.message
      : approve.error
        ? 'Failed to approve the PR.'
        : null;

  const submit = (): void => {
    if (approve.isPending) return;
    const trimmed = message.trim();
    approve.mutate(trimmed || undefined, {
      onSuccess: () => {
        setMessage('');
        setOpen(false);
      },
    });
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded border border-green-500 px-2 py-0.5 text-sm font-medium text-green-700 hover:bg-green-50 dark:border-green-600 dark:text-green-400 dark:hover:bg-green-900/30"
        >
          <CheckIcon /> Approve
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      <MentionTextarea
        prId={prId}
        value={message}
        onChange={setMessage}
        rows={3}
        autoFocus
        placeholder="Optional approval message (markdown)…"
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={approve.isPending}
          className="whitespace-nowrap rounded border border-green-500 px-2 py-0.5 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50 dark:border-green-600 dark:text-green-400 dark:hover:bg-green-900/30"
        >
          {approve.isPending ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setMessage('');
            approve.reset();
          }}
          disabled={approve.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}
