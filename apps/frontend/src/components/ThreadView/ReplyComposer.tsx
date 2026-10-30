import { useState } from 'react';
import { useReplyToThread } from '../../hooks/usePrWrites.js';
import { ApiError } from '../../api/client.js';
import { MentionTextarea } from '../MentionTextarea.js';

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
        className="hit text-ui-accent hover:underline"
      >
        Reply
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <MentionTextarea
        prId={prId}
        value={body}
        onChange={setBody}
        rows={3}
        autoFocus
        placeholder="Reply to this thread (markdown, @ to mention)…"
        className="w-full rounded-ui bg-ui-surface px-2 py-1.5 text-meta"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={reply.isPending || body.trim().length === 0}
          className="hit bg-ui-raise whitespace-nowrap rounded-ui px-2 py-0.5 text-meta text-ui-accent hover:bg-ui-hover disabled:opacity-50"
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
          className="hit bg-ui-raise whitespace-nowrap rounded-ui px-2 py-0.5 text-meta hover:bg-ui-hover disabled:opacity-50"
        >
          Cancel
        </button>
        {error && <span className="text-meta text-ui-danger">{error}</span>}
      </div>
    </div>
  );
}
