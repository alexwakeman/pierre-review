import {
  AUTO_FIX_DAILY_CAP,
  type ClaudeAutoFixOutcome,
  type ClaudeAutoFixSkipReason,
  type ClaudeAutoReviewWaiting,
  type AutoReviewSweepResponse,
  type ClaudeReviewPrState,
  type ClaudeReviewResponse,
} from '@pierre-review/shared';

// The words for auto review's quiet states: why the next auto review is waiting (the Claude Review
// header), what happened to the auto fix after one (one line under it), and the Open PRs strip's
// AI Fix pill. Pure, so they are tested without a DOM.

export const AUTO_REVIEW_WAITING_LABEL: Record<ClaudeAutoReviewWaiting, string> = {
  // Never produced any more (auto review no longer waits for CI); kept while the shared type has it.
  ci: 'Auto review waiting for CI',
  comments: 'Auto review waiting for comments to settle',
  commits: 'Auto review waiting for pushes to settle',
};

const SKIP_TEXT: Record<ClaudeAutoFixSkipReason, string> = {
  nothing_to_fix: 'the review found nothing to fix',
  cap: `${AUTO_FIX_DAILY_CAP} auto fixes already ran on this PR in the last 24 hours`,
  fix_in_progress: 'a fix for this PR is already running',
  fix_waiting: 'a finished fix is waiting to be pushed',
  already_tried: 'the last auto fix could not address these items',
  head_moved: 'the PR has new commits since this review',
  not_started: 'the fixer could not start',
  off: 'auto AI Fix is off for this workspace',
  over_budget: 'your AI spend budget is reached',
};

/** One line for the Claude Review tab, or null when there is nothing to say. */
export function autoFixOutcomeLine(outcome: ClaudeAutoFixOutcome | null | undefined): string | null {
  if (outcome == null) return null;
  if (outcome.status === 'started') return 'Auto fix started. See the AI Fix tab.';
  return `No auto fix: ${SKIP_TEXT[outcome.reason] ?? 'skipped'}.`;
}

/** The Open PRs strip's AI Fix pill, or null. */
export function fixPillLabel(fix: ClaudeReviewPrState['fix']): string | null {
  if (fix === 'running') return 'Fixing…';
  if (fix === 'ready') return 'Fix ready';
  return null;
}

/** Is a fix running on any listed PR? The column polls while one is, so "Fix ready" appears. */
export function anyFixRunning(states: readonly ClaudeReviewPrState[] | undefined): boolean {
  return (states ?? []).some((s) => s.fix === 'running');
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The one plain line after "Run auto reviews now" (or "Retry" on one PR): what the sweep queued, or
 * why it queued nothing. `single` words it for the one-PR Retry.
 */
export function autoSweepResultLine(res: AutoReviewSweepResponse, single = false): string {
  if (res.busy) return 'Auto reviews are already being checked. Try again in a moment.';
  if (res.off) return 'Auto review is off for this workspace.';
  if (res.aiNotReady) return 'AI is not set up here, so nothing was queued.';
  const total = res.queued + res.checksQueued;
  if (total === 0) {
    if (res.capped) return 'Daily limit reached — 0 queued.';
    if (res.laneFull) return 'The auto review queue is full — 0 queued.';
    return single ? 'Nothing to retry: the PR is already being reviewed, or is no longer open.' : 'Nothing to review.';
  }
  if (single && res.queued === 1 && res.checksQueued === 0) return 'Retry queued.';
  const parts: string[] = [];
  if (res.queued > 0) parts.push(plural(res.queued, 'review', 'reviews'));
  if (res.checksQueued > 0) parts.push(plural(res.checksQueued, 'thread check', 'thread checks'));
  let line = `Queued ${parts.join(' and ')}.`;
  if (res.capped) line += ' Daily limit reached for the rest.';
  else if (res.laneFull) line += ' The queue is full; the rest follow on their own.';
  return line;
}

/**
 * The AI Review tab's failed-auto line: which error to show and whether "Retry" goes with it, or null.
 * Retry shows where the backend's press acts (docs/CLAUDE-REVIEW.md § Retries):
 *   • the latest run is a FAILED AUTO run at an OLDER head (or the head is unknown): Retry reviews
 *     the new head;
 *   • `failedAutoAtHead`: the latest AUTO run at the CURRENT head failed and no AUTO run there
 *     succeeded, even when manual runs came after it (a press ignores them);
 *   • an older server that sends no `failedAutoAtHead` (undefined): the latest run being a failed
 *     auto run is enough, as before.
 * A failed auto run at the current head where an AUTO run also succeeded still shows its error, with
 * no Retry (that head is done).
 */
export function failedAutoReviewLine(
  data: Pick<ClaudeReviewResponse, 'review' | 'failedAutoAtHead'> | null | undefined,
): { error: string | null; retry: boolean } | null {
  const review = data?.review ?? null;
  const latestFailedAuto = review != null && review.status === 'failed' && review.trigger === 'auto';
  if (review != null && latestFailedAuto && (review.head == null || review.head.outdated)) {
    return { error: review.error ?? null, retry: true };
  }
  if (data?.failedAutoAtHead) return { error: data.failedAutoAtHead.error, retry: true };
  if (review != null && latestFailedAuto) {
    return { error: review.error ?? null, retry: data?.failedAutoAtHead === undefined };
  }
  return null;
}
