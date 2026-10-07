// "POST REPLY" FROM THE TAB — the manual twin of auto pushback / auto resolve for a reply status
// ('reply_disputed' / 'reply_accepted') on one of LIMN'S OWN earlier findings. CORE, local-only.
// docs/CLAUDE-REVIEW.md § Replies to Limn's findings.
//
// ⚠ IT WRITES THE SAME RECORD THE AUTO RUN DOES, CLAIMED THE SAME WAY, BEFORE THE GITHUB WRITE:
// `claude_review_findings.pushback` (disputed) or `.auto_resolve` (accepted) on the thread's OWNER
// row (the first inline-posted finding up the re-raise chain). So a remount, a second tab, a later
// run disputing the same thread, or an auto run finishing in the background can never put a second
// reply there — whichever claims first writes, the other gets a 409 (or, for the auto run, skips).
//   - A record that may have reached GitHub (anything but a CLEAR refusal) blocks it for good.
//   - A clearly refused one (`refused: true`) may be tried again by hand; the auto run never does.
//   - An accepted reply is answered AND resolved, exactly like auto resolve.
// The in-process `inFlight` set is claimed SYNCHRONOUSLY so two clicks cannot both pass the
// re-claim of a refused record (local-only feature: one process).
import { and, eq, isNull } from 'drizzle-orm';
import {
  FINDING_REPLY_MARKER,
  type FindingAutoResolveRecord,
  type FindingPushbackRecord,
  type FollowUpReplyResult,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getClaudeReviewById } from './persist.js';
import { findFindingThread } from './finding-thread.js';
import {
  PUSHBACK_MARKER,
  accountLoginOf,
  isClearReplyRefusal,
  loadPrThreads,
  loadThreadOwners,
  pushbackMayBePosted,
  resolveReplyMayBePosted,
  threadHasPushback,
  type ThreadOwnerRow,
} from './finding-replies.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const FINDING_REPLY_RE = /<!--\s*pierre:claude-review-finding/i;
const sameLogin = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The body "Post reply" sends: the text, then Limn's hidden marker (no auto footer — the reader
 *  pressed the button). The pushback marker blocks any later pushback on the thread. */
export function manualReplyBody(status: 'reply_accepted' | 'reply_disputed', text: string): string {
  return `${text.trim()}\n\n${status === 'reply_disputed' ? PUSHBACK_MARKER : FINDING_REPLY_MARKER}`;
}

export interface ManualReplyDeps {
  reply(
    accountId: number,
    thread: { id: number; nodeId: string; prId: number },
    body: string,
  ): Promise<{ commentId: string | null }>;
  resolve(accountId: number, threadNodeId: string): Promise<void>;
  stamp(threadId: number, accountId: number): Promise<void>;
  notePrChanged(accountId: number, prId: number): Promise<void>;
}

export const defaultManualReplyDeps: ManualReplyDeps = {
  async reply(accountId, thread, body) {
    const [{ getAccessToken, getAccountUserId }, { addReviewThreadReply }, q] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/mutations.js'),
      import('../../db/queries.js'),
    ]);
    const gh = await addReviewThreadReply(await getAccessToken(accountId), thread.nodeId, body);
    // GitHub has 201'd: the local stamps may fail, the write may not.
    try {
      const authorId = await getAccountUserId(accountId);
      await q.upsertLocalReply(thread.prId, thread.id, authorId, gh);
      await q.stampThreadRepliedState(thread.id);
    } catch {
      /* the next sync brings it */
    }
    return { commentId: gh.databaseId != null ? String(gh.databaseId) : null };
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
  async notePrChanged(accountId, prId) {
    const { notePrChangedForPr } = await import('../../sync/pr-settle.js');
    await notePrChangedForPr(accountId, prId);
  },
};

export type ManualReplyOutcome =
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: string; message: string }
  | { kind: 'done'; result: FollowUpReplyResult };

const inFlight = new Set<number>(); // thread OWNER finding ids

const conflict = (code: string, message: string): ManualReplyOutcome => ({ kind: 'conflict', code, message });

/** Post the reply a reply status drafted, on that finding's thread. Never posts twice. */
export async function postFollowUpReply(
  ctx: AgentContext,
  { accountId, reviewId, priorFindingId }: { accountId: number; reviewId: number; priorFindingId: number },
  deps: ManualReplyDeps = defaultManualReplyDeps,
): Promise<ManualReplyOutcome> {
  const review = await getClaudeReviewById(ctx, reviewId, accountId);
  if (!review || review.status !== 'succeeded') return { kind: 'not_found' };
  const item = review.followUp?.items.find((it) => it.priorFindingId === priorFindingId);
  if (!item || (item.status !== 'reply_accepted' && item.status !== 'reply_disputed')) return { kind: 'not_found' };
  const status = item.status;
  const text = (item.response ?? '').trim();
  if (!text) return conflict('NothingToPost', 'There is no reply to post.');
  const owners = await loadThreadOwners(ctx, accountId, review.prId, [priorFindingId]);
  const owner = owners.get(priorFindingId);
  if (!owner) return conflict('NoThread', 'This comment has no thread on GitHub.');
  // ⚠ SYNCHRONOUS claim of the process slot — no await between the check and the add.
  if (inFlight.has(owner.id)) return conflict('InProgress', 'Already posting this reply.');
  inFlight.add(owner.id);
  try {
    return await post(ctx, { accountId, reviewId, review, status, text, owner, acceptKind: item.acceptKind ?? null }, deps);
  } finally {
    inFlight.delete(owner.id);
  }
}

async function post(
  ctx: AgentContext,
  a: {
    accountId: number;
    reviewId: number;
    review: { prId: number; headSha: string };
    status: 'reply_accepted' | 'reply_disputed';
    text: string;
    owner: ThreadOwnerRow;
    acceptKind: FindingAutoResolveRecord['acceptKind'];
  },
  deps: ManualReplyDeps,
): Promise<ManualReplyOutcome> {
  const { accountId, reviewId, review, status, text, owner } = a;
  const disputed = status === 'reply_disputed';
  if (disputed ? pushbackMayBePosted(owner.pushback) : resolveReplyMayBePosted(owner.autoResolve)) {
    return conflict('AlreadyPosted', disputed ? 'Limn already pushed back on this thread.' : 'Limn already replied on this thread.');
  }
  const { threads, comments } = await loadPrThreads(ctx, review.prId);
  const login = await accountLoginOf(ctx, accountId);
  const thread = findFindingThread(owner, threads, comments, login, new Set<number>());
  if (!thread) return conflict('NoThread', 'The thread is not synced yet. Try again in a moment.');
  const list = comments.filter((c) => c.threadId === thread.id);
  if (disputed) {
    // ⚠ ONE PUSHBACK PER THREAD, EVER — whoever posted it.
    if (threadHasPushback(list, login)) return conflict('AlreadyPosted', 'Limn already pushed back on this thread.');
  } else {
    if (thread.isResolved) return conflict('AlreadyResolved', 'The thread is already resolved.');
    if (list.slice(1).some((c) => sameLogin(c.authorLogin, login) && FINDING_REPLY_RE.test(c.body ?? ''))) {
      return conflict('AlreadyPosted', 'Limn already replied on this thread.');
    }
  }

  const crf = s(ctx).claudeReviewFindings;
  const prior = disputed ? owner.pushback : owner.autoResolve;
  const claimed = async (value: FindingPushbackRecord | FindingAutoResolveRecord): Promise<boolean> => {
    const col = disputed ? crf.pushback : crf.autoResolve;
    const set = disputed ? { pushback: value } : { autoResolve: value };
    // From NULL: compare-and-set (an auto run may be claiming the same row). From a clearly
    // refused record: only this route re-claims one (the auto run needs NULL), and `inFlight`
    // holds out a second click.
    const where = prior == null ? and(eq(crf.id, owner.id), isNull(col)) : eq(crf.id, owner.id);
    const rows = (await ctx.db.update(crf).set(set).where(where).returning({ id: crf.id }).execute()) as Array<{ id: number }>;
    return rows.length > 0;
  };
  const record = async (value: object, extra: object = {}): Promise<void> => {
    await ctx.db
      .update(crf)
      .set({ [disputed ? 'pushback' : 'autoResolve']: value, ...extra })
      .where(eq(crf.id, owner.id))
      .execute()
      .catch((err: unknown) => ctx.log.warn(`follow-up reply finding ${owner.id}: could not record the result: ${errText(err)}`));
  };
  const threadRef = { id: thread.id, nodeId: thread.githubNodeId, prId: review.prId };
  const body = manualReplyBody(status, text);

  if (disputed) {
    const rec: FindingPushbackRecord = { status: 'posting', at: nowIso(), byReviewId: reviewId, commentId: null, error: null, manual: true };
    if (!(await claimed(rec))) return conflict('AlreadyPosted', 'Limn already pushed back on this thread.');
    try {
      const { commentId } = await deps.reply(accountId, threadRef, body);
      await record({ ...rec, status: 'posted', at: nowIso(), commentId });
      await deps.notePrChanged(accountId, review.prId).catch(() => {});
      return { kind: 'done', result: { status: 'posted', commentId, error: null } };
    } catch (err) {
      const refused = isClearReplyRefusal(err);
      await record({ ...rec, status: 'failed', at: nowIso(), error: errText(err), refused });
      return { kind: 'done', result: { status: 'failed', commentId: null, error: errText(err) } };
    }
  }

  const rec: FindingAutoResolveRecord = {
    status: 'resolving',
    at: nowIso(),
    outcome: 'reply_accepted',
    acceptKind: a.acceptKind ?? null,
    byReviewId: reviewId,
    headSha: review.headSha,
    replyCommentId: null,
    error: null,
    manual: true,
  };
  if (!(await claimed(rec))) return conflict('AlreadyPosted', 'Limn already replied on this thread.');
  let commentId: string | null;
  try {
    ({ commentId } = await deps.reply(accountId, threadRef, body));
  } catch (err) {
    await record({ ...rec, status: 'failed', at: nowIso(), error: errText(err), refused: isClearReplyRefusal(err) });
    return { kind: 'done', result: { status: 'failed', commentId: null, error: errText(err) } };
  }
  // The reply is on GitHub: from here nothing may fail the request.
  let final: FindingAutoResolveRecord = { ...rec, replyCommentId: commentId };
  let resolvedAt: Date | null = null;
  try {
    await deps.resolve(accountId, thread.githubNodeId);
    resolvedAt = new Date();
    final = { ...final, status: 'resolved', at: nowIso() };
    await deps.stamp(thread.id, accountId).catch(() => {});
  } catch (err) {
    final = { ...final, status: 'failed', at: nowIso(), error: errText(err) };
  }
  await record(final, resolvedAt ? { autoResolvedAt: resolvedAt } : {});
  await deps.notePrChanged(accountId, review.prId).catch(() => {});
  return {
    kind: 'done',
    result: { status: final.status === 'resolved' ? 'resolved' : 'posted', commentId, error: final.error },
  };
}
