// THE AI REVIEW ON THE PR OVERVIEW (components/pr/AiReviewOverview.tsx): the newest Limn review on
// the PR — the reader's own, or a teammate's posted one — read from the SAME `['claude-review', prId]`
// answer the AI Review tab and its tab pill already hold (no request of its own). Pure, so tested.
//
// "Newest" follows the server's merged view (`teamView.lead`, docs/CLAUDE-REVIEW.md § Teammates'
// reviews → One review) when it is there; on an older server it is the newer of the reader's latest
// SUCCEEDED run and the newest teammate review. The open findings are the merged set: the reader's
// latest succeeded review's findings (praise is never a finding) plus teammates' still-open ones
// (`teamView.findings`, which never repeat one of the reader's).
import {
  isLimnSeverity,
  type ClaudeReviewResponse,
  type ClaudeReviewVerdict,
  type ClaudeTeammateReview,
  type LimnSeverity,
} from '@pierre-review/shared';
import { markdownToPlain } from './pendingHeadings.js';
import { teammateReviewTitle } from './teammateReviews.js';

export const AI_OVERVIEW_SEVERITIES: readonly LimnSeverity[] = ['blocker', 'warning', 'question', 'nit'];

const SEVERITY_NOUN: Record<LimnSeverity, [string, string]> = {
  blocker: ['blocker', 'blockers'],
  warning: ['warning', 'warnings'],
  question: ['question', 'questions'],
  nit: ['nit', 'nits'],
};

export interface AiReviewOverviewModel {
  /** null = the reader's own review; else "Robin’s review". */
  whose: string | null;
  verdict: ClaudeReviewVerdict | null;
  /** When it finished (own) or was posted (teammate), ISO. */
  at: string;
  /** Open findings by severity, severity order, zeros left out. */
  counts: Array<{ severity: LimnSeverity; n: number; label: string }>;
  /** Open findings with no severity (a teammate's post without one). */
  unlabelled: number;
  /** Every open finding. */
  open: number;
  /** The summary as plain text (the component clamps it to three lines), or null. */
  excerpt: string | null;
}

function countLabel(severity: LimnSeverity, n: number): string {
  const [one, many] = SEVERITY_NOUN[severity];
  return `${n} ${n === 1 ? one : many}`;
}

function excerptOf(summary: string | null | undefined): string | null {
  if (summary == null) return null;
  const plain = markdownToPlain(summary).replace(/\s+/g, ' ').trim();
  return plain === '' ? null : plain;
}

export function aiReviewOverview(data: ClaudeReviewResponse | null | undefined): AiReviewOverviewModel | null {
  if (data == null) return null;
  const own = data.review?.status === 'succeeded' ? data.review : null;
  const mates = data.teammateReviews ?? [];
  const newestMate: ClaudeTeammateReview | null =
    mates.reduce<ClaudeTeammateReview | null>((best, r) => (best == null || Date.parse(r.postedAt) > Date.parse(best.postedAt) ? r : best), null);
  const view = data.teamView;
  let mate: ClaudeTeammateReview | null = null;
  if (view?.lead === 'teammate') mate = mates.find((r) => r.reviewId === view.teammateReviewId) ?? newestMate;
  else if (view == null && newestMate != null) {
    const ownAt = own != null ? Date.parse(own.finishedAt ?? own.createdAt) : -Infinity;
    if (Date.parse(newestMate.postedAt) > ownAt) mate = newestMate;
  }
  // The server led with the reader’s own run but it is not a succeeded one (queued / running; a
  // failed run only on an older server): the newest teammate review is the newest finished one.
  if (mate == null && own == null) mate = newestMate;
  if (mate == null && own == null) return null;

  const bySeverity = new Map<LimnSeverity, number>();
  let unlabelled = 0;
  const add = (s: string | null): void => {
    if (s === 'praise') return;
    if (s != null && isLimnSeverity(s)) bySeverity.set(s, (bySeverity.get(s) ?? 0) + 1);
    else unlabelled++;
  };
  if (view != null) {
    for (const f of own?.findings ?? []) add(f.severity);
    for (const f of view.findings) add(f.severity);
  } else if (mate != null) {
    for (const f of mate.findings) add(f.severity);
  } else {
    for (const f of own?.findings ?? []) add(f.severity);
  }
  const counts = AI_OVERVIEW_SEVERITIES.flatMap((severity) => {
    const n = bySeverity.get(severity) ?? 0;
    return n > 0 ? [{ severity, n, label: countLabel(severity, n) }] : [];
  });
  const open = counts.reduce((a, c) => a + c.n, 0) + unlabelled;

  if (mate != null) {
    return { whose: teammateReviewTitle(mate), verdict: mate.verdict, at: mate.postedAt, counts, unlabelled, open, excerpt: excerptOf(mate.summary) };
  }
  const r = own as NonNullable<typeof own>;
  return { whose: null, verdict: r.verdict, at: r.finishedAt ?? r.createdAt, counts, unlabelled, open, excerpt: excerptOf(r.summary) };
}
