import {
  type ClaudeAutoFixOutcome,
  type ClaudeAutoFixSkipReason,
  type ClaudeAutoReviewWaiting,
  type ClaudeAutoReviewWhy,
  type AutoReviewSweepResponse,
  type ClaudeReviewPrState,
  type ClaudeReviewResponse,
  type ClaudeTeamClaimSkip,
  aiProviderName,
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

/** Why a queued auto review went ahead of the rest (a teammate's verdict), or null. */
export function autoReviewWhyLine(why: ClaudeAutoReviewWhy | null | undefined): string | null {
  if (why == null) return null;
  if (why.reason === 'moved') return 'Queued: needs a verdict (new commits since the last Limn review)';
  const who = why.authorLogin != null ? `${why.authorLogin}’s` : 'the author’s';
  if (why.authorVerdict === 'APPROVE') return `Queued: needs a verdict (${who} own review would approve)`;
  if (why.authorVerdict === 'REQUEST_CHANGES') return `Queued: needs a verdict (${who} own review would ask for changes)`;
  return `Queued: needs a verdict (${who} own review)`;
}

/** The reader's own PR waits for a teammate's Limn verdict (the server only says so with evidence). */
export const TEAMMATE_VERDICT_WAIT_LINE = 'Waiting for a teammate’s Limn to review';

// A SKIP is shown only when it is a fault the reader can fix on this computer (2026-11-10: the routine
// skips — off, nothing to fix, a fix already waiting, the daily cap, new commits — said nothing the
// reader acts on, and are no longer shown).
const FAULT_TEXT: Partial<Record<ClaudeAutoFixSkipReason, string>> = {
  not_started: 'the fixer could not start',
  over_budget: 'your AI spend budget is reached',
  no_sandbox: 'no container runtime is running on this computer',
};

/** One line for the AI Review tab, or null when there is nothing to say. */
export function autoFixOutcomeLine(outcome: ClaudeAutoFixOutcome | null | undefined): string | null {
  if (outcome == null) return null;
  if (outcome.status === 'started') return 'Auto fix started. See the AI Fix tab.';
  const fault = FAULT_TEXT[outcome.reason];
  return fault != null ? `No auto fix: ${fault}.` : null;
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
  const replies = res.repliesQueued ?? 0;
  const total = res.queued + res.checksQueued + replies;
  if (total === 0) {
    if (res.capped) return 'Daily limit reached — 0 queued.';
    if (res.laneFull) return 'The auto review queue is full — 0 queued.';
    return single ? 'Nothing to retry: the PR is already being reviewed, or is no longer open.' : 'Nothing to review.';
  }
  if (single && res.queued === 1 && res.checksQueued === 0 && replies === 0) return 'Retry queued.';
  const parts: string[] = [];
  if (res.queued > 0) parts.push(plural(res.queued, 'review', 'reviews'));
  if (res.checksQueued > 0) parts.push(plural(res.checksQueued, 'thread check', 'thread checks'));
  if (replies > 0) parts.push(plural(replies, 'reply check', 'reply checks'));
  let line = `Queued ${parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join(' and ')}.`;
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

// ---- TEAM CLAIMS ("Mark auto reviews on GitHub") ----

/** Why the auto review at this commit was skipped: a teammate's Limn holds it. */
export function teamClaimSkipLine(skip: Pick<ClaudeTeamClaimSkip, 'kind' | 'login'> | null | undefined): string | null {
  if (!skip) return null;
  return skip.kind === 'reviewed'
    ? `Auto review skipped: already reviewed by @${skip.login}`
    : `Auto review skipped: being reviewed by @${skip.login}`;
}

/**
 * A TEAMMATE'S LINE this Limn stood down for (`ClaudeReviewResponse.teamClaimTeammates`, durable):
 * "Robin Dunn reviewed this commit with Claude · no comments" / "Robin Dunn is reviewing this commit
 * with Claude". The name from the synced users table, else @login. The detail is the part of their
 * own line after " · " ("no comments", "4 comments"); "kept in Limn" (nothing posted) reads "not
 * posted on GitHub".
 */
export function teammateReviewLine(
  t: Pick<ClaudeTeamClaimSkip, 'kind' | 'login' | 'provider'> & { name?: string | null; description?: string | null },
): string {
  const who = t.name != null && t.name.trim() !== '' ? t.name.trim() : `@${t.login}`;
  const by = aiProviderName(t.provider);
  if (t.kind === 'reviewing') return `${who} is reviewing this commit with ${by}`;
  const dot = (t.description ?? '').indexOf(' · ');
  const raw = dot >= 0 ? (t.description ?? '').slice(dot + 3).trim() : '';
  const detail = raw === 'kept in Limn' ? 'not posted on GitHub' : raw;
  return `${who} reviewed this commit with ${by}${detail !== '' ? ` · ${detail}` : ''}`;
}
