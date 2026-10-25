import type { ThreadCheckProgress, ThreadCheckRefusal, ThreadCheckRun } from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { useThreadCheck } from '../hooks/useThreadCheck.js';
import { AiRunGate } from './AiSetup.js';
import { AiStatusLine } from './AiStatusLine.js';
import { InfoButton } from './InfoModal.js';
import { PendingClaudeReviewIcon } from './Icons.js';

// "Check threads": a light Claude pass over ONLY the review threads that changed since their last
// judgement. On the PR's Threads tab and beside the Claude Review tab's Review threads section;
// both read the ONE status query (hooks/useThreadCheck.ts). Gated like Claude Review: visible on
// `me.ai.enabled`, and AiRunGate swaps the button for the setup/credential line when needed.

const REFUSAL_WORDS: Record<ThreadCheckRefusal, string> = {
  no_threads: 'This pull request has no review threads to check.',
  nothing_changed: 'Every thread already has a current judgement.',
  own_findings_only: 'Every thread here is one of Claude’s own comments. A Claude review follows those up.',
};

/** The status line's stage words for a running check. Exported for tests. */
export function threadCheckStage(
  check: Pick<ThreadCheckRun, 'status' | 'threadsSent'>,
  progress: ThreadCheckProgress | null | undefined,
): string {
  const phase = progress?.phase ?? (check.status === 'queued' ? 'queued' : 'checking');
  const n = progress?.threadsSent ?? check.threadsSent ?? null;
  switch (phase) {
    case 'queued':
      return 'Waiting for a free slot';
    case 'preparing':
      return 'Reading the threads';
    case 'saving':
      return 'Saving';
    case 'checking':
      return n != null && n > 0 ? `Checking ${n} thread${n === 1 ? '' : 's'}` : 'Checking threads';
  }
}

export function CheckThreadsButton({ prId }: { prId: number }): JSX.Element | null {
  const { enabled, data, active, start, cancel } = useThreadCheck(prId);
  if (!enabled) return null;
  const check = data?.check ?? null;

  if (active && check != null) {
    return (
      <AiStatusLine
        stage={threadCheckStage(check, data?.progress)}
        since={check.startedAt ?? check.createdAt}
      >
        <button
          type="button"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
          className="rounded px-1 text-xs text-gray-600 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-300 dark:hover:text-white"
        >
          Cancel
        </button>
      </AiStatusLine>
    );
  }

  const answer = start.data;
  const refusal = answer?.outcome === 'refused' ? REFUSAL_WORDS[answer.reason] : null;
  const startError =
    start.error instanceof ApiError
      ? start.error.message
      : start.error
        ? 'The check could not start.'
        : null;
  const lastFailed =
    !start.isPending && start.data == null && check?.status === 'failed' && check.refused == null
      ? 'The last thread check failed.'
      : null;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <AiRunGate kind="thread_check">
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={start.isPending}
          className="inline-flex items-center gap-1 rounded border border-ai-border bg-ai-surface-2 px-2 py-0.5 text-xs font-medium text-ai-ink hover:bg-ai-surface disabled:opacity-50"
        >
          <PendingClaudeReviewIcon size={12} className="text-ai-signal" />
          {start.isPending ? 'Starting…' : 'Check threads'}
        </button>
      </AiRunGate>
      <InfoButton title="Check threads">
        <p>
          Claude reads only the review threads that changed since it last judged them: new threads,
          new replies, resolved or reopened threads, and threads whose code has new commits.
        </p>
        <p>Each thread then shows whether the comment holds up and where the code stands.</p>
        <p>It runs on its own when auto review is on for this workspace.</p>
      </InfoButton>
      {refusal != null && <span className="text-xs text-gray-600 dark:text-gray-300">{refusal}</span>}
      {startError != null && <span className="text-xs text-red-600 dark:text-red-400">{startError}</span>}
      {lastFailed != null && <span className="text-xs text-gray-600 dark:text-gray-300">{lastFailed}</span>}
    </span>
  );
}
