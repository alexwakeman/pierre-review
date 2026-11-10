// THE REPLIES PASS on the AI Review tab — the pure words (docs/CLAUDE-REVIEW.md § The replies pass).
// A pass judges only people's replies on Limn's own posted findings; it starts by itself, and the tab
// shows it only while it runs (with Cancel) or when the newest one failed.
import { aiProviderName, type AiProviderId, type ClaudeRepliesCheckRun } from '@pierre-review/shared';

/** The history list's and the run header's label for a replies pass. */
export const REPLIES_CHECK_LABEL = 'Replies checked';

/**
 * A `kind = 'replies'` row's label: a COVER pass (one half of a Claude + Codex pair failed, the other
 * checked its findings) says whose findings it checked; any other reads REPLIES_CHECK_LABEL.
 */
export function repliesRunLabel(review: { followUp?: { cover?: { provider: AiProviderId } } | null }): string {
  const cover = review.followUp?.cover;
  return cover ? `Checked ${aiProviderName(cover.provider)}'s findings` : REPLIES_CHECK_LABEL;
}

/**
 * The newest pass's error, when it failed: "Replies check failed: usage limit". null otherwise (in
 * flight: the status line says it; finished: it is a row in "Reviews on this PR"; cancelled: nothing).
 */
export function repliesCheckFailedLine(run: Pick<ClaudeRepliesCheckRun, 'status' | 'error'> | null | undefined): string | null {
  if (run == null || run.status !== 'failed') return null;
  const why = run.error != null && run.error.trim() !== '' ? run.error.trim() : null;
  return why ? `Replies check failed: ${why}` : 'Replies check failed.';
}
