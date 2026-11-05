// WITHDRAWING LIMN'S OWN AUTOMATIC APPROVAL (docs/CLAUDE-REVIEW.md § Withdrawing Limn's approval).
//
// An auto-posted APPROVE is Limn's judgement of ONE head. When a later run at a new head does not
// approve, that approval must not stay in force on GitHub. ONE path dismisses it:
//
//   THE RUN PATH (auto-post.ts, ALWAYS ON): a later auto run — or a "Review and post" run — at a NEW
//   head that does not approve dismisses Limn's standing approval FIRST, then posts its review.
//
// ⚠ THERE IS NO PUSH PATH (removed 2026-11-05). A push alone never withdraws Limn's approval: GitHub's
// own rule (a ruleset's `dismiss_stale_reviews_on_push`, or classic protection's "dismiss stale
// approvals") does that per repo/branch, and Limn must not override a repo that keeps approvals.
// Old records with `why: 'push'` (written by the removed path) still read and render.
//
// ⚠ RECOGNITION IS BY STORED ID ONLY: the approval is Limn's when an earlier run's `auto_post` record
// holds its GitHub review id with `verdict.submitted === 'APPROVE'` (the twin of
// `loadLimnAutoBlockIds`). Never by marker or body: a manual Post, or an approval by hand, carries the
// same marker (or none) and is the reader's own judgement — never touched.
// ⚠ LIVE: it is dismissed only while it is still the reader's standing review on GitHub.
// ⚠ THE CLAIM: `approvalWithdrawal` on the APPROVING run's `auto_post` JSON, compare-and-set from
// absent BEFORE the GitHub write (a `json_set` guarded by `json_extract … IS NULL`). Whichever run
// claims first dismisses; another does nothing. A failure is recorded in GitHub's words and NEVER
// retried (the record is never cleared).
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { ClaudeApprovalWithdrawal, ClaudeAutoPostRecord } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { ownRunsOnly } from '../../db/teammate-reviews.js';

/** What the withdrawal helpers need of the context (sync passes the core client). */
export type WithdrawCtx = Pick<AgentContext, 'db' | 'schema'> & {
  log: { warn(msg: string): void };
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: WithdrawCtx): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const shortSha = (sha: string): string => sha.slice(0, 7);

/** One of Limn's own automatic approvals on a PR, keyed by its GitHub review id. */
export interface LimnAutoApproval {
  // The run whose record holds the approval (a pair: the half that claimed the post) — the claim row.
  runId: number;
  githubReviewId: string;
  // The head it approved.
  headSha: string;
  withdrawal: ClaudeApprovalWithdrawal | null;
}

/**
 * Limn's own automatic APPROVE reviews on this PR (account-scoped), by GitHub review id: every own
 * run (before `beforeReviewId`, when given) whose auto-post LANDED a review SENT as APPROVE. A pair's
 * one review is recorded on both halves; the claim row is the half without `viaPairReviewId`.
 */
export async function loadLimnAutoApprovals(
  ctx: WithdrawCtx,
  accountId: number,
  prId: number,
  beforeReviewId?: number,
): Promise<Map<string, LimnAutoApproval>> {
  const cr = s(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id, headSha: cr.headSha, autoPost: cr.autoPost })
    .from(cr)
    .where(
      and(
        eq(cr.prId, prId),
        eq(cr.accountId, accountId),
        ownRunsOnly(cr.kind),
        ...(beforeReviewId != null ? [lt(cr.id, beforeReviewId)] : []),
      ),
    )
    .orderBy(asc(cr.id))
    .execute()) as Array<{ id: number; headSha: string; autoPost: ClaudeAutoPostRecord | null }>;
  const out = new Map<string, LimnAutoApproval & { via: boolean }>();
  for (const r of rows) {
    const a = r.autoPost;
    if (a?.githubReviewId == null || a.verdict?.submitted !== 'APPROVE') continue;
    const id = String(a.githubReviewId);
    const via = a.viaPairReviewId != null;
    const had = out.get(id);
    if (had != null && !(had.via && !via)) continue;
    out.set(id, { runId: r.id, githubReviewId: id, headSha: r.headSha, withdrawal: a.approvalWithdrawal ?? null, via });
  }
  return new Map([...out].map(([k, { via: _via, ...v }]) => [k, v]));
}

/** The dismissal message for a later run that found problems: counts by severity, then the head. */
export function withdrawMessageForRun(counts: { blockers: number; warnings: number }, headSha: string): string {
  const parts: string[] = [];
  if (counts.blockers > 0) parts.push(counts.blockers === 1 ? '1 blocker' : `${counts.blockers} blockers`);
  if (counts.warnings > 0) parts.push(counts.warnings === 1 ? '1 warning' : `${counts.warnings} warnings`);
  return parts.length > 0
    ? `Limn withdrew its approval: ${parts.join(' and ')} found at ${shortSha(headSha)}.`
    : `Limn withdrew its approval: not approved at ${shortSha(headSha)}.`;
}

/**
 * THE CLAIM: write `approvalWithdrawal` (status 'withdrawing') on the approving run's record, only
 * while it has none. false = someone (the other path, or an earlier attempt) already claimed it.
 */
export async function claimApprovalWithdrawal(
  ctx: WithdrawCtx,
  accountId: number,
  runId: number,
  rec: Omit<ClaudeApprovalWithdrawal, 'status' | 'at' | 'error'>,
): Promise<boolean> {
  const cr = s(ctx).claudeReviews;
  const value: ClaudeApprovalWithdrawal = { ...rec, status: 'withdrawing', at: nowIso(), error: null };
  const rows = (await ctx.db
    .update(cr)
    .set({ autoPost: sql`json_set(${cr.autoPost}, '$.approvalWithdrawal', json(${JSON.stringify(value)}))` })
    .where(
      and(
        eq(cr.id, runId),
        eq(cr.accountId, accountId),
        sql`${cr.autoPost} is not null`,
        sql`json_extract(${cr.autoPost}, '$.approvalWithdrawal') is null`,
      ),
    )
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** Settle a claimed withdrawal: 'withdrawn', or 'failed' with GitHub's words. */
export async function settleApprovalWithdrawal(
  ctx: WithdrawCtx,
  accountId: number,
  runId: number,
  rec: ClaudeApprovalWithdrawal,
): Promise<void> {
  const cr = s(ctx).claudeReviews;
  await ctx.db
    .update(cr)
    .set({ autoPost: sql`json_set(${cr.autoPost}, '$.approvalWithdrawal', json(${JSON.stringify(rec)}))` })
    .where(and(eq(cr.id, runId), eq(cr.accountId, accountId), sql`${cr.autoPost} is not null`))
    .execute();
}

/** Stamp the local review row dismissed (GitHub accepted the dismissal; a sync reconciles anyway). */
export async function stampApprovalDismissed(ctx: WithdrawCtx, prId: number, githubReviewId: string): Promise<void> {
  const rv = s(ctx).reviews;
  await ctx.db
    .update(rv)
    .set({ state: 'dismissed' })
    .where(and(eq(rv.prId, prId), eq(rv.databaseId, githubReviewId)))
    .execute();
}

type DismissResult = { ok: true } | { ok: false; message: string };

/**
 * Claim, dismiss, settle — ONE attempt, never retried. Returns null when the claim was lost (another
 * path has it), else what GitHub said. Never throws.
 */
export async function withdrawApproval(
  ctx: WithdrawCtx,
  a: {
    accountId: number;
    prId: number;
    approval: LimnAutoApproval;
    // Only 'run' is written now; 'push' survives in old stored records.
    why: 'run';
    headSha: string;
    message: string;
    byReviewId?: number | null;
  },
  dismiss: (reviewId: string, message: string) => Promise<DismissResult>,
): Promise<ClaudeApprovalWithdrawal | null> {
  const base = {
    why: a.why,
    headSha: a.headSha,
    message: a.message,
    ...(a.byReviewId != null ? { byReviewId: a.byReviewId } : {}),
  };
  let claimed = false;
  try {
    claimed = await claimApprovalWithdrawal(ctx, a.accountId, a.approval.runId, base);
  } catch (err) {
    ctx.log.warn(`withdraw approval ${a.approval.githubReviewId}: could not claim: ${errText(err)}`);
  }
  if (!claimed) return null;
  let res: DismissResult;
  try {
    res = await dismiss(a.approval.githubReviewId, a.message);
  } catch (err) {
    res = { ok: false, message: errText(err) };
  }
  const rec: ClaudeApprovalWithdrawal = {
    ...base,
    status: res.ok ? 'withdrawn' : 'failed',
    at: nowIso(),
    error: res.ok ? null : res.message.slice(0, 300),
  };
  await settleApprovalWithdrawal(ctx, a.accountId, a.approval.runId, rec).catch((err) =>
    ctx.log.warn(`withdraw approval ${a.approval.githubReviewId}: could not record the result: ${errText(err)}`),
  );
  if (res.ok) {
    await stampApprovalDismissed(ctx, a.prId, a.approval.githubReviewId).catch((err) =>
      ctx.log.warn(`withdraw approval ${a.approval.githubReviewId}: could not stamp the dismissal: ${errText(err)}`),
    );
  }
  return rec;
}
