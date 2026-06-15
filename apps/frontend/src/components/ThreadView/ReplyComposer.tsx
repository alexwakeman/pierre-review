import { useState } from 'react';
import { useReplyToThread } from '../../hooks/usePrWrites.js';
import { ApiError } from '../../api/client.js';

// Inline composer for replying to a review thread. Opens from a "Reply"
// affordance in the ThreadCard footer; on success it clears + closes, and the
// invalidate-driven refetch renders the new reply as a CommentBlock.
export function ReplyComposer({
  prId,
  threadId,
}: {
  prId: number;
  threadId: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const reply = useReplyToThread();

  const error =
    reply.error instanceof ApiError
      ? reply.error.message
      : reply.error
        ? 'Failed to post the reply.'
        : null;

  const send = () => {
    const trimmed = body.trim();
    if (!trimmed || reply.isPending) return;
    reply.mutate(
      { prId, threadId, body: trimmed },
      {
        onSuccess: () => {
          setBody('');
          setOpen(false);
        },
      },
    );
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-blue-500 hover:underline"
      >
        Reply
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        autoFocus
        placeholder="Reply to this thread (markdown)…"
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={reply.isPending || body.trim().length === 0}
          className="whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {reply.isPending ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setBody('');
            reply.reset();
          }}
          disabled={reply.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          Cancel
        </button>
        {error && <span className="text-[10px] text-red-500">{error}</span>}
      </div>
    </div>
  );
}
