import type { AutoPostSkipReason, ClaudeReview, ReviewPostMode } from '@pierre-review/shared';

// THE MANUAL REVIEW BUTTON'S TWO CHOICES (docs/CLAUDE-REVIEW.md § Auto-posting, "Review and post").
// The main part of the split button runs the reader's LAST choice, remembered in this browser; the
// caret opens the menu. "Review and post" posts the run under the auto-post rules when it ends;
// "Review only" keeps it in Limn and pre-fills the summary box (`nextSummaryPrefill`).

export const REVIEW_POST_MODE_KEY = 'limn.reviewPostMode';

export const REVIEW_POST_MODE_LABEL: Record<ReviewPostMode, string> = {
  review_only: 'Review only',
  post: 'Review and post',
};

/** The reader's last choice; "Review only" when none is stored or storage is unavailable. */
export function readReviewPostMode(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): ReviewPostMode {
  try {
    return storage?.getItem(REVIEW_POST_MODE_KEY) === 'post' ? 'post' : 'review_only';
  } catch {
    return 'review_only';
  }
}

/** Remember the reader's choice (a failed write is ignored: the choice still runs). */
export function writeReviewPostMode(mode: ReviewPostMode, storage: Pick<Storage, 'setItem'> | null = safeLocalStorage()): void {
  try {
    storage?.setItem(REVIEW_POST_MODE_KEY, mode);
  } catch {
    /* private window or blocked storage: not remembered */
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The main button's words: the choice, as a first run or a re-run. */
export function reviewRunButtonLabel(mode: ReviewPostMode, hasReview: boolean): string {
  if (!hasReview) return REVIEW_POST_MODE_LABEL[mode];
  return mode === 'post' ? 'Re-review and post' : 'Re-review only';
}

/** One line under a "Review and post" run: while it runs, and when it posted nothing. Else null. */
export function pressedPostLine(
  r: Pick<ClaudeReview, 'postOnFinish' | 'status' | 'autoPost'> | null | undefined,
): string | null {
  if (r == null || r.postOnFinish !== true) return null;
  if (r.status === 'queued' || r.status === 'running') return 'Posts to GitHub when done.';
  const a = r.autoPost;
  if (a == null || a.status !== 'skipped') return null;
  const skip: Partial<Record<AutoPostSkipReason, string>> = {
    nothing_new: 'Nothing new to post.',
    not_open: 'Not posted: the PR is closed.',
    draft: 'Not posted: the PR is a draft.',
  };
  return a.reason != null ? (skip[a.reason] ?? null) : null;
}

/** The text a "Review only" run puts in the summary box: its summary, as a manual post would use. */
export function summaryPrefillOf(
  r: Pick<ClaudeReview, 'trigger' | 'postOnFinish' | 'status' | 'summary' | 'userBody' | 'kind' | 'postedAt'> | null | undefined,
): string | null {
  if (r == null || r.status !== 'succeeded' || r.trigger !== 'manual' || r.postOnFinish === true) return null;
  if (r.kind != null || r.postedAt != null) return null;
  // The reader saved a draft on this run — EMPTY included (they cleared the summary on purpose):
  // never replaced. The box only renders once the run succeeded, so no save can precede the fill.
  if (r.userBody != null) return null;
  const s = r.summary?.trim() ?? '';
  return s === '' ? null : s;
}

/**
 * THE PRE-FILL RULE: the new box text, or null to leave the box alone. It fills only a box that is
 * empty or still holds the earlier pre-fill unchanged — never text the reader typed.
 */
export function nextSummaryPrefill(a: { box: string; lastPrefill: string | null; prefill: string | null }): string | null {
  if (a.prefill == null) return null;
  if (a.box === a.prefill) return null;
  const untouched = a.box.trim() === '' || (a.lastPrefill != null && a.box === a.lastPrefill);
  return untouched ? a.prefill : null;
}
