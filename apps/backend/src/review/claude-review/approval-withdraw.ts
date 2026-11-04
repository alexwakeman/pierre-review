// WITHDRAWING LIMN'S OWN AUTOMATIC APPROVAL (docs/CLAUDE-REVIEW.md § Withdrawing Limn's approval).
//
// An auto-posted APPROVE is Limn's judgement of ONE head. When the head moves, or a later run at a new
// head finds problems, that approval must not stay in force on GitHub. Two paths dismiss it:
//
//   1. THE RUN PATH (auto-post.ts, ALWAYS ON): a later auto run — or a "Review and post" run — at a NEW
//      head that does not approve dismisses Limn's standing approval FIRST, then posts its review.
//   2. THE PUSH PATH (`maybeWithdrawApprovalOnPush`, called fire-and-forget by sync/upsert.ts when it
//      sees a PR's head move): only in a workspace with auto review AND auto-posting on and the
//      per-workspace switch `withdraw_approval_on_push` on (ON by default, migration 0165), never on
//      the reader's own PR.
//
// ⚠ RECOGNITION IS BY STORED ID ONLY: the approval is Limn's when an earlier run's `auto_post` record
// holds its GitHub review id with `verdict.submitted === 'APPROVE'` (the twin of
// `loadLimnAutoBlockIds`). Never by marker or body: a manual Post, or an approval by hand, carries the
// same marker (or none) and is the reader's own judgement — never touched.
// ⚠ LIVE: it is dismissed only while it is still the reader's standing review on GitHub.
// ⚠ THE CLAIM: `approvalWithdrawal` on the APPROVING run's `auto_post` JSON, compare-and-set from
// absent BEFORE the GitHub write (a `json_set` guarded by `json_extract … IS NULL`). Whichever path
// claims first dismisses; the other does nothing. A failure is recorded in GitHub's words and NEVER
// retried (the record is never cleared).
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { ClaudeApprovalWithdrawal, ClaudeAutoPostRecord } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { ownRunsOnly } from '../../db/teammate-reviews.js';
import type { LiveReview } from './auto-post.js';

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

/** The dismissal message for a push. */
export function withdrawMessageForPush(headSha: string): string {
  return `Limn withdrew its approval: new commits since it approved (${shortSha(headSha)}).`;
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
    why: 'push' | 'run';
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

// ---- THE PUSH PATH ----

/** The pieces of the push path that touch the outside world, so a test can replace them. */
export interface PushWithdrawDeps {
  accountLogin(accountId: number): Promise<string | null>;
  accountUserId(accountId: number): Promise<number | null>;
  liveReviews(owner: string, name: string, prNumber: number): Promise<LiveReview[]>;
  dismissReview(
    accountId: number,
    owner: string,
    name: string,
    prNumber: number,
    reviewId: string,
    message: string,
  ): Promise<DismissResult>;
  settle(a: { accountId: number; prId: number }): Promise<unknown>;
}

export const defaultPushWithdrawDeps: PushWithdrawDeps = {
  async accountLogin(accountId) {
    const { defaultAutoPostDeps } = await import('./auto-post.js');
    return defaultAutoPostDeps.accountLogin(accountId);
  },
  async accountUserId(accountId) {
    const { getAccountUserId } = await import('../../auth/account.js');
    return getAccountUserId(accountId);
  },
  async liveReviews(owner, name, prNumber) {
    const { defaultAutoPostDeps } = await import('./auto-post.js');
    return defaultAutoPostDeps.liveReviews(owner, name, prNumber);
  },
  async dismissReview(accountId, owner, name, prNumber, reviewId, message) {
    const { defaultAutoPostDeps } = await import('./auto-post.js');
    return defaultAutoPostDeps.dismissReview!(accountId, owner, name, prNumber, reviewId, message);
  },
  async settle({ accountId, prId }) {
    const { settlePrAfterWrite } = await import('../../sync/resync-after-write.js');
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    return settlePrAfterWrite({ accountId, prId, log: quiet });
  },
};

export type PushWithdrawOutcome =
  | { kind: 'off' }
  | { kind: 'none' }
  | { kind: 'not_standing' }
  | { kind: 'claimed_elsewhere' }
  | { kind: 'done'; record: ClaudeApprovalWithdrawal };

/**
 * A PR's head was seen at `headSha`: dismiss Limn's own automatic approval of an OLDER head, if it
 * still stands live. DB pre-checks first (the workspace's switches, the reader's own PR, an
 * unwithdrawn approval of another head), so an ordinary walk costs no GitHub call. Never throws.
 */
export async function maybeWithdrawApprovalOnPush(
  ctx: WithdrawCtx,
  a: { accountId: number; prId: number; headSha: string },
  deps: PushWithdrawDeps = defaultPushWithdrawDeps,
): Promise<PushWithdrawOutcome> {
  try {
    return await withdrawOnPush(ctx, a, deps);
  } catch (err) {
    ctx.log.warn(`withdraw approval on push, PR ${a.prId}: ${errText(err)}`);
    return { kind: 'none' };
  }
}

async function withdrawOnPush(
  ctx: WithdrawCtx,
  { accountId, prId, headSha }: { accountId: number; prId: number; headSha: string },
  deps: PushWithdrawDeps,
): Promise<PushWithdrawOutcome> {
  const t = s(ctx);
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs, repos } = t;
  const rows = (await ctx.db
    .select({
      reviewOn: w.autoReviewEnabled,
      postOn: w.autoPostEnabled,
      withdrawOn: w.withdrawApprovalOnPush,
      state: prs.state,
      authorId: prs.authorId,
      number: prs.number,
      owner: repos.owner,
      name: repos.name,
    })
    .from(prs)
    .innerJoin(repos, and(eq(repos.id, prs.repoId), eq(repos.accountId, accountId)))
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{
    reviewOn: boolean | null;
    postOn: boolean | null;
    withdrawOn: boolean | null;
    state: string;
    authorId: number | null;
    number: number;
    owner: string;
    name: string;
  }>;
  const pr = rows[0];
  // Auto review AND auto-posting on (the approval could only exist there), and the switch not off.
  if (!pr || pr.reviewOn !== true || pr.postOn === false || pr.withdrawOn === false) return { kind: 'off' };
  if (pr.state !== 'open') return { kind: 'none' };
  // The latest unwithdrawn approval of ANOTHER head (only the latest can still stand).
  const approvals = [...(await loadLimnAutoApprovals(ctx, accountId, prId)).values()]
    .filter((x) => x.headSha !== headSha && x.withdrawal == null)
    .sort((x, y) => y.runId - x.runId);
  const approval = approvals[0];
  if (approval == null) return { kind: 'none' };
  // Never on the reader's own PR (GitHub refuses self-approval; nothing of Limn's can stand there).
  const me = await deps.accountUserId(accountId);
  if (me != null && pr.authorId === me) return { kind: 'none' };
  // LIVE: still the reader's standing review on GitHub?
  const [login, reviews] = await Promise.all([deps.accountLogin(accountId), deps.liveReviews(pr.owner, pr.name, pr.number)]);
  const { ownStandingReview } = await import('./auto-post.js');
  const standing = ownStandingReview(reviews, login, new Set(), new Set([approval.githubReviewId]));
  if (standing.state !== 'LIMN_AUTO_APPROVED' || standing.reviewId !== approval.githubReviewId) return { kind: 'not_standing' };
  const rec = await withdrawApproval(
    ctx,
    { accountId, prId, approval, why: 'push', headSha, message: withdrawMessageForPush(headSha) },
    (reviewId, message) => deps.dismissReview(accountId, pr.owner, pr.name, pr.number, reviewId, message),
  );
  if (rec == null) return { kind: 'claimed_elsewhere' };
  // SETTLE, THEN CASCADE (the post-write rule): a dismissal changes the PR's review decision.
  if (rec.status === 'withdrawn') await Promise.resolve(deps.settle({ accountId, prId })).catch(() => undefined);
  return { kind: 'done', record: rec };
}
