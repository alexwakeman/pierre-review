// The hidden metadata a posted review carries about HOW it ran (shared `limnReviewMarker`;
// docs/CLAUDE-REVIEW.md § Teammates' reviews). ONE builder for every post of a full review — the
// manual Post, auto-posting — so a teammate's Limn reads the same shape from each.
import { and, eq, inArray } from 'drizzle-orm';
import {
  aiRunProvider,
  LIMN_META_MAX_JUDGED,
  type ClaudeFollowUpStatus,
  type ClaudeReview,
  type ClaudeThreadAddressed,
  type LimnJudgedFinding,
  type LimnJudgedOutcome,
  type LimnReviewMeta,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

export function limnMetaForReview(
  review: Pick<ClaudeReview, 'trigger' | 'provider' | 'model' | 'effort' | 'pair'>,
): Pick<LimnReviewMeta, 'run' | 'pair' | 'runs'> {
  const halves = review.pair?.halves ?? [];
  const pair = review.pair != null && halves.length > 1;
  return {
    run: review.trigger === 'auto' ? 'auto' : 'manual',
    pair,
    runs: pair
      ? halves.slice(0, 2).map((h) => ({ provider: h.provider, model: h.model, effort: h.effort ?? null }))
      : [{ provider: aiRunProvider(review.provider, review.model), model: review.model || null, effort: review.effort ?? null }],
  };
}

/** A follow-up status as a posted judgement; null = not a judgement (`not_checked`). */
export function judgedOutcomeOfFollowUp(status: ClaudeFollowUpStatus): LimnJudgedOutcome | null {
  switch (status) {
    case 'addressed':
    case 'reply_accepted':
      return 'addressed';
    case 'no_longer_applies':
      return 'no_longer_applies';
    case 'not_addressed':
    case 'partly_addressed':
    case 'reply_disputed':
      return 'not_addressed';
    default:
      return null;
  }
}

/** A thread judgement as a posted judgement; null = no verdict on the code (`unclear`, `not_checked`). */
export function judgedOutcomeOfThread(addressed: ClaudeThreadAddressed): LimnJudgedOutcome | null {
  if (addressed === 'addressed') return 'addressed';
  if (addressed === 'not_addressed' || addressed === 'partly_addressed') return 'not_addressed';
  return null;
}

/** The parts of a run the judgements are read from (one run, or both halves of a pair). */
export interface JudgingRun {
  followUp?: { items: ReadonlyArray<{ priorFindingId: number; status: ClaudeFollowUpStatus }> } | null;
  threadAssessments?: ReadonlyArray<{ threadId: number; addressed: ClaudeThreadAddressed }> | null;
}

/**
 * THE JUDGEMENTS A POST CARRIES (`j=` in the summary marker; docs/CLAUDE-REVIEW.md § Teammates'
 * reviews → Judgements travel with a post): what this review found about earlier Limn findings that
 * are ON GITHUB — the reader's own posted findings and teammates' (the follow-up items), and the
 * threads rooted on a teammate's Limn finding (the thread judgements). Keyed by the finding comment's
 * GitHub databaseId, so the finding's own Limn can match it. The follow-up wins over a thread
 * judgement of the same comment. Account- and PR-scoped; DB only. Never throws: a failed read posts
 * no judgements (the review itself must not fail for them).
 */
export async function loadJudgedForPost(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  runs: readonly JudgingRun[],
): Promise<LimnJudgedFinding[]> {
  try {
    const { claudeReviews: cr, claudeReviewFindings: crf, reviewComments: rc } = ctx.schema;
    if (!cr || !crf || !rc) return [];
    const out: LimnJudgedFinding[] = [];
    const seen = new Set<string>();
    const push = (commentId: string | null | undefined, outcome: LimnJudgedOutcome | null): void => {
      if (commentId == null || outcome == null || seen.has(commentId) || out.length >= LIMN_META_MAX_JUDGED) return;
      seen.add(commentId);
      out.push({ commentId, outcome });
    };
    // 1. The follow-up: the latest half's word on a finding wins (halves in order, later overrides).
    const byFinding = new Map<number, LimnJudgedOutcome>();
    for (const r of runs)
      for (const it of r.followUp?.items ?? []) {
        const o = judgedOutcomeOfFollowUp(it.status);
        if (o != null) byFinding.set(it.priorFindingId, o);
      }
    if (byFinding.size > 0) {
      const rows = (await ctx.db
        .select({ id: crf.id, commentId: crf.githubCommentId })
        .from(crf)
        .innerJoin(cr, eq(cr.id, crf.reviewId))
        .where(and(inArray(crf.id, [...byFinding.keys()]), eq(cr.accountId, accountId), eq(cr.prId, prId)))
        .execute()) as Array<{ id: number; commentId: string | null }>;
      for (const r of rows.sort((a, b) => a.id - b.id)) push(r.commentId, byFinding.get(r.id) ?? null);
    }
    // 2. Thread judgements of threads whose ROOT is a Limn finding (a teammate's: the reader's own
    //    findings are never thread-judged, the follow-up covers them).
    const byThread = new Map<number, LimnJudgedOutcome>();
    for (const r of runs)
      for (const t of r.threadAssessments ?? []) {
        const o = judgedOutcomeOfThread(t.addressed);
        if (o != null) byThread.set(t.threadId, o);
      }
    if (byThread.size > 0) {
      const comments = (await ctx.db
        .select({ id: rc.id, threadId: rc.threadId, createdAt: rc.createdAt, databaseId: rc.databaseId, limn: rc.limnPostedByUserId })
        .from(rc)
        .where(and(eq(rc.prId, prId), inArray(rc.threadId, [...byThread.keys()])))
        .execute()) as Array<{ id: number; threadId: number; createdAt: Date; databaseId: string | null; limn: number | null }>;
      const root = new Map<number, (typeof comments)[number]>();
      for (const c of comments) {
        const cur = root.get(c.threadId);
        if (cur == null || c.createdAt.getTime() < cur.createdAt.getTime() || (c.createdAt.getTime() === cur.createdAt.getTime() && c.id < cur.id))
          root.set(c.threadId, c);
      }
      for (const [threadId, outcome] of [...byThread].sort((a, b) => a[0] - b[0])) {
        const c = root.get(threadId);
        if (c != null && c.limn != null) push(c.databaseId, outcome);
      }
    }
    return out;
  } catch (err) {
    ctx.log.warn(`judgements for post pr ${prId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
