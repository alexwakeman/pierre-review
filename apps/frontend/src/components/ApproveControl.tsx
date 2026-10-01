import { useEffect, useState } from 'react';
import { REQUEST_CHANGES_DEFAULT_BODY } from '@pierre-review/shared';
import { useApprovePr, useRequestChangesPr } from '../hooks/usePrWrites.js';
import { ApiError } from '../api/client.js';
import { MentionTextarea } from './MentionTextarea.js';
import { CheckIcon, CommentIcon, WarningIcon } from './Icons.js';

type Standing = 'approved' | 'changes_requested' | null;
type Panel = 'approve-comment' | 'request-changes' | null;

const GREEN_BTN =
  'inline-flex items-center gap-1 whitespace-nowrap rounded border border-green-500 px-2 py-0.5 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-50 dark:border-green-600 dark:text-green-400 dark:hover:bg-green-900/30';
const AMBER_BTN =
  'inline-flex items-center gap-1 whitespace-nowrap rounded border border-amber-500 px-2 py-0.5 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-600 dark:text-amber-400 dark:hover:bg-amber-900/30';
const GREY_BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';

// The review verdict controls in the Overview's Actions row, rendered ONLY when the viewer may
// review (pr.viewerCanApprove — author excluded, write+ required; the server re-checks and 403s).
//
//   Approve               approves at once. No text box, no confirm.
//   Approve with comment  opens a text box; its Approve stays shut until something is typed
//                         (an empty one is plain Approve).
//   Request changes       always opens an optional text box first. Blank sends
//                         "Changes requested." (GitHub refuses an empty request-changes review),
//                         and the placeholder says so.
//
// One panel open at a time. After an approval both approve buttons collapse to a disabled
// "Approved" chip and Request changes stays — GitHub lets you change your verdict. After a
// request for changes a "Changes requested" chip shows and all three buttons stay.
//
// `standing` is the server's (PrDetail.viewerReviewStanding), so it survives a reload. The local
// `verdict` bridges the gap between the POST resolving and the ['pr', id] refetch landing —
// without it the control flickers back to its pre-click state. It yields to the server once the
// two agree.
export function ApproveControl({
  prId,
  standing,
}: {
  prId: number;
  standing: Standing;
}): JSX.Element {
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState('');
  const [verdict, setVerdict] = useState<Standing>(null);
  const approve = useApprovePr(prId);
  const requestChanges = useRequestChangesPr(prId);

  useEffect(() => {
    if (verdict != null && verdict === standing) setVerdict(null);
  }, [verdict, standing]);

  const effective: Standing = verdict ?? standing;
  const busy = approve.isPending || requestChanges.isPending;

  const failed = approve.error ?? requestChanges.error;
  const error =
    failed instanceof ApiError
      ? failed.message
      : failed
        ? 'GitHub did not accept the review.'
        : null;

  const close = (): void => {
    setPanel(null);
    setMessage('');
    approve.reset();
    requestChanges.reset();
  };

  const open = (next: Panel): void => {
    approve.reset();
    requestChanges.reset();
    setMessage('');
    setPanel(next);
  };

  const doApprove = (body?: string): void => {
    if (busy) return;
    requestChanges.reset();
    approve.mutate(body, {
      onSuccess: () => {
        setVerdict('approved');
        setPanel(null);
        setMessage('');
      },
    });
  };

  const doRequestChanges = (): void => {
    if (busy) return;
    approve.reset();
    const trimmed = message.trim();
    requestChanges.mutate(trimmed || undefined, {
      onSuccess: () => {
        setVerdict('changes_requested');
        setPanel(null);
        setMessage('');
      },
    });
  };

  const errorLine = error && <span className="text-xs text-red-500">{error}</span>;

  if (panel != null) {
    const isApprove = panel === 'approve-comment';
    const canSubmit = isApprove ? message.trim() !== '' : true;
    return (
      <div className="w-full space-y-1.5">
        <MentionTextarea
          prId={prId}
          value={message}
          onChange={setMessage}
          rows={3}
          autoFocus
          placeholder={
            isApprove
              ? 'Comment to post with your approval (markdown)…'
              : `Optional. Left blank, this posts "${REQUEST_CHANGES_DEFAULT_BODY}"`
          }
          className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <div className="flex flex-wrap items-center gap-2">
          {isApprove ? (
            <button
              type="button"
              onClick={() => doApprove(message.trim())}
              disabled={busy || !canSubmit}
              className={GREEN_BTN}
            >
              <CheckIcon /> {approve.isPending ? 'Approving…' : 'Approve'}
            </button>
          ) : (
            <button
              type="button"
              onClick={doRequestChanges}
              disabled={busy}
              className={AMBER_BTN}
            >
              <WarningIcon /> {requestChanges.isPending ? 'Sending…' : 'Request changes'}
            </button>
          )}
          <button type="button" onClick={close} disabled={busy} className={GREY_BTN}>
            Cancel
          </button>
          {errorLine}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {effective === 'approved' ? (
        <button
          type="button"
          disabled
          title="Your approval stands"
          className="inline-flex cursor-default items-center gap-1 rounded border border-green-500/40 px-2 py-0.5 text-sm font-medium text-green-700/70 dark:border-green-700/50 dark:text-green-400/70"
        >
          <CheckIcon /> Approved
        </button>
      ) : (
        <>
          {effective === 'changes_requested' && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-sm font-medium text-amber-700 dark:text-amber-400">
              <WarningIcon /> Changes requested
            </span>
          )}
          <button
            type="button"
            onClick={() => doApprove(undefined)}
            disabled={busy}
            className={GREEN_BTN}
          >
            <CheckIcon /> {approve.isPending ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            onClick={() => open('approve-comment')}
            disabled={busy}
            className={GREEN_BTN}
          >
            <CommentIcon /> Approve with comment
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => open('request-changes')}
        disabled={busy}
        className={AMBER_BTN}
      >
        <WarningIcon /> Request changes
      </button>
      {errorLine}
    </div>
  );
}
