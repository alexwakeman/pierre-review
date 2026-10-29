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
    <div className="mx-auto max-w-4xl space-y-1.5 px-3 pb-4 md:px-5">
      <MentionTextarea
        prId={prId}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus={autoFocus}
        placeholder="Add a comment to this PR (markdown, @ to mention)…"
        className="w-full rounded-ui bg-ui-raise px-2.5 py-2 text-body text-ui-ink ring-1 ring-inset ring-ui-line placeholder:text-ui-faint focus:outline-none focus:ring-2 focus:ring-ui-accent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={comment.isPending || body.trim().length === 0}
          className="inline-flex h-8 items-center whitespace-nowrap rounded-ui bg-ui-accent-fill px-3 text-body font-medium text-ui-on-accent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 touch:h-11 touch:px-4"
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
            className="inline-flex h-8 items-center whitespace-nowrap rounded-ui bg-ui-raise px-3 text-body text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-11 touch:px-4"
          >
            Cancel
          </button>
        )}
        {error && <span className="text-meta text-ui-danger">{error}</span>}
      </div>
    </div>
  );
}
