import { useState } from 'react';
import { useCreatePrComment } from '../hooks/usePrWrites.js';
import { ApiError } from '../api/client.js';

// Composer for an issue-level PR comment (distinct from inline review threads),
// rendered at the bottom of the Overview's "PR comments" section. On success it
// clears the textarea; the invalidate-driven refetch appends the new comment to
// PrCommentsList above.
export function PrCommentComposer({ prId }: { prId: number }): JSX.Element {
  const [body, setBody] = useState('');
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
      },
    });
  };

  return (
    <div className="space-y-1.5 px-3 pb-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Add a comment to this PR (markdown)…"
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={comment.isPending || body.trim().length === 0}
          className="whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {comment.isPending ? 'Commenting…' : 'Comment'}
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}
