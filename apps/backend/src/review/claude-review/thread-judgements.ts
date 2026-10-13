import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type {
  ClaudeThreadAssessment,
  ClaudeThreadJudgement,
  ClaudeThreadJudgementsForPr,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// What the latest Claude review said about each review thread, for the THREAD CARDS
// (`POST /api/claude-review/thread-judgements`). DB-only, account-scoped, ONE batched read for every
// PR on screen — a thread card never fetches on its own.
//
// "Latest" = the newest SUCCEEDED, non-skip run that assessed threads (`thread_assessments` not
// null). A newer run still in flight, failed or skipped judged nothing, so the previous judgements
// stand until a run replaces them.

/* eslint-disable @typescript-eslint/no-explicit-any */

const iso = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : d == null ? null : new Date(d as string | number).toISOString();

/**
 * Trim a stored assessment to what a thread card needs. A thread Claude did not judge at all
 * (both fields `not_checked`: over the cap, or not reported) is DROPPED — the card must keep its
 * own pills rather than wear a Claude marker that says nothing.
 */
export function judgementsFromAssessments(
  assessments: readonly ClaudeThreadAssessment[],
): ClaudeThreadJudgement[] {
  const out: ClaudeThreadJudgement[] = [];
  const seen = new Set<number>();
  for (const a of assessments) {
    if (a == null || typeof a.threadId !== 'number' || seen.has(a.threadId)) continue;
    if (a.validity === 'not_checked' && a.addressed === 'not_checked') continue;
    seen.add(a.threadId);
    out.push({
      threadId: a.threadId,
      validity: a.validity,
      addressed: a.addressed,
      explanation: a.explanation ?? null,
      assessedAtHead: a.assessedAtHead,
      carried: a.carried === true,
    });
  }
  return out;
}

export async function getThreadJudgements(
  ctx: AgentContext,
  prIds: readonly number[],
  accountId: number,
): Promise<ClaudeThreadJudgementsForPr[]> {
  if (prIds.length === 0) return [];
  const s = ctx.schema as any;
  const cr = s.claudeReviews;
  const prs = s.pullRequests;
  // Step 1: ids only — the newest qualifying run per PR. The JSON is read for the winners alone, so
  // a PR with a long review history costs one small row per run, not its every stored assessment.
  const idRows = (await ctx.db
    .select({ id: cr.id, prId: cr.prId })
    .from(cr)
    .where(
      and(
        inArray(cr.prId, [...prIds]),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        isNotNull(cr.threadAssessments),
        or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
      ),
    )
    .orderBy(desc(cr.id))
    .execute()) as Array<{ id: number; prId: number }>;
  const latest = new Map<number, number>();
  for (const r of idRows) if (!latest.has(r.prId)) latest.set(r.prId, r.id);
  if (latest.size === 0) return [];

  const rows = (await ctx.db
    .select({
      id: cr.id,
      prId: cr.prId,
      headSha: cr.headSha,
      finishedAt: cr.finishedAt,
      threadAssessments: cr.threadAssessments,
      prHeadSha: prs.headSha,
    })
    .from(cr)
    .innerJoin(prs, eq(prs.id, cr.prId))
    .where(and(inArray(cr.id, [...latest.values()]), eq(prs.accountId, accountId)))
    .execute()) as Array<{
    id: number;
    prId: number;
    headSha: string;
    finishedAt: Date | null;
    threadAssessments: ClaudeThreadAssessment[] | null;
    prHeadSha: string | null;
  }>;
  const out: ClaudeThreadJudgementsForPr[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.threadAssessments)) continue;
    out.push({
      prId: r.prId,
      reviewId: r.id,
      reviewedHeadSha: r.headSha,
      finishedAt: iso(r.finishedAt),
      currentHeadSha: r.prHeadSha ?? null,
      judgements: judgementsFromAssessments(r.threadAssessments),
    });
  }
  return out;
}
