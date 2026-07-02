import { useState } from 'react';
import { useCreatePrComment } from '../hooks/usePrWrites.js';
import { ApiError } from '../api/client.js';
import { MentionTextarea } from './MentionTextarea.js';

// Composer for an issue-level PR comment (distinct from inline review threads).
// Two uses share it:
//  - the always-open composer at the bottom of the Overview's "PR comments" section
//    (no initialBody / onCancel);
//  - an expand-in-place REPLY, prefilled with a quote + @mention (initialBody),
//    dismissable via Cancel (onCancel) and collapsed on success (onDone).
// GitHub issue comments are flat, so a "reply" is just a new comment. On success the
// invalidate-driven refetch appends it (and refreshes the Activity feed).
export function PrCommentComposer({
  prId,
  initialBody,
  autoFocus,
  onCancel,
  onDone,
}: {
  prId: number;
  initialBody?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onDone?: () => void;
}): JSX.Element {
  const [body, setBody] = useState(initialBody ?? '');
  const comment = useCreatePrComment(prId);

  const error =
    comment.error instanceof ApiError
      ? comment.error.message
      : comment.error
        ? 'Failed to post the comment.'
        : null;

  const send = (): void => {
    const trimmed = body.trim();
    if (!trimmed || comment.isPending) return;
    comment.mutate(trimmed, {
      onSuccess: () => {
        setBody('');
        onDone?.();
      },
    });
  };

  return (
    <div className="space-y-1.5 px-3 pb-3">
      <MentionTextarea
        prId={prId}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus={autoFocus}
        placeholder="Add a comment to this PR (markdown, @ to mention)…"
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={comment.isPending || body.trim().length === 0}
          className="whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {comment.isPending ? 'Commenting…' : onCancel ? 'Reply' : 'Comment'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={() => {
              comment.reset();
              onCancel();
            }}
            disabled={comment.isPending}
            className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
          >
            Cancel
          </button>
        )}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}
