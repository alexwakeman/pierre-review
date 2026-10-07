// REPLIES TO LIMN'S OWN FINDINGS — what people wrote on the GitHub thread of an earlier POSTED
// finding, read so a re-review can judge the reply (accept it, or push back once). CORE, DB-only.
// docs/CLAUDE-REVIEW.md § Replies to Limn's findings.
//
// Which thread: the finding's own, or — when the finding is an unposted re-raise — the thread of
// its first INLINE-POSTED ancestor along `prior_finding_id` (`loadThreadOwners`, the walk auto
// resolve uses too), matched by the ONE matcher (finding-thread.ts `findFindingThread`).
//
// Which replies count (`humanReplies`): every comment after the thread's root that has text, whose
// author is a known login that is NOT automation (users.is_bot, github_type 'Bot', the login seeds
// — the same per-row predicate settled-by-reply's loader uses) and that Limn did NOT post (the
// account's own login AND the hidden `<!-- pierre:claude-review` marker — `isLimnPostedComment`'s
// marker half). The reader's OWN unmarked replies count: they are a person answering.
//
// Each reply is CLIPPED (REPLY_CHARS) and only the last REPLIES_MAX are kept. Everything here was
// written by people on an attacker-influenced pull request: prompts.ts fences it with the run's
// nonce as data, never instructions.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { PUSHBACK_REPLY_MARKER, type FindingAutoResolveRecord, type FindingPushbackRecord } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { automationVendorFor, isLikelyBot } from '../../sync/bot-detection.js';
import { findFindingThread, type ThreadComment, type ThreadRow } from './finding-thread.js';
import type { FindingReply } from './reply-text.js';
export { REPLY_EXCERPT_CHARS, RESPONSE_CHARS, judgeableReplies, replyExcerpt, type FindingReply } from './reply-text.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const sch = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const REPLY_CHARS = 1_500;
export const REPLIES_MAX = 5;

// The same prefix `isLimnPostedComment` reads (db/review-threads-for-review.ts).
const LIMN_MARKER = /<!--\s*pierre:claude-review/i;
// Every pushback reply carries this (it starts with Limn's prefix, so it is Limn-posted too). Its
// presence on a thread means a pushback is already there: never post another.
export const PUSHBACK_MARKER = PUSHBACK_REPLY_MARKER;
const PUSHBACK_RE = /<!--\s*pierre:claude-review-pushback/i;

const norm = (s: string): string => s.replace(/\r\n?/g, '\n').trim();
const sameLogin = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();


/** A synced thread comment with its author's automation flag. */
export interface ReplyComment extends ThreadComment {
  authorIsAutomation: boolean;
}

/** Automation by the stored flags, plus the login seeds (a row synced before its login joined them). */
export function isAutomationAuthor(r: {
  authorLogin: string | null;
  authorIsBot: boolean | null;
  authorType: string | null;
}): boolean {
  const login = r.authorLogin ?? null;
  return (
    !!r.authorIsBot ||
    r.authorType === 'Bot' ||
    (login != null && (isLikelyBot(login) || automationVendorFor(login) != null))
  );
}

/** A comment Limn posted: the account's own login AND the hidden marker. */
export function isLimnMarked(c: Pick<ThreadComment, 'body' | 'authorLogin'>, accountLogin: string | null): boolean {
  return sameLogin(c.authorLogin, accountLogin) && LIMN_MARKER.test(c.body ?? '');
}

/** Has Limn already pushed back on this thread? (its own login AND the pushback marker) */
export function threadHasPushback(
  comments: readonly Pick<ThreadComment, 'body' | 'authorLogin'>[],
  accountLogin: string | null,
): boolean {
  return comments.some((c) => sameLogin(c.authorLogin, accountLogin) && PUSHBACK_RE.test(c.body ?? ''));
}

/**
 * Did GitHub clearly turn a thread reply down, so that nothing was created? A GraphQL error answer
 * (the mutation did not run) or an HTTP 4xx other than 401/429. Everything else — a 5xx, a network
 * error, a reply GitHub answered without a comment — is UNCLEAR: the reply may be on the thread, so
 * it is never offered again.
 */
export function isClearReplyRefusal(err: unknown): boolean {
  const e = err as { status?: unknown; name?: unknown; errors?: unknown } | null;
  if (e && e.name === 'GraphqlResponseError' && Array.isArray(e.errors)) return true;
  const status = e?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429 && status !== 401;
}

/** Could this pushback record be on GitHub? Everything except a clear refusal counts (a
 *  `posting` record cut off mid-write counts forever). */
export function pushbackMayBePosted(rec: FindingPushbackRecord | null | undefined): boolean {
  return rec != null && !(rec.status === 'failed' && rec.refused === true);
}

/** Could this auto-resolve record have put a reply on the thread? (as above, for the reply half) */
export function resolveReplyMayBePosted(rec: FindingAutoResolveRecord | null | undefined): boolean {
  return rec != null && !(rec.status === 'failed' && rec.replyCommentId == null && rec.refused === true);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * The conversation in ONE thread after its root (comments oldest first; the first is the root,
 * never a reply): not automation, with text. Limn-posted replies (the account's login + marker —
 * a reply posted from the Claude Review tab, or an earlier auto reply) are KEPT as context and
 * flagged `fromLimn`; only the others can be judged (`judgeableReplies`). The last REPLIES_MAX,
 * each clipped to REPLY_CHARS.
 */
export function humanReplies(
  commentsOldestFirst: readonly ReplyComment[],
  accountLogin: string | null,
): FindingReply[] {
  const out: FindingReply[] = [];
  for (const c of commentsOldestFirst.slice(1)) {
    if (!c.authorLogin || c.authorIsAutomation) continue;
    const fromLimn = isLimnMarked(c, accountLogin);
    // Strip the hidden marker / footer comment from a Limn reply: it is noise to the model.
    const body = norm((c.body ?? '').replace(/<!--[\s\S]*?-->/g, ''));
    if (!body) continue;
    out.push({
      author: c.authorLogin,
      body: clip(body, REPLY_CHARS),
      at: new Date(c.createdAt).toISOString(),
      ...(fromLimn ? { fromLimn: true } : {}),
    });
  }
  return out.slice(-REPLIES_MAX);
}


// ---- DB ----

/** The finding row that owns a thread: the first inline-posted one up the re-raise chain. */
export interface ThreadOwnerRow {
  id: number;
  path: string;
  body: string;
  editedBody: string | null;
  githubCommentId: string | null;
  postedAt: unknown;
  postedCommentKind: 'inline' | 'pr_comment' | null;
  autoResolve: FindingAutoResolveRecord | null;
  pushback: FindingPushbackRecord | null;
  priorFindingId: number | null;
}

/**
 * For each id: the first INLINE-POSTED finding along its `prior_finding_id` chain (itself first),
 * owned by this account and PR. A follow-up names the LATEST raise of an issue, and a re-raise over
 * an already-posted comment is never posted itself, so the thread on GitHub belongs to an ANCESTOR.
 * Cycle-guarded; an id with no such ancestor is absent.
 */
export async function loadThreadOwners(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  ids: readonly number[],
): Promise<Map<number, ThreadOwnerRow>> {
  const t = sch(ctx);
  const cr = t.claudeReviews;
  const crf = t.claudeReviewFindings;
  const loadRows = async (want: number[]): Promise<ThreadOwnerRow[]> =>
    want.length === 0
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
            pushback: crf.pushback,
            priorFindingId: crf.priorFindingId,
          })
          .from(crf)
          .innerJoin(cr, eq(cr.id, crf.reviewId))
          .where(and(inArray(crf.id, want), eq(cr.accountId, accountId), eq(cr.prId, prId)))
          .execute()) as ThreadOwnerRow[]);
  const isInlinePosted = (f: ThreadOwnerRow): boolean => f.postedAt != null && f.postedCommentKind === 'inline';
  const byId = new Map<number, ThreadOwnerRow>();
  const out = new Map<number, ThreadOwnerRow>();
  const cursor = new Map<number, number>(ids.map((id) => [id, id]));
  const visited = new Map<number, Set<number>>(ids.map((id) => [id, new Set<number>()]));
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
        out.set(wantedId, row);
        cursor.delete(wantedId);
      } else if (row.priorFindingId != null) {
        cursor.set(wantedId, row.priorFindingId);
      } else {
        cursor.delete(wantedId);
      }
    }
  }
  return out;
}

/** Every review thread of the PR and every comment in them (oldest first), with automation flags. */
export async function loadPrThreads(
  ctx: AgentContext,
  prId: number,
): Promise<{ threads: ThreadRow[]; comments: ReplyComment[] }> {
  const t = sch(ctx);
  const threads = (await ctx.db
    .select({
      id: t.reviewThreads.id,
      githubNodeId: t.reviewThreads.githubNodeId,
      path: t.reviewThreads.path,
      isResolved: t.reviewThreads.isResolved,
      resolvedByLogin: t.reviewThreads.resolvedByLogin,
    })
    .from(t.reviewThreads)
    .where(eq(t.reviewThreads.prId, prId))
    .execute()) as ThreadRow[];
  const rows = (await ctx.db
    .select({
      threadId: t.reviewComments.threadId,
      databaseId: t.reviewComments.databaseId,
      body: t.reviewComments.body,
      excerpt: t.reviewComments.excerpt,
      authorLogin: t.users.githubLogin,
      authorIsBot: t.users.isBot,
      authorType: t.users.githubType,
      createdAt: t.reviewComments.createdAt,
      id: t.reviewComments.id,
    })
    .from(t.reviewComments)
    .leftJoin(t.users, eq(t.users.id, t.reviewComments.authorId))
    .where(eq(t.reviewComments.prId, prId))
    .orderBy(asc(t.reviewComments.createdAt), asc(t.reviewComments.id))
    .execute()) as Array<{
    threadId: number;
    databaseId: string | null;
    body: string | null;
    excerpt: string | null;
    authorLogin: string | null;
    authorIsBot: boolean | null;
    authorType: string | null;
    createdAt: Date | null;
    id: number;
  }>;
  const comments: ReplyComment[] = rows.map((r) => ({
    threadId: r.threadId,
    databaseId: r.databaseId ?? null,
    body: r.body ?? r.excerpt ?? null,
    authorLogin: r.authorLogin ?? null,
    createdAt: r.createdAt?.getTime?.() ?? 0,
    authorIsAutomation: isAutomationAuthor(r),
  }));
  return { threads, comments };
}

/** One earlier finding's GitHub thread, as the follow-up and the auto writes read it. */
export interface FindingThreadContext {
  threadId: number;
  threadNodeId: string;
  // The finding row that owns the thread (where auto resolve / the pushback are recorded).
  threadFindingId: number;
  isResolved: boolean;
  // Who resolved it, when the sync recorded it (null = unresolved or not known).
  resolvedBy: string | null;
  replies: FindingReply[];
  // Limn already posted its one pushback here (a record on the owner row, or the marker on GitHub).
  pushedBack: boolean;
}

/**
 * The thread of each earlier finding (by id), with the people's replies. A finding with no inline
 * thread found is absent. Two findings never share a thread unless they share an owner row.
 */
export async function loadFindingThreadContexts(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  findingIds: readonly number[],
  accountLogin: string | null,
): Promise<Map<number, FindingThreadContext>> {
  const out = new Map<number, FindingThreadContext>();
  if (findingIds.length === 0) return out;
  const owners = await loadThreadOwners(ctx, accountId, prId, findingIds);
  if (owners.size === 0) return out;
  const { threads, comments } = await loadPrThreads(ctx, prId);
  if (threads.length === 0) return out;
  const byThread = new Map<number, ReplyComment[]>();
  for (const c of comments) {
    const list = byThread.get(c.threadId) ?? [];
    list.push(c);
    byThread.set(c.threadId, list);
  }
  const taken = new Set<number>();
  const byOwner = new Map<number, FindingThreadContext | null>();
  for (const id of findingIds) {
    const owner = owners.get(id);
    if (!owner) continue;
    if (!byOwner.has(owner.id)) {
      const thread = findFindingThread(owner, threads, comments, accountLogin, taken);
      if (!thread) {
        byOwner.set(owner.id, null);
      } else {
        taken.add(thread.id);
        const list = byThread.get(thread.id) ?? [];
        byOwner.set(owner.id, {
          threadId: thread.id,
          threadNodeId: (thread as ThreadRow).githubNodeId,
          threadFindingId: owner.id,
          isResolved: !!thread.isResolved,
          resolvedBy: thread.isResolved ? (thread.resolvedByLogin ?? null) : null,
          replies: humanReplies(list, accountLogin),
          pushedBack: pushbackMayBePosted(owner.pushback) || threadHasPushback(list, accountLogin),
        });
      }
    }
    const ctxFor = byOwner.get(owner.id);
    if (ctxFor) out.set(id, ctxFor);
  }
  return out;
}

/** The account's own GitHub login (the author half of "Limn posted it"). */
export async function accountLoginOf(ctx: AgentContext, accountId: number): Promise<string | null> {
  const a = sch(ctx).accounts;
  const rows = (await ctx.db
    .select({ login: a.githubLogin })
    .from(a)
    .where(eq(a.id, accountId))
    .limit(1)
    .execute()) as Array<{ login: string | null }>;
  return rows[0]?.login ?? null;
}

/**
 * Attach each earlier finding's thread + replies (`PriorFindingForFollowUp.thread`). A failure
 * costs the replies only, never the review: the findings are then followed up as before.
 */
export async function attachFindingThreads<
  F extends {
    id: number;
    thread?: {
      threadId: number;
      threadFindingId: number;
      replies: FindingReply[];
      pushedBack: boolean;
      isResolved?: boolean;
      resolvedBy?: string | null;
    } | null;
  },
>(ctx: AgentContext, accountId: number, prId: number, findings: F[]): Promise<F[]> {
  if (findings.length === 0) return findings;
  try {
    const login = await accountLoginOf(ctx, accountId);
    const byId = await loadFindingThreadContexts(
      ctx,
      accountId,
      prId,
      findings.map((f) => f.id),
      login,
    );
    return findings.map((f) => {
      const t = byId.get(f.id);
      return t
        ? {
            ...f,
            thread: {
              threadId: t.threadId,
              threadFindingId: t.threadFindingId,
              replies: t.replies,
              pushedBack: t.pushedBack,
              isResolved: t.isResolved,
              resolvedBy: t.resolvedBy,
            },
          }
        : f;
    });
  } catch (err) {
    ctx.log.warn(`claude review pr ${prId}: replies not read: ${err instanceof Error ? err.message : String(err)}`);
    return findings;
  }
}
