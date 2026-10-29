// WHY A REVIEW WAS NOT APPROVED, ON READ (docs/CLAUDE-REVIEW.md § Auto-posting → AUTO VERDICT → The
// reason). The AI Review tab always shows one "Not approved: …" line under the verdict while the
// workspace's auto verdict is on:
//   • auto-posting recorded one (`auto_post.verdict.reasonText`, a gate's reason included) ⇒ that;
//   • else (a manual run, auto-posting off, a skip before the verdict) it is computed here from the
//     run's findings and model verdict(s) by the SAME rule (`findingsNotApproved`, the workspace's
//     strictness and leftovers), then "your own pull request" — what the outcome would be. The live
//     gates (a standing review, impact) are only known to a real auto post.
// DB-only. Never throws (a failed read is no line).
import { aiRunProviderName, type ClaudeNotApproved, type ClaudeReview } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { readVerdictRulesForPr } from './auto-settings.js';
import { findingsNotApproved, heldReasonText, type VerdictRun } from './auto-verdict.js';
import { getClaudeReviewById } from './persist.js';
import { prAuthorIsAccount } from '../../coding/ai-fix/auto-fix.js';

/** The reason auto-posting recorded on a run, or null (none, or it approved). */
export function recordedNotApproved(review: Pick<ClaudeReview, 'autoPost'>): ClaudeNotApproved | null | undefined {
  const v = review.autoPost?.verdict;
  if (v == null) return undefined;
  if (v.submitted === 'APPROVE') return null;
  if (v.reasonText) return { heldReason: v.heldReason ?? 'model_comment', text: v.reasonText };
  // An older record (before the reason existed) with a gate's hold: its words.
  if (v.wanted === 'APPROVE' && v.heldReason != null) {
    const text = heldReasonText(v);
    if (text) return { heldReason: v.heldReason, text };
  }
  return undefined;
}

export async function notApprovedForView(
  ctx: AgentContext,
  accountId: number,
  review: ClaudeReview | null,
): Promise<ClaudeNotApproved | null> {
  try {
    if (review == null || review.status !== 'succeeded' || review.reviewMode === 'skip' || review.kind === 'replies') {
      return null;
    }
    const rules = await readVerdictRulesForPr(ctx, accountId, review.prId);
    if (!rules.autoVerdict) return null;
    const recorded = recordedNotApproved(review);
    if (recorded !== undefined) return recorded;
    // A pair: each succeeded half's own verdict and summary (the view carries only the merged ones).
    let runs: VerdictRun[] = [{ by: aiRunProviderName(review), verdict: review.verdict, summary: review.summary }];
    const halfIds = review.pair?.halves?.filter((h) => h.status === 'succeeded').map((h) => h.reviewId) ?? [];
    if (halfIds.length >= 2) {
      const halves = await Promise.all(halfIds.map((id) => getClaudeReviewById(ctx, id, accountId)));
      const ok = halves.filter((h): h is ClaudeReview => h != null && h.prId === review.prId && h.status === 'succeeded');
      if (ok.length >= 2) runs = ok.map((h) => ({ by: aiRunProviderName(h), verdict: h.verdict, summary: h.summary }));
    }
    const why = findingsNotApproved(runs, review.findings, rules);
    if (why != null) return why;
    if (await prAuthorIsAccount(ctx, accountId, review.prId)) {
      return { heldReason: 'own_pr', text: heldReasonText({ heldReason: 'own_pr' })! };
    }
    return null;
  } catch (err) {
    ctx.log.warn(`claude review ${review?.id}: the not-approved reason could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
