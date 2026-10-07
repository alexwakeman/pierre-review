// AUTO RESOLVE — after an AUTO Claude review SUCCEEDS, close the threads of LIMN'S OWN earlier
// findings that this run's follow-up judged fixed (CORE, free, local-only like every agentic
// feature). docs/CLAUDE-REVIEW.md § Auto-posting → Auto resolve.
//
// ⚠ A DELIBERATE EXCEPTION to "no automatic resolve" (bot-triage/resolve.ts): it touches ONLY a
// thread Limn itself started — an inline finding comment posted from a Claude review, authored by
// the account's own login AND carrying the hidden `<!-- pierre:claude-review` marker
// (`isLimnPostedComment`). Never another reviewer's thread, never a person's, never a bot's.
//
// THE RULE, in order:
//   0. auto-posting is ON for the PR's workspace AND its `autoResolve` switch is on (both OFF by
//      default); the run is a SUCCEEDED AUTO run; the PR passes `autoPostEligibility` (open, not a
//      draft, not bot-authored, in scope);
//   1. each follow-up item of THIS run whose status is 'addressed' or 'no_longer_applies', whose
//      earlier finding — or, when that one is an unposted RE-RAISE, its first inline-posted
//      ancestor along `prior_finding_id` — was POSTED INLINE and has no auto-resolve record yet;
//   2. its thread is found locally (the stored comment id, else the root comment's body + path +
//      Limn's provenance) and is still unresolved — otherwise nothing is recorded (a later run may);
//   3. THE CLAIM — compare-and-set of `claude_review_findings.auto_resolve` from NULL to
//      `status: 'resolving'` BEFORE any GitHub write: never twice, never retried;
//   4. a short reply ("Addressed in abc1234." / "No longer applies as of abc1234.") with the
//      auto-post footer + the finding marker, THEN the resolve through the same mutation the manual
//      resolve uses, then `stampThreadResolved` and the PR change signal;
//   5. the record settles `resolved` (+ `auto_resolved_at`) or `failed` with GitHub's error (a
//      permission refusal, a deleted thread…). A failure is shown, never retried.
// ⚠ Never throws.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  AUTO_POST_FOOTER,
  type ClaudeFollowUpStatus,
  type FindingAutoResolveRecord,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { readWorkspaceAutoPostForPr } from './auto-settings.js';
import { autoPostEligibility, defaultAutoPostDeps, readAutoPostPrFacts, type AutoPostDeps } from './auto-post.js';
import { getClaudeReviewById } from './persist.js';
import { findFindingThread, type ThreadComment, type ThreadRow } from './finding-thread.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
// post-review.ts FINDING_COMMENT_MARKER — the reply sits in a finding thread, so it wears the
// finding spelling (inlined: post-review.ts pulls in the GitHub client at import).
const FINDING_MARKER = '<!-- pierre:claude-review-finding v=1 -->';

export type AutoResolveOutcome = FindingAutoResolveRecord['outcome'];

/** Which follow-up statuses close a thread. */
export function resolvableStatus(status: ClaudeFollowUpStatus): AutoResolveOutcome | null {
  return status === 'addressed' || status === 'no_longer_applies' ? status : null;
}

/** The reply posted on the thread before it is resolved. */
export function autoResolveReplyBody(outcome: AutoResolveOutcome, headSha: string): string {
  const short = headSha.slice(0, 7);
  const lead = outcome === 'addressed' ? `Addressed in ${short}.` : `No longer applies as of ${short}.`;
  return `${lead}\n\n${AUTO_POST_FOOTER}\n\n${FINDING_MARKER}`;
}

// The thread matcher is shared with the review read (`ClaudeFinding.threadId`).
export { findFindingThread, type ThreadComment, type ThreadRow } from './finding-thread.js';

/** The pieces that touch GitHub, so a test can replace them. */
export interface AutoResolveDeps {
  reply(accountId: number, threadNodeId: string, body: string): Promise<{ commentId: string | null }>;
  resolve(accountId: number, threadNodeId: string): Promise<void>;
  stamp(threadId: number, accountId: number): Promise<void>;
  notePrChanged(accountId: number, prIds: number[]): Promise<void>;
}

export const defaultAutoResolveDeps: AutoResolveDeps = {
  async reply(accountId, threadNodeId, body) {
    const [{ getAccessToken }, { addReviewThreadReply }] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/mutations.js'),
    ]);
    const c = await addReviewThreadReply(await getAccessToken(accountId), threadNodeId, body);
    return { commentId: c.databaseId != null ? String(c.databaseId) : null };
  },
  async resolve(accountId, threadNodeId) {
    const [{ getAccessToken }, { setReviewThreadResolved }] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/mutations.js'),
    ]);
    await setReviewThreadResolved(await getAccessToken(accountId), threadNodeId, true);
  },
  async stamp(threadId, accountId) {
    const { stampThreadResolved } = await import('../../db/queries.js');
    await stampThreadResolved(threadId, true, accountId);
  },
  async notePrChanged(accountId, prIds) {
    const { notePrChangedForPrs } = await import('../../sync/pr-settle.js');
    await notePrChangedForPrs(accountId, prIds);
  },
};

export interface AutoResolveResult {
  resolved: number[];
  failed: number[];
}

/**
 * Close Limn's own fixed threads for ONE succeeded auto run. Called by `maybeAutoPostReview` after
 * it posts (or skips). Never throws.
 */
export async function maybeAutoResolveFindings(
  ctx: AgentContext,
  a: { accountId: number; prId: number; reviewId: number },
  postDeps: Pick<AutoPostDeps, 'isAutomation' | 'accountUserId' | 'accountLogin' | 'settle'> = defaultAutoPostDeps,
  deps: AutoResolveDeps = defaultAutoResolveDeps,
): Promise<AutoResolveResult | null> {
  try {
    return await autoResolve(ctx, a, postDeps, deps);
  } catch (err) {
    ctx.log.warn(`auto resolve review ${a.reviewId}: ${errText(err)}`);
    return null;
  }
}

async function autoResolve(
  ctx: AgentContext,
  { accountId, prId, reviewId }: { accountId: number; prId: number; reviewId: number },
  postDeps: Pick<AutoPostDeps, 'isAutomation' | 'accountUserId' | 'accountLogin' | 'settle'>,
  deps: AutoResolveDeps,
): Promise<AutoResolveResult | null> {
  const ws = await readWorkspaceAutoPostForPr(ctx, accountId, prId);
  if (!ws || !ws.settings.enabled || !ws.settings.autoResolve) return null;
  const review = await getClaudeReviewById(ctx, reviewId, accountId);
  if (!review || review.prId !== prId || review.status !== 'succeeded' || review.trigger !== 'auto') return null;
  const wanted = new Map<number, AutoResolveOutcome>();
  for (const it of review.followUp?.items ?? []) {
    const outcome = resolvableStatus(it.status);
    if (outcome) wanted.set(it.priorFindingId, outcome);
  }
  if (wanted.size === 0) return null;

  const facts = await readAutoPostPrFacts(ctx, postDeps, accountId, ws.workspaceId, prId);
  if (!facts || autoPostEligibility(facts, ws.settings.scope) != null) return null;

  const t = s(ctx);
  const cr = t.claudeReviews;
  const crf = t.claudeReviewFindings;
  // The earlier findings, owned by this account and this PR (the follow-up ids are soft refs).
  // ⚠ A follow-up names the LATEST raise of an issue, and a re-raise over an already-posted
  // comment is never posted itself (the dedupe), so the thread on GitHub belongs to an ANCESTOR.
  // Walk `prior_finding_id` back (cycle-guarded) to the first inline-posted ancestor and resolve
  // THAT row's thread.
  type FindingRowAR = {
    id: number;
    path: string;
    body: string;
    editedBody: string | null;
    githubCommentId: string | null;
    postedAt: unknown;
    postedCommentKind: 'inline' | 'pr_comment' | null;
    autoResolve: FindingAutoResolveRecord | null;
    priorFindingId: number | null;
  };
  const loadRows = async (ids: number[]): Promise<FindingRowAR[]> =>
    ids.length === 0
      ? []
      : ((await ctx.db
          .select({
            id: crf.id,
            path: crf.path,
            body: crf.body,
            editedBody: crf.editedBody,
            githubCommentId: crf.githubCommentId,
            postedAt: crf.postedAt,
            postedCommentKind: crf.postedCommentKind,
            autoResolve: crf.autoResolve,
            priorFindingId: crf.priorFindingId,
          })
          .from(crf)
          .innerJoin(cr, eq(cr.id, crf.reviewId))
          .where(and(inArray(crf.id, ids), eq(cr.accountId, accountId), eq(cr.prId, prId)))
          .execute()) as FindingRowAR[]);
  const isInlinePosted = (f: FindingRowAR): boolean => f.postedAt != null && f.postedCommentKind === 'inline';
  const byId = new Map<number, FindingRowAR>();
  // wanted id → the row currently examined on its chain.
  const cursor = new Map<number, number>([...wanted.keys()].map((id) => [id, id]));
  const visited = new Map<number, Set<number>>([...wanted.keys()].map((id) => [id, new Set<number>()]));
  const target = new Map<number, AutoResolveOutcome>(); // ancestor id → outcome (first wins)
  for (let hop = 0; hop < 50 && cursor.size > 0; hop += 1) {
    const need = [...new Set(cursor.values())].filter((id) => !byId.has(id));
    for (const r of await loadRows(need)) byId.set(r.id, r);
    for (const [wantedId, at] of [...cursor]) {
      const row = byId.get(at);
      const seen = visited.get(wantedId)!;
      if (!row || seen.has(at)) {
        cursor.delete(wantedId);
        continue;
      }
      seen.add(at);
      if (isInlinePosted(row)) {
        if (!target.has(row.id)) target.set(row.id, wanted.get(wantedId)!);
        cursor.delete(wantedId);
      } else if (row.priorFindingId != null) {
        cursor.set(wantedId, row.priorFindingId);
      } else {
        cursor.delete(wantedId);
      }
    }
  }
  const candidates = [...target.keys()]
    .map((id) => byId.get(id)!)
    .filter((f) => f.autoResolve == null);
  if (candidates.length === 0) return null;

  const threads = (await ctx.db
    .select({ id: t.reviewThreads.id, githubNodeId: t.reviewThreads.githubNodeId, path: t.reviewThreads.path, isResolved: t.reviewThreads.isResolved })
    .from(t.reviewThreads)
    .where(eq(t.reviewThreads.prId, prId))
    .execute()) as ThreadRow[];
  const commentRows = (await ctx.db
    .select({
      threadId: t.reviewComments.threadId,
      databaseId: t.reviewComments.databaseId,
      body: t.reviewComments.body,
      authorLogin: t.users.githubLogin,
      createdAt: t.reviewComments.createdAt,
    })
    .from(t.reviewComments)
    .leftJoin(t.users, eq(t.users.id, t.reviewComments.authorId))
    .where(eq(t.reviewComments.prId, prId))
    .orderBy(asc(t.reviewComments.createdAt))
    .execute()) as Array<Omit<ThreadComment, 'createdAt'> & { createdAt: Date | null }>;
  const comments: ThreadComment[] = commentRows.map((c) => ({ ...c, createdAt: c.createdAt?.getTime?.() ?? 0 }));
  const accountLogin = await postDeps.accountLogin(accountId);

  const result: AutoResolveResult = { resolved: [], failed: [] };
  const taken = new Set<number>();
  let wroteAny = false;
  for (const f of candidates) {
    const thread = findFindingThread(f, threads, comments, accountLogin, taken);
    if (!thread || thread.isResolved) continue;
    taken.add(thread.id);
    const outcome = target.get(f.id)!;
    const rec: FindingAutoResolveRecord = {
      status: 'resolving',
      at: nowIso(),
      outcome,
      byReviewId: reviewId,
      headSha: review.headSha,
      replyCommentId: null,
      error: null,
    };
    // ⚠ THE CLAIM, BEFORE ANY WRITE.
    const claimed = (await ctx.db
      .update(crf)
      .set({ autoResolve: rec })
      .where(and(eq(crf.id, f.id), isNull(crf.autoResolve)))
      .returning({ id: crf.id })
      .execute()) as Array<{ id: number }>;
    if (claimed.length === 0) continue;

    let final: FindingAutoResolveRecord = rec;
    let resolvedAt: Date | null = null;
    try {
      const { commentId } = await deps.reply(accountId, thread.githubNodeId, autoResolveReplyBody(outcome, review.headSha));
      wroteAny = true;
      final = { ...final, replyCommentId: commentId };
      try {
        await deps.resolve(accountId, thread.githubNodeId);
        resolvedAt = new Date();
        final = { ...final, status: 'resolved', at: nowIso() };
        await deps.stamp(thread.id, accountId).catch((err) =>
          ctx.log.warn(`auto resolve finding ${f.id}: could not stamp the thread: ${errText(err)}`),
        );
      } catch (err) {
        final = { ...final, status: 'failed', at: nowIso(), error: errText(err) };
      }
    } catch (err) {
      final = { ...final, status: 'failed', at: nowIso(), error: errText(err) };
    }
    (final.status === 'resolved' ? result.resolved : result.failed).push(f.id);
    await ctx.db
      .update(crf)
      .set({ autoResolve: final, ...(resolvedAt ? { autoResolvedAt: resolvedAt } : {}) })
      .where(eq(crf.id, f.id))
      .execute()
      .catch((err: unknown) => ctx.log.warn(`auto resolve finding ${f.id}: could not record the result: ${errText(err)}`));
  }
  if (wroteAny) {
    await deps.notePrChanged(accountId, [prId]).catch(() => {});
    await postDeps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  }
  return result;
}
