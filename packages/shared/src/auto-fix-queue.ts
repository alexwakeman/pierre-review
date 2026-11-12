// THE AUTO FIX QUEUE (docs/CLAUDE-REVIEW.md § AI Fix → The auto fix queue). On the reader's own PR, with
// auto AI Fix on, Limn decides per PR when the next automatic fix starts:
//   • it waits while CI jobs on the head are still running (a fix pushed mid-run restarts them);
//   • it waits while the CI review explains a failure (its causes are what a CI fix works from);
//   • a CI fix waits a short while for the AI review of the same head, so ONE fix carries both;
//   • while a fix runs, the next waits behind it — and when it starts, its work is read again at the
//     PR's CURRENT head (the AI review and the CI review of that head), so nothing already fixed is sent.
// Each fix is its own run and its own push. This file is the wire contract and the plain words.

import type { AiFixStatus } from './types.js';

/** How long a CI fix waits for the AI review of the same head. */
export const AUTO_FIX_REVIEW_WAIT_MS = 15 * 60_000;
/** How long a fix waits for the head's CI jobs to finish before it starts anyway. */
export const AUTO_FIX_CI_WAIT_MAX_MS = 45 * 60_000;
/** How long a fix waits for the CI review to explain a failure. */
export const AUTO_FIX_CI_REVIEW_WAIT_MS = 15 * 60_000;

export type AutoFixQueueReason =
  // waits
  | 'ci_running'
  | 'ci_review'
  | 'review_running'
  | 'review_due'
  | 'fix_running'
  | 'sandbox_busy'
  | 'over_budget'
  | 'no_sandbox'
  // ended, until the PR changes
  | 'fix_waiting'
  | 'cap'
  | 'already_tried'
  | 'nothing_to_fix'
  | 'not_started';

export type AutoFixQueueStatus = 'waiting' | 'started' | 'idle';

export interface AutoFixQueueState {
  prId: number;
  headSha: string | null;
  status: AutoFixQueueStatus;
  reason: AutoFixQueueReason | null;
  /** One plain line for the AI Review tab. */
  line: string;
  /** ISO: the latest a wait lasts (it may end sooner); null when it has no limit or is not a wait. */
  until: string | null;
  /** The fix that started (status `started`). */
  fixId: number | null;
  /** What the fix works from: the AI review of the head (its CI causes included), or the CI review alone. */
  source: 'review' | 'ci' | null;
  /** ISO: when Limn last decided. */
  at: string;
}

export const AUTO_FIX_QUEUE_LINE: Record<AutoFixQueueReason, string> = {
  ci_running: 'Waiting for the CI jobs to finish.',
  ci_review: 'Waiting for the CI review to explain the failure.',
  review_running: 'Waiting for the AI review of this commit, so one fix covers both.',
  review_due: 'Waiting for the AI review of this commit, so one fix covers both.',
  fix_running: 'A fix is running. The next one starts when it ends, from what is still open then.',
  sandbox_busy: 'Waiting for a free sandbox.',
  over_budget: 'Paused: the AI spend limit is reached.',
  no_sandbox: 'Paused: no container runtime is running on this computer.',
  fix_waiting: 'A finished fix is waiting for you to push it.',
  cap: 'No more auto fixes on this pull request today.',
  already_tried: 'The last auto fix could not address these points. Nothing changed since.',
  nothing_to_fix: 'Nothing to fix.',
  not_started: 'The auto fix could not start.',
};

/** One auto fix of a PR, for the AI Review tab's history (newest first). */
export interface AutoFixHistoryRow {
  id: number;
  status: AiFixStatus;
  /** The AI review it came from; null ⇒ the CI review's causes alone. */
  sourceReviewId: number | null;
  /** Items sent to the agent. */
  items: number;
  /** From the agent's report (null when it did not report). */
  addressed: number | null;
  unaddressed: number | null;
  commitMessage: string | null;
  pushedAt: string | null;
  pushedBranch: string | null;
  /** Why it failed, or why the automatic push failed; null otherwise. */
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /api/pro/prs/:id/ai-fix/auto` (DB only). */
export interface AutoFixPanelResponse {
  prId: number;
  /** Auto AI Fix is on for this PR (the reader's own, in a workspace with it switched on). */
  on: boolean;
  queue: AutoFixQueueState | null;
  history: AutoFixHistoryRow[];
}

/** One row of the auto fixes toast. */
export interface AutoFixActiveRow {
  fixId: number;
  prId: number;
  prNumber: number;
  prTitle: string;
  repoFullName: string;
  status: AiFixStatus;
  /** A failed run or a failed automatic push. */
  failed: boolean;
  pushedAt: string | null;
  createdAt: string;
}

/** `GET /api/pro/ai-fixes/auto-active?workspace=`: auto fixes running now, and those that ended in the
 *  last AUTO_FIX_TOAST_RECENT_MS (DB only). */
export interface AutoFixActiveResponse {
  workspaceId: number;
  fixes: AutoFixActiveRow[];
}

export const AUTO_FIX_TOAST_RECENT_MS = 2 * 60 * 60_000;

/** The Open PRs / toast words for one row. */
export function autoFixRowLine(r: Pick<AutoFixActiveRow, 'status' | 'failed' | 'pushedAt'>): string {
  if (r.status === 'queued' || r.status === 'running') return 'Fixing…';
  if (r.failed) return 'Failed';
  if (r.pushedAt != null) return 'Pushed';
  if (r.status === 'succeeded') return 'Ready to push';
  if (r.status === 'cancelled') return 'Stopped';
  return 'Ended';
}
