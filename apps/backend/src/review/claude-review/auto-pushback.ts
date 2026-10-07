// AUTO PUSHBACK — after an AUTO Claude review SUCCEEDS, reply ONCE on the thread of one of LIMN'S
// OWN earlier findings when this run's follow-up disagreed with a person's reply there
// ('reply_disputed'). CORE, free, local-only like every agentic feature.
// docs/CLAUDE-REVIEW.md § Replies to Limn's findings.
//
// THE RULE, in order:
//   0. auto-posting is ON for the PR's workspace (`auto_post_enabled`; no separate switch); the run
//      is a SUCCEEDED AUTO run; the PR passes `autoPostEligibility`;
//   1. each follow-up item of THIS run with status 'reply_disputed' and a pushback text, whose
//      thread OWNER (the first inline-posted finding up the re-raise chain) has no pushback record;
//   2. its thread is found locally (finding-thread.ts) and carries no earlier Limn pushback (the
//      account's own login AND `PUSHBACK_MARKER`) — ⚠ AT MOST ONE PUSHBACK PER THREAD, EVER;
//   3. THE CLAIM — compare-and-set of `claude_review_findings.pushback` from NULL to
//      `status: 'posting'` BEFORE the GitHub write: never twice, never retried;
//   4. ONE reply: the pushback text, `AUTO_POST_FOOTER`, then `PUSHBACK_MARKER` (it starts with
//      Limn's `<!-- pierre:claude-review` prefix, so `isLimnPostedComment` knows it and it never
//      re-triggers an auto review). The thread is NOT resolved;
//   5. the record settles `posted` (+ the comment id) or `failed` with GitHub's error. Shown, never
//      retried. A later run may still ACCEPT a newer reply on the same thread.
// ⚠ Never throws.
import { and, eq, isNull } from 'drizzle-orm';
import { AUTO_POST_FOOTER, type FindingPushbackRecord } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { readWorkspaceAutoPostForPr } from './auto-settings.js';
import { autoPostEligibility, defaultAutoPostDeps, readAutoPostPrFacts, type AutoPostDeps } from './auto-post.js';
import { defaultAutoResolveDeps, type AutoResolveDeps } from './auto-resolve.js';
import { getClaudeReviewById } from './persist.js';
import { findFindingThread } from './finding-thread.js';
import {
  PUSHBACK_MARKER,
  isClearReplyRefusal,
  loadPrThreads,
  loadThreadOwners,
  threadHasPushback,
  type ThreadOwnerRow,
} from './finding-replies.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** The posted pushback: Claude's text, the footer, the marker. */
export function pushbackReplyBody(text: string): string {
  return `${text.trim()}\n\n${AUTO_POST_FOOTER}\n\n${PUSHBACK_MARKER}`;
}

export interface AutoPushbackResult {
  posted: number[];
  failed: number[];
}

/** Push back once per thread for ONE succeeded auto run. Never throws. */
export async function maybeAutoPushback(
  ctx: AgentContext,
  a: { accountId: number; prId: number; reviewId: number },
  postDeps: Pick<AutoPostDeps, 'isAutomation' | 'accountUserId' | 'accountLogin' | 'settle'> = defaultAutoPostDeps,
  deps: Pick<AutoResolveDeps, 'reply' | 'notePrChanged'> = defaultAutoResolveDeps,
): Promise<AutoPushbackResult | null> {
  try {
    return await autoPushback(ctx, a, postDeps, deps);
  } catch (err) {
    ctx.log.warn(`auto pushback review ${a.reviewId}: ${errText(err)}`);
    return null;
  }
}

async function autoPushback(
  ctx: AgentContext,
  { accountId, prId, reviewId }: { accountId: number; prId: number; reviewId: number },
  postDeps: Pick<AutoPostDeps, 'isAutomation' | 'accountUserId' | 'accountLogin' | 'settle'>,
  deps: Pick<AutoResolveDeps, 'reply' | 'notePrChanged'>,
): Promise<AutoPushbackResult | null> {
  const ws = await readWorkspaceAutoPostForPr(ctx, accountId, prId);
  if (!ws || !ws.settings.enabled) return null;
  const review = await getClaudeReviewById(ctx, reviewId, accountId);
  if (!review || review.prId !== prId || review.status !== 'succeeded' || review.trigger !== 'auto') return null;
  const wanted = new Map<number, string>();
  for (const it of review.followUp?.items ?? []) {
    const text = (it.response ?? '').trim();
    if (it.status === 'reply_disputed' && text) wanted.set(it.priorFindingId, text);
  }
  if (wanted.size === 0) return null;

  const facts = await readAutoPostPrFacts(ctx, postDeps, accountId, ws.workspaceId, prId);
  if (!facts || autoPostEligibility(facts, ws.settings.scope) != null) return null;

  const owners = await loadThreadOwners(ctx, accountId, prId, [...wanted.keys()]);
  const target = new Map<number, string>(); // owner id → pushback text (first wins)
  const ownerRows = new Map<number, ThreadOwnerRow>();
  for (const [wantedId, text] of wanted) {
    const row = owners.get(wantedId);
    if (!row || target.has(row.id)) continue;
    target.set(row.id, text);
    ownerRows.set(row.id, row);
  }
  const candidates = [...ownerRows.values()].filter((f) => f.pushback == null);
  if (candidates.length === 0) return null;

  const { threads, comments } = await loadPrThreads(ctx, prId);
  const accountLogin = await postDeps.accountLogin(accountId);
  const crf = s(ctx).claudeReviewFindings;
  const result: AutoPushbackResult = { posted: [], failed: [] };
  const taken = new Set<number>();
  let wroteAny = false;
  for (const f of candidates) {
    const thread = findFindingThread(f, threads, comments, accountLogin, taken);
    if (!thread) continue;
    taken.add(thread.id);
    // A RESOLVED thread is left alone: someone closed it, and a pushback there reopens nothing.
    if (thread.isResolved) continue;
    // ⚠ ONE PER THREAD, EVER: a pushback already on GitHub (posted by hand from the tab, or by a
    // run whose record was lost) blocks this one too.
    if (threadHasPushback(comments.filter((c) => c.threadId === thread.id), accountLogin)) continue;
    const rec: FindingPushbackRecord = { status: 'posting', at: nowIso(), byReviewId: reviewId, commentId: null, error: null };
    // ⚠ THE CLAIM, BEFORE ANY WRITE.
    const claimed = (await ctx.db
      .update(crf)
      .set({ pushback: rec })
      .where(and(eq(crf.id, f.id), isNull(crf.pushback)))
      .returning({ id: crf.id })
      .execute()) as Array<{ id: number }>;
    if (claimed.length === 0) continue;
    let final: FindingPushbackRecord;
    try {
      const { commentId } = await deps.reply(accountId, thread.githubNodeId, pushbackReplyBody(target.get(f.id)!));
      wroteAny = true;
      final = { ...rec, status: 'posted', at: nowIso(), commentId };
      result.posted.push(f.id);
    } catch (err) {
      final = { ...rec, status: 'failed', at: nowIso(), error: errText(err), refused: isClearReplyRefusal(err) };
      result.failed.push(f.id);
    }
    await ctx.db
      .update(crf)
      .set({ pushback: final })
      .where(eq(crf.id, f.id))
      .execute()
      .catch((err: unknown) => ctx.log.warn(`auto pushback finding ${f.id}: could not record the result: ${errText(err)}`));
  }
  if (wroteAny) {
    await deps.notePrChanged(accountId, [prId]).catch(() => {});
    await postDeps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  }
  return result;
}
