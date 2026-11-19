// THE PR'S EARLIER FINDINGS IN AI FIX'S REVIEW LOOP (docs/CLAUDE-REVIEW.md § AI Fix → The review loop → The PR's
// earlier findings). Every round of the loop reviews the fix's work as a branch. Without this, its follow-up
// only judged the loop's OWN earlier rounds, so after a push the imported review (markLoopReviewOnPr) held no
// judgement of the PR's posted findings, auto review skipped that head, and the threads the fix dealt with were
// never resolved (2026-11-19, PR 235160).
//
// SO: each round's follow-up input is the loop's own earlier round (rounds.ts `priorForTarget`) PLUS the PR's
// still-open earlier findings, loaded exactly as a PR review loads them (persist.ts
// `loadPriorReviewForFollowUp`: the provider's chain, the cross carry, the settled-by-reply ones left out,
// their threads attached). The closing round's judgement of them becomes the imported row's `follow_up`, and
// the auto resolve (auto-resolve.ts) closes the threads it found fixed.
//
// ⚠ TWO ID SPACES IN ONE PROMPT: the loop's findings (`ai_fix_loop_findings.id`) and the PR's
// (`claude_review_findings.id`). A PR finding rides the loop NEGATED (`-id`): a follow-up item or a re-raise
// with a NEGATIVE `priorFindingId` is the PR's, and nothing of the loop's own (always > 0) can collide.
// Everything that leaves the loop for the PR goes through `prFollowUpForImport` / `prPriorFindingIdOf`.
import type { AiProviderId, ClaudeFollowUpItemRecord, ClaudeReviewFollowUpRecord } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { PriorFindingForFollowUp, PriorReviewForFollowUp } from '../../review/claude-review/follow-up.js';

/** A PR finding's id inside the loop (negated), and back. */
export const loopIdOfPrFinding = (prFindingId: number): number => -prFindingId;
export const isPrFindingRef = (id: number | null | undefined): id is number => id != null && id < 0;

/** A loop finding's `priorFindingId` as the PR row stores it: a PR finding's id, or null (a loop-only link). */
export const prPriorFindingIdOf = (priorFindingId: number | null | undefined): number | null =>
  isPrFindingRef(priorFindingId) ? -priorFindingId : null;

/**
 * One round's follow-up input: the loop's own earlier round, then the PR's earlier findings (negated ids,
 * CARRIED — they come from an older review than the round before). The loop's own round anchors the record
 * when there is one; otherwise the PR's review does. Pure.
 */
export function mergePrPrior(loop: PriorReviewForFollowUp | null, pr: PriorReviewForFollowUp | null): PriorReviewForFollowUp | null {
  const prFindings: PriorFindingForFollowUp[] = (pr?.findings ?? []).map((f) => ({ ...f, id: loopIdOfPrFinding(f.id), carried: true }));
  if (prFindings.length === 0) return loop;
  if (!loop) return { reviewId: pr!.reviewId, headSha: pr!.headSha, findings: prFindings };
  return { ...loop, findings: [...loop.findings, ...prFindings] };
}

/** One succeeded review run of the closing round, as the import reads it. */
export interface ClosingRunLike {
  pairRole: 'first' | 'second' | null;
  followUp: ClaudeReviewFollowUpRecord | null;
}

/**
 * THE IMPORTED ROW'S FOLLOW-UP: the closing round's judgements of the PR's findings (the negated items, ids
 * restored), lead half first; in a pair each half judged its own provider's findings, and a finding both
 * judged keeps the lead's word. `prior` is the PR review those findings were followed up from (the newest
 * review that raised one of them). null ⇒ the round judged none of them. Pure.
 */
export function prFollowUpForImport(
  runs: readonly ClosingRunLike[],
  prior: { reviewId: number; headSha: string } | null,
): ClaudeReviewFollowUpRecord | null {
  if (!prior) return null;
  const ordered = [...runs].sort((a, z) => Number(a.pairRole === 'second') - Number(z.pairRole === 'second'));
  const seen = new Set<number>();
  const items: ClaudeFollowUpItemRecord[] = [];
  for (const r of ordered) {
    for (const it of r.followUp?.items ?? []) {
      if (!isPrFindingRef(it.priorFindingId)) continue;
      const id = -it.priorFindingId;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ ...it, priorFindingId: id, carried: true });
    }
  }
  if (items.length === 0) return null;
  return {
    priorReviewId: prior.reviewId,
    priorHeadSha: prior.headSha,
    headMoved: items.some((it) => it.headMoved !== false),
    changesSinceShown: false,
    items,
  };
}

const ALL_RUNS = Number.MAX_SAFE_INTEGER;

/**
 * The PR's earlier findings for one loop half, read as a PR review on `provider` reads them (manager.ts): the
 * findings settled by a reply left out, the provider's chain (a pair half: its own provider's only), their
 * GitHub threads attached. null ⇒ none (or a read failed: the loop then reviews its own rounds only, as before).
 */
export async function loadPrPriorForFixLoop(
  ctx: AgentContext,
  a: { accountId: number; prId: number; provider: AiProviderId; inPair: boolean },
): Promise<PriorReviewForFollowUp | null> {
  try {
    const { loadPriorReviewForFollowUp, loadSettledByReplyFindings } = await import('../../review/claude-review/persist.js');
    const settled = await loadSettledByReplyFindings(ctx, a.prId, a.accountId, ALL_RUNS);
    const prior = await loadPriorReviewForFollowUp(ctx, a.prId, a.accountId, ALL_RUNS, new Set(settled.map((f) => f.id)), a.provider, a.inPair);
    if (!prior || prior.findings.length === 0) return null;
    const { attachFindingThreads } = await import('../../review/claude-review/finding-replies.js');
    const attached = await attachFindingThreads(ctx, a.accountId, a.prId, prior.findings);
    return { ...prior, findings: attached };
  } catch (err) {
    ctx.log.warn(`ai fix loop pr ${a.prId}: the PR's earlier findings were not read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The PR review the imported follow-up is anchored on: the newest review that RAISED one of the judged
 * findings (account- and PR-scoped). null ⇒ none found.
 */
export async function prPriorReviewOf(
  ctx: AgentContext,
  a: { accountId: number; prId: number; findingIds: readonly number[] },
): Promise<{ reviewId: number; headSha: string } | null> {
  if (a.findingIds.length === 0) return null;
  const { and, desc, eq, inArray } = await import('drizzle-orm');
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const crf = (ctx.schema as any).claudeReviewFindings;
  const cr = (ctx.schema as any).claudeReviews;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const rows = (await ctx.db
    .select({ id: cr.id, headSha: cr.headSha })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .where(and(eq(cr.accountId, a.accountId), eq(cr.prId, a.prId), inArray(crf.id, [...a.findingIds])))
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{ id: number; headSha: string }>;
  const r = rows[0];
  return r ? { reviewId: r.id, headSha: r.headSha } : null;
}
