// THE REPLIES PASS on the AI Review tab — the pure words (docs/CLAUDE-REVIEW.md § The replies pass).
// A pass judges only people's replies on Limn's own posted findings; the tab shows "Check replies"
// while some wait, and one line about the newest pass.
import type { ClaudeRepliesCheckRun, ClaudeRepliesCheckState } from '@pierre-review/shared';
import { autoLiftLine, autoPostFailureLine, autoVerdictLine, notApprovedLine } from './autoPost.js';
import { relativeTime } from './ui.js';

/** The history list's and the run header's label for a replies pass. */
export const REPLIES_CHECK_LABEL = 'Replies checked';

/** "Check replies" is offered: replies wait for a judgement and no pass is running. */
export function canCheckReplies(s: ClaudeRepliesCheckState | null | undefined): boolean {
  return s != null && s.live == null && s.unjudged > 0;
}

/** The button's words: "Check replies" (one) / "Check 3 replies". */
export function checkRepliesButtonText(unjudged: number): string {
  return unjudged > 1 ? `Check ${unjudged} replies` : 'Check replies';
}

/** What the judgements came to: "1 accepted, 1 still open." — null when nothing was judged. */
export function repliesCountsText(r: Pick<ClaudeRepliesCheckRun, 'accepted' | 'disputed' | 'notChecked'>): string | null {
  const parts: string[] = [];
  if (r.accepted > 0) parts.push(`${r.accepted} accepted`);
  if (r.disputed > 0) parts.push(`${r.disputed} still open`);
  if (r.notChecked > 0) parts.push(`${r.notChecked} not checked`);
  return parts.length > 0 ? `${parts.join(', ')}.` : null;
}

/**
 * The newest pass in one line, or null (in flight: the status line says it; cancelled: nothing).
 * A finished AUTO pass adds what its outcome review did; a MANUAL one what it WOULD do (it never posts).
 */
export function repliesCheckLine(run: ClaudeRepliesCheckRun | null | undefined, by = 'Claude'): string | null {
  if (run == null) return null;
  if (run.status === 'failed') {
    const why = run.error != null && run.error.trim() !== '' ? run.error.trim() : null;
    return why ? `Replies check failed: ${why}` : 'Replies check failed.';
  }
  if (run.status !== 'succeeded') return null;
  const when = run.finishedAt ?? run.createdAt;
  const counts = repliesCountsText(run);
  const head = `${REPLIES_CHECK_LABEL} ${relativeTime(when)}${counts ? `: ${counts}` : '.'}`;
  // Why the outcome is not an approval (`notApproved`), when the auto verdict is on.
  const why = notApprovedLine(run);
  const outcome =
    run.trigger === 'auto'
      ? (autoVerdictLine(run.autoPost, by) ?? why ?? autoLiftLine(run.autoPost, by) ?? autoPostFailureLine(run.autoPost))
      : run.verdict === 'APPROVE'
        ? 'Would approve.'
        : run.verdict === 'REQUEST_CHANGES'
          ? 'Would request changes.'
          : why;
  return outcome ? `${head} ${outcome}` : head;
}
