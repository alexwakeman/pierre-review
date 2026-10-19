import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type {
  ClaudeFollowUpItemRecord,
  ClaudeReviewFollowUpRecord,
  ClaudeThreadAddressed,
  ClaudeThreadAssessment,
  ClaudeThreadFindingOutcome,
  ClaudeThreadJudgement,
  ClaudeThreadJudgementsForPr,
  ClaudeThreadValidity,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// What the latest Claude review said about each review thread, for the THREAD CARDS
// (`POST /api/claude-review/thread-judgements`). DB-only, account-scoped, ONE batched read for every
// PR on screen — a thread card never fetches on its own.
//
// Threads rooted on Claude's OWN posted findings are not thread judgements (the follow-up owns
// them); each carries the newest follow-up's outcome instead (`findingJudgementsFromFollowUps`).
//
// "Latest" = the newest SUCCEEDED, non-skip run that assessed threads (`thread_assessments` not
// null), with any later Check threads run folded over it (`currentThreadAssessmentsForPrs`). A newer
// run still in flight, failed or skipped judged nothing, so the previous judgements stand until a
// run replaces them.

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
      reason: a.reason ?? null,
      resolved: a.resolved === true,
      assessedAtHead: a.assessedAtHead,
      carried: a.carried === true,
    });
  }
  return out;
}

/**
 * Fold a later Check threads run over a review's assessments: per thread, the OVERLAY wins (it is
 * newer); threads only the base knows keep their base judgement. Order: the overlay's, then the
 * base's leftovers. Pure (exported for the test).
 */
export function overlayThreadAssessments(
  base: readonly ClaudeThreadAssessment[] | null,
  overlay: readonly ClaudeThreadAssessment[] | null,
): ClaudeThreadAssessment[] | null {
  if (!overlay) return base ? [...base] : null;
  if (!base) return [...overlay];
  const seen = new Set<number>();
  const out: ClaudeThreadAssessment[] = [];
  for (const a of overlay) {
    if (a == null || typeof a.threadId !== 'number' || seen.has(a.threadId)) continue;
    seen.add(a.threadId);
    out.push(a);
  }
  for (const a of base) {
    if (a == null || typeof a.threadId !== 'number' || seen.has(a.threadId)) continue;
    seen.add(a.threadId);
    out.push(a);
  }
  return out;
}

/** The thread judgements of one PR as they stand now (see `currentThreadAssessmentsForPrs`). */
export interface CurrentThreadAssessments {
  prId: number;
  reviewId: number | null;
  reviewHeadSha: string | null;
  reviewFinishedAt: Date | null;
  checkId: number | null;
  checkHeadSha: string | null;
  checkFinishedAt: Date | null;
  assessments: ClaudeThreadAssessment[];
}

const ms = (d: unknown): number =>
  d instanceof Date ? d.getTime() : d == null ? 0 : new Date(d as string | number).getTime();

/**
 * THE ONE FOLD of "what Claude says about each thread now": the latest SUCCEEDED, non-skip Claude
 * review that judged threads, with the newest succeeded Check threads run that STARTED after it finished
 * folded over it (per thread, the newer wins). A PR with only a check reads as the check alone.
 * Readers: the thread cards (`getThreadJudgements`), the Claude Review tab, the next review's carry
 * (manager.ts), the next check's plan and AI Fix's review seed. DB-only, account-scoped, batched.
 * `beforeReviewId`: only reviews older than it (a running review reading its own prior).
 */
export async function currentThreadAssessmentsForPrs(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
  opts: { beforeReviewId?: number } = {},
): Promise<Map<number, CurrentThreadAssessments>> {
  const out = new Map<number, CurrentThreadAssessments>();
  if (prIds.length === 0) return out;
  const s = ctx.schema as any;
  const cr = s.claudeReviews;
  const ct = s.claudeThreadChecks;
  const ids = [...new Set(prIds)];

  // Reviews — ids first, the JSON for the winners alone.
  const idRows = (await ctx.db
    .select({ id: cr.id, prId: cr.prId })
    .from(cr)
    .where(
      and(
        inArray(cr.prId, ids),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        isNotNull(cr.threadAssessments),
        or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
        ...(opts.beforeReviewId != null ? [lt(cr.id, opts.beforeReviewId)] : []),
      ),
    )
    .orderBy(desc(cr.id))
    .execute()) as Array<{ id: number; prId: number }>;
  const latestReview = new Map<number, number>();
  for (const r of idRows) if (!latestReview.has(r.prId)) latestReview.set(r.prId, r.id);
  const reviews = new Map<
    number,
    { id: number; headSha: string; finishedAt: Date | null; threadAssessments: ClaudeThreadAssessment[] | null }
  >();
  if (latestReview.size > 0) {
    const rows = (await ctx.db
      .select({
        id: cr.id,
        prId: cr.prId,
        headSha: cr.headSha,
        finishedAt: cr.finishedAt,
        threadAssessments: cr.threadAssessments,
      })
      .from(cr)
      .where(and(inArray(cr.id, [...latestReview.values()]), eq(cr.accountId, accountId)))
      .execute()) as Array<{
      id: number;
      prId: number;
      headSha: string;
      finishedAt: Date | null;
      threadAssessments: ClaudeThreadAssessment[] | null;
    }>;
    for (const r of rows) reviews.set(r.prId, r);
  }

  // Checks — the newest succeeded one per PR that STARTED after that PR's review finished. A check
  // stores its WHOLE reconciled set (carried items included), planned against the fold as it stood
  // when it started; one that started before the review finished was planned against an older review
  // and would overwrite that review's fresh judgements with stale carried ones, so it never applies.
  const checkIds = (await ctx.db
    .select({ id: ct.id, prId: ct.prId, startedAt: ct.startedAt, createdAt: ct.createdAt })
    .from(ct)
    .where(
      and(
        inArray(ct.prId, ids),
        eq(ct.accountId, accountId),
        eq(ct.status, 'succeeded'),
        isNotNull(ct.threadAssessments),
      ),
    )
    .orderBy(desc(ct.id))
    .execute()) as Array<{ id: number; prId: number; startedAt: Date | null; createdAt: Date | null }>;
  const latestCheck = new Map<number, number>();
  for (const c of checkIds) {
    if (latestCheck.has(c.prId)) continue;
    const rv = reviews.get(c.prId);
    if (rv && ms(c.startedAt ?? c.createdAt) <= ms(rv.finishedAt)) {
      latestCheck.set(c.prId, -1); // planned before the review finished: none applies (older ones started earlier still)
      continue;
    }
    latestCheck.set(c.prId, c.id);
  }
  const wanted = [...latestCheck.values()].filter((id) => id > 0);
  const checks = new Map<
    number,
    { id: number; headSha: string; completedAt: Date | null; threadAssessments: ClaudeThreadAssessment[] | null }
  >();
  if (wanted.length > 0) {
    const rows = (await ctx.db
      .select({
        id: ct.id,
        prId: ct.prId,
        headSha: ct.headSha,
        completedAt: ct.completedAt,
        threadAssessments: ct.threadAssessments,
      })
      .from(ct)
      .where(and(inArray(ct.id, wanted), eq(ct.accountId, accountId)))
      .execute()) as Array<{
      id: number;
      prId: number;
      headSha: string;
      completedAt: Date | null;
      threadAssessments: ClaudeThreadAssessment[] | null;
    }>;
    for (const r of rows) checks.set(r.prId, r);
  }

  for (const prId of ids) {
    const rv = reviews.get(prId);
    const ck = checks.get(prId);
    const base = rv && Array.isArray(rv.threadAssessments) ? rv.threadAssessments : null;
    const over = ck && Array.isArray(ck.threadAssessments) ? ck.threadAssessments : null;
    const merged = overlayThreadAssessments(base, over);
    if (!merged) continue;
    out.set(prId, {
      prId,
      reviewId: rv?.id ?? null,
      reviewHeadSha: rv?.headSha ?? null,
      reviewFinishedAt: rv?.finishedAt ?? null,
      checkId: over ? ck!.id : null,
      checkHeadSha: over ? ck!.headSha : null,
      checkFinishedAt: over ? ck!.completedAt : null,
      assessments: merged,
    });
  }
  return out;
}

/** The two generic fields a finding's outcome MIRRORS (for readers that know only them). Pure. */
export function findingMirror(
  o: Pick<ClaudeThreadFindingOutcome, 'status' | 'acceptKind'>,
): { validity: ClaudeThreadValidity; addressed: ClaudeThreadAddressed } {
  switch (o.status) {
    case 'addressed':
    case 'no_longer_applies':
      return { validity: 'not_checked', addressed: 'addressed' };
    case 'partly_addressed':
      return { validity: 'not_checked', addressed: 'partly_addressed' };
    case 'not_addressed':
    case 'reply_disputed':
      return { validity: 'not_checked', addressed: 'not_addressed' };
    case 'reply_accepted':
      return o.acceptKind === 'deferred'
        ? { validity: 'valid', addressed: 'not_addressed' }
        : { validity: 'not_valid', addressed: 'not_checked' };
  }
}

/**
 * CLAUDE'S OWN FINDINGS ON THEIR THREADS. A thread rooted on one of Limn's posted findings is never
 * a thread judgement (the follow-up owns it), so without this its card showed only GitHub's state —
 * "Resolved" — and nothing of what the later reviews found. Per thread (`item.threadId`, stamped at
 * run time), the NEWEST review's follow-up item that judged it (`not_checked` skipped: it never made
 * a claim). A settled finding leaves later follow-ups, so the newest item naming it is its last word.
 * `reviews` NEWEST FIRST. Pure (exported for the test).
 */
export function findingJudgementsFromFollowUps(
  reviews: ReadonlyArray<{ id: number; headSha: string; followUp: ClaudeReviewFollowUpRecord | null }>,
): Map<number, ClaudeThreadJudgement> {
  const out = new Map<number, ClaudeThreadJudgement>();
  for (const r of reviews) {
    const items: ClaudeFollowUpItemRecord[] = Array.isArray(r.followUp?.items) ? r.followUp!.items : [];
    for (const it of items) {
      const threadId = it?.threadId;
      if (typeof threadId !== 'number' || out.has(threadId)) continue;
      if (it.status === 'not_checked' || it.status == null) continue;
      const finding: ClaudeThreadFindingOutcome = {
        status: it.status,
        acceptKind: it.status === 'reply_accepted' ? (it.acceptKind ?? null) : null,
        replyAuthor:
          it.status === 'reply_accepted' || it.status === 'reply_disputed' ? (it.reply?.author ?? null) : null,
        reviewId: r.id,
      };
      out.set(threadId, {
        threadId,
        ...findingMirror(finding),
        explanation: it.explanation ?? null,
        reason: null,
        // Read the thread's CURRENT resolved state from the thread itself.
        resolved: false,
        assessedAtHead: r.headSha,
        carried: it.statusCarried === true,
        finding,
      });
    }
  }
  return out;
}

/** Every succeeded review's follow-up record per PR, newest first (account-scoped, DB-only). */
async function followUpsForPrs(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<
  Map<number, Array<{ id: number; headSha: string; finishedAt: Date | null; followUp: ClaudeReviewFollowUpRecord | null }>>
> {
  const out = new Map<
    number,
    Array<{ id: number; headSha: string; finishedAt: Date | null; followUp: ClaudeReviewFollowUpRecord | null }>
  >();
  if (prIds.length === 0) return out;
  const cr = (ctx.schema as any).claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id, prId: cr.prId, headSha: cr.headSha, finishedAt: cr.finishedAt, followUp: cr.followUp })
    .from(cr)
    .where(
      and(
        inArray(cr.prId, [...new Set(prIds)]),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        isNotNull(cr.followUp),
      ),
    )
    .orderBy(desc(cr.id))
    .execute()) as Array<{
    id: number;
    prId: number;
    headSha: string;
    finishedAt: Date | null;
    followUp: ClaudeReviewFollowUpRecord | null;
  }>;
  for (const r of rows) {
    const list = out.get(r.prId) ?? [];
    list.push(r);
    out.set(r.prId, list);
  }
  return out;
}

export async function getThreadJudgements(
  ctx: AgentContext,
  prIds: readonly number[],
  accountId: number,
): Promise<ClaudeThreadJudgementsForPr[]> {
  if (prIds.length === 0) return [];
  const [current, followUps] = await Promise.all([
    currentThreadAssessmentsForPrs(ctx, accountId, prIds),
    followUpsForPrs(ctx, accountId, prIds),
  ]);
  const findings = new Map<number, Map<number, ClaudeThreadJudgement>>();
  for (const [prId, list] of followUps) {
    const m = findingJudgementsFromFollowUps(list);
    if (m.size > 0) findings.set(prId, m);
  }
  const wanted = [...new Set([...current.keys(), ...findings.keys()])];
  if (wanted.length === 0) return [];
  const s = ctx.schema as any;
  const prs = s.pullRequests;
  const heads = (await ctx.db
    .select({ id: prs.id, headSha: prs.headSha })
    .from(prs)
    .where(and(inArray(prs.id, wanted), eq(prs.accountId, accountId)))
    .execute()) as Array<{ id: number; headSha: string | null }>;
  const headOf = new Map(heads.map((h) => [h.id, h.headSha]));
  const out: ClaudeThreadJudgementsForPr[] = [];
  for (const prId of wanted) {
    if (!headOf.has(prId)) continue;
    const c = current.get(prId);
    const judgements = c ? judgementsFromAssessments(c.assessments) : [];
    // An ordinary thread judgement wins on a thread both somehow name (the two sets are disjoint).
    const judged = new Set(judgements.map((j) => j.threadId));
    for (const j of findings.get(prId)?.values() ?? []) if (!judged.has(j.threadId)) judgements.push(j);
    if (c) {
      const fromCheck = c.checkId != null;
      out.push({
        prId,
        reviewId: c.reviewId,
        checkId: c.checkId,
        reviewedHeadSha: (fromCheck ? c.checkHeadSha : c.reviewHeadSha) ?? '',
        finishedAt: iso(fromCheck ? c.checkFinishedAt : c.reviewFinishedAt),
        currentHeadSha: headOf.get(prId) ?? null,
        judgements,
      });
    } else {
      // Only Claude's own findings were followed up (no run judged other reviewers' threads).
      const latest = followUps.get(prId)?.[0];
      out.push({
        prId,
        reviewId: latest?.id ?? null,
        checkId: null,
        reviewedHeadSha: latest?.headSha ?? '',
        finishedAt: iso(latest?.finishedAt ?? null),
        currentHeadSha: headOf.get(prId) ?? null,
        judgements,
      });
    }
  }
  return out;
}
