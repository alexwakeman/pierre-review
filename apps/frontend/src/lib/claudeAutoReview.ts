import {
  AUTO_FIX_DAILY_CAP,
  type ClaudeAutoFixOutcome,
  type ClaudeAutoFixSkipReason,
  type ClaudeAutoReviewWaiting,
  type ClaudeReviewPrState,
} from '@pierre-review/shared';

// The words for auto review's quiet states: why the next auto review is waiting (the Claude Review
// header), what happened to the auto fix after one (one line under it), and the Open PRs strip's
// AI Fix pill. Pure, so they are tested without a DOM.

export const AUTO_REVIEW_WAITING_LABEL: Record<ClaudeAutoReviewWaiting, string> = {
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
