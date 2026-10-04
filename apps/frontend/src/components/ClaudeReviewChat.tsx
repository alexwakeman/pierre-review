import { useState } from 'react';
import { ReviewSection } from './ReviewSection.js';
import { CLAUDE_REVIEW_CHAT_MAX_QUESTION_CHARS } from '@pierre-review/shared';
import {
  useAskClaudeReviewChat,
  useClaudeReviewChat,
  useClaudeReviewChatBusy,
  useClaudeReviewChatPendingQuestion,
} from '../hooks/useClaudeReviewChat.js';
import { Markdown } from './Markdown.js';
import { ChevronIcon, CommentIcon } from './Icons.js';
import { AiRunGate } from './AiSetup.js';

// Claude Review chat: ONE thread per review, about the whole review and any of its findings. The
// per-finding "Ask Claude" threads were removed from the screen (the review thread covers them);
// `findingId` stays on the component because the route still serves those older threads.
// The review's thread opens EXPANDED (it sits under Story check), so its one DB read runs on mount;
// Hide collapses it and nothing more is fetched while it is shut.

export const CHAT_HEAD_MOVED_LINE = 'Answers are about the reviewed commit; the PR has moved on.';

const BTN =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';

/** One open thread: its stored turns, the question being answered, and the composer. */
export function ReviewChatThread({
  reviewId,
  findingId,
}: {
  reviewId: number;
  findingId: number | null;
}): JSX.Element {
  const thread = useClaudeReviewChat(reviewId, findingId, true);
  const ask = useAskClaudeReviewChat(reviewId);
  const busy = useClaudeReviewChatBusy(reviewId);
  const pendingHere = useClaudeReviewChatPendingQuestion(reviewId, findingId);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const messages = thread.data?.messages ?? [];
  // Answering on the server but not from this tab's mutation (the pane was reopened mid-answer).
  const answeringElsewhere = thread.data?.answering === true && !busy;
  const tooLong = draft.trim().length > CLAUDE_REVIEW_CHAT_MAX_QUESTION_CHARS;
  const canSend = draft.trim() !== '' && !tooLong && !busy && !answeringElsewhere;

  const send = (): void => {
    if (!canSend) return;
    const question = draft.trim();
    setError(null);
    ask.mutate(
      { question, findingId },
      {
        // Display only: clear the box once the question is stored. The turn itself is written
        // into the cache by the hook, so it survives this mount going away.
        onSuccess: () => setDraft((d) => (d.trim() === question ? '' : d)),
        onError: (e) => setError(e.message),
      },
    );
  };

  return (
    <div className="mt-2 space-y-2 rounded border border-gray-200 bg-gray-50/60 p-2 dark:border-gray-800 dark:bg-gray-900/40">
      {thread.data?.headMoved && (
        <div className="text-xs text-amber-700 dark:text-amber-400">{CHAT_HEAD_MOVED_LINE}</div>
      )}
      {thread.isLoading && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
      {thread.isError && (
        <div className="text-xs text-red-600 dark:text-red-400">Could not load this conversation.</div>
      )}
      {messages.length > 0 && (
        <ol className="space-y-2">
          {messages.map((m) => (
            <li key={m.id} className="text-sm">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {m.role === 'user' ? 'You' : 'Claude'}
              </div>
              {m.role === 'user' ? (
                <div className="whitespace-pre-wrap">{m.content}</div>
              ) : (
                <Markdown prRefs>{m.content}</Markdown>
              )}
            </li>
          ))}
        </ol>
      )}
      {pendingHere != null && (
        <div className="text-sm">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">You</div>
          <div className="whitespace-pre-wrap">{pendingHere}</div>
        </div>
      )}
      {(pendingHere != null || answeringElsewhere) && (
        <div className="text-xs text-gray-500 dark:text-gray-400">Claude is answering…</div>
      )}
      <div className="space-y-1">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={findingId != null ? 'Ask about this finding' : 'Ask about this review'}
          aria-label={findingId != null ? 'Question about this finding' : 'Question about this review'}
          className="w-full resize-y rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950"
        />
        <div className="flex flex-wrap items-center gap-2">
          <AiRunGate>
            <button type="button" onClick={send} disabled={!canSend} className={BTN}>
              {busy ? 'Answering…' : 'Ask'}
            </button>
          </AiRunGate>
          {busy && pendingHere == null && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Answering another question…
            </span>
          )}
          {tooLong && (
            <span className="text-xs text-red-600 dark:text-red-400">
              Keep it under {CLAUDE_REVIEW_CHAT_MAX_QUESTION_CHARS.toLocaleString('en-US')} characters.
            </span>
          )}
          {error != null && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </div>
    </div>
  );
}

/** The whole review's thread, open by default. */
export function ReviewChatSection({ reviewId }: { reviewId: number }): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <ReviewSection
      title="Review chat"
      actions={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          <CommentIcon size={13} />
          {open ? 'Hide' : 'Ask Claude about this review'}
          <ChevronIcon dir={open ? 'down' : 'right'} size={12} />
        </button>
      }
    >
      {open && <ReviewChatThread reviewId={reviewId} findingId={null} />}
    </ReviewSection>
  );
}
