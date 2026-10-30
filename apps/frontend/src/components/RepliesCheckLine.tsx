import type { ClaudeRepliesCheckState, RepliesCheckRefusal } from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { useRepliesCheck } from '../hooks/useClaudeReview.js';
import { useAiProviderName } from '../hooks/useAiCapabilities.js';
import { canCheckReplies, checkRepliesButtonText, repliesCheckLine } from '../lib/repliesCheck.js';
import { AiRunGate } from './AiSetup.js';
import { AiStatusLine } from './AiStatusLine.js';
import { InfoButton } from './InfoModal.js';
import { PendingClaudeReviewIcon } from './Icons.js';

// THE REPLIES PASS on the AI Review tab: "Check replies" while people's replies on Limn's own posted
// findings wait for a judgement, the status line while a pass runs, and one line about the newest pass
// with "Show" (it is a run in the history list). Visible on `me.ai.enabled` (AiRunGate swaps the
// button for the setup line). A pass started here never posts: its replies are drafts ("Post reply").

const REFUSAL_WORDS: Record<RepliesCheckRefusal, string> = {
  nothing_to_check: 'Every reply already has a judgement.',
  review_in_progress: 'A review is running. It checks the replies itself.',
  no_review: 'There is no review to follow up yet.',
};

export function RepliesCheckLine({
  prId,
  state,
  onShow,
}: {
  prId: number;
  state: ClaudeRepliesCheckState | null | undefined;
  onShow: (reviewId: number) => void;
}): JSX.Element | null {
  const { start, cancel } = useRepliesCheck(prId);
  const name = useAiProviderName();
  if (state == null) return null;
  const latest = state.latest;
  const line = repliesCheckLine(latest, name);
  const offer = canCheckReplies(state);
  if (state.live == null && !offer && line == null) return null;

  const answer = start.data;
  const refusal = answer?.outcome === 'refused' ? REFUSAL_WORDS[answer.reason] : null;
  const startError =
    start.error instanceof ApiError ? start.error.message : start.error ? 'The check could not start.' : null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
      {state.live != null ? (
        <AiStatusLine stage={state.live === 'queued' ? 'Waiting for a free slot' : 'Checking replies'} since={latest?.createdAt ?? null}>
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="hit rounded-ui px-1 text-meta text-gray-600 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-300 dark:hover:text-white"
          >
            Cancel
          </button>
        </AiStatusLine>
      ) : (
        <>
          {line != null && <span className="text-gray-700 dark:text-gray-300">{line}</span>}
          {line != null && latest != null && latest.status === 'succeeded' && (
            <button
              type="button"
              onClick={() => onShow(latest.reviewId)}
              className="hit rounded-ui px-1 text-meta text-gray-600 underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
            >
              Show
            </button>
          )}
          {offer && (
            <AiRunGate kind="thread_check">
              <button
                type="button"
                onClick={() => start.mutate()}
                disabled={start.isPending}
                className="hit inline-flex items-center gap-1 rounded-ui border border-ai-border bg-ai-surface-2 px-2 py-0.5 text-meta font-medium text-ai-ink hover:bg-ai-surface disabled:opacity-50"
              >
                <PendingClaudeReviewIcon size={12} className="text-ai-signal" />
                {start.isPending ? 'Starting…' : checkRepliesButtonText(state.unjudged)}
              </button>
            </AiRunGate>
          )}
        </>
      )}
      <InfoButton title="Replies to the review">
        <p>
          When someone replies to one of the review’s comments on GitHub, {name} can check just the
          replies, without a new commit or a full review.
        </p>
        <p>
          It accepts a reply that holds up (the comment then counts as settled) or pushes back once.
          A pass you start here posts nothing: use Post reply on each one.
        </p>
        <p>
          With auto review on, it runs by itself a few minutes after the replies stop. With auto-posting
          on, it posts the replies, and may approve or request changes when the replies change the
          outcome.
        </p>
      </InfoButton>
      {refusal != null && <span className="text-gray-600 dark:text-gray-300">{refusal}</span>}
      {startError != null && <span className="text-red-600 dark:text-red-400">{startError}</span>}
    </div>
  );
}
