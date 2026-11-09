// STILL-OPEN POINTS ON GITHUB (docs/CLAUDE-REVIEW.md § Still-open points, 2026-11-05).
//
// A posted Limn review (auto-posting, or a manual "Review and post") that judged an EARLIER point
// not (or only partly) addressed says so ON THAT THREAD, so the PR author can find every point the
// review holds open. A review kept in Limn writes nothing.
//
// WHICH POINTS (`stillOpenCandidates`, pure; the ONE rule is shared `isStillOpenFollowUp` /
// `isStillOpenThread`):
//   • a follow-up item `not_addressed` / `partly_addressed` on an earlier Limn finding with a thread
//     (the reader's own or a teammate's). `reply_disputed` too, but ONLY on a RESOLVED thread (gap 2):
//     on an unresolved one the ONE pushback reply (auto-pushback.ts) already answers it, and pushback
//     never writes on a resolved thread — so a resolved, disputed point is said here, like any other;
//   • a thread judgement whose comment holds up (valid / partly valid) and is not (or partly)
//     addressed, on a PERSON'S thread or a teammate's Limn thread. Another review bot's thread
//     (CodeRabbit, Copilot…) is left alone.
//   A pair: both halves, the later half's word on a thread wins (as for the marker's `j=`).
//
// WHAT IS WRITTEN, per thread (`planStillOpen`, pure):
//   • UNRESOLVED: ONE reply "**Still open:** <reason>" — at most one per thread per head (a reply at
//     this head by ANY Limn, read from its marker, counts).
//   • RESOLVED, never reopened: the reply (unless one is already there at this head), then UNRESOLVE.
//     ⚠ AT MOST ONCE PER THREAD, EVER: the `reopen:` claim here, AND any Limn reply on the thread
//     whose marker says `r=1` (a teammate's Limn reopened it) — a second Limn never reopens again.
//   • RESOLVED, reopened once already: a WARNING or BLOCKER starts ONE new inline thread about the
//     same point (`c=` names the earlier thread's root comment; once per thread, ever, by any Limn);
//     a nit, a question or a point with no known severity is left as it is. ⚠ A CONTINUATION thread
//     (its root carries `c=`) is never continued again: one new thread per point, ever.
//   • ⚠ A THREAD THE READER RESOLVED (2026-11-09): nothing at all — a person's resolve is their
//     decision. Limn shows "Not addressed · Resolved" and what is still needed in Limn only, and the
//     reader can press to post it (manual-reply.ts, "Post still open").
//   • ⚠ THE READER'S OWN PR (decision D2): never a reopen, never a new thread. The reply only: once
//     per head on an unresolved thread, ONCE EVER on a resolved one (any Limn's still-open reply there,
//     or this account's reply claim, counts).
//
// ⚠ READ GITHUB LIVE BEFORE EVERY WRITE (gap 3): two Limns at the same head may both act before
// either synced the other. Just before a thread's writes, ONE small GraphQL read of that thread (its
// resolved state, its comments' markers, and the PR's thread roots for `c=`) — outside any
// transaction — is folded into the facts (`mergeLiveFacts`) and the plan is made again. A FAILED read
// writes nothing: it is recorded as this head's reply claim, `failed`, with why. Never guessed.
//
// CONTINUATIONS (gap 8): later runs judge the continuation, not the earlier thread — the follow-up
// (finding-replies.ts) and the thread loader (db/review-threads-for-review.ts) follow shared
// `continuationThreadMap`, so the run's judgement, this file's writes and the author's still-open
// card all land on the continuation.
//
// ⚠ CLAIM BEFORE EVERY WRITE: a row in `claude_still_open_posts` (the unique claim key is the
// compare-and-set) BEFORE the GitHub call, then settled `posted` / `failed` with GitHub's words.
// NEVER RETRIED. A new thread refused because the head moved wrote nothing, so its claim is released.
// No transaction spans a fetch. Then the PR change signal and `settlePrAfterWrite`.
// ⚠ Never throws.
import { and, eq, inArray } from 'drizzle-orm';
import {
  aiRunProviderName,
  autoPostFooter,
  isStillOpenFollowUp,
  isStillOpenThread,
  limnFindingPost,
  PAIR_AUTO_POST_FOOTER,
  parseStillOpenMarker,
  STILL_OPEN_LEAD,
  stillOpenMarker,
  stillOpenReasonText,
  type ClaudeFindingSeverity,
  type ClaudeReview,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import type { PostFindingArgs, PostFindingOutcome } from '../../platform/contract.js';
import { getClaudeReviewById } from './persist.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const sch = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
// post-review.ts FINDING_COMMENT_MARKER (inlined: post-review.ts pulls in the GitHub client at import).
const FINDING_MARKER = '<!-- pierre:claude-review-finding v=1 -->';

export type StillOpenSeverity = Exclude<ClaudeFindingSeverity, 'praise'>;

/** One point a run holds open, on one thread. */
export interface StillOpenCandidate {
  threadId: number;
  // The reason as written by the model (made safe and short before it is posted).
  reason: string | null;
  severity: StillOpenSeverity | null;
  source: 'follow_up' | 'thread';
  // follow_up only: the earlier finding (its re-raise in this run, if any, gives the new location).
  priorFindingId?: number | null;
  // follow_up only: Limn disputed the reply (`reply_disputed`). Written ONLY on a resolved thread.
  disputed?: boolean;
}

type JudgingRun = Pick<ClaudeReview, 'followUp' | 'threadAssessments'>;

const sev = (s: string | null | undefined): StillOpenSeverity | null =>
  s === 'blocker' || s === 'warning' || s === 'nit' || s === 'question' ? s : null;

/**
 * The points the run(s) hold open, one per thread (THE RULE in the header). `limnRoots`: the threads
 * whose root is a Limn finding, with its lead's severity. Pure.
 */
export function stillOpenCandidates(
  runs: readonly JudgingRun[],
  limnRoots: ReadonlyMap<number, { severity: StillOpenSeverity | null }>,
): StillOpenCandidate[] {
  // threadId → the point, or null when a later word on the thread does not hold it open.
  const out = new Map<number, StillOpenCandidate | null>();
  for (const r of runs) {
    const mine = new Map<number, StillOpenCandidate | null>();
    for (const a of r.threadAssessments ?? []) {
      if (a == null || typeof a.threadId !== 'number') continue;
      if (a.validity === 'not_checked' && a.addressed === 'not_checked') continue;
      const limn = limnRoots.get(a.threadId);
      if (!isStillOpenThread(a) || (limn == null && a.authorIsBot)) {
        mine.set(a.threadId, null);
        continue;
      }
      mine.set(a.threadId, {
        threadId: a.threadId,
        reason: (a.reason ?? '').trim() || a.explanation,
        severity: limn?.severity ?? null,
        source: 'thread',
      });
    }
    // The follow-up's word on a Limn finding's thread wins over a thread judgement of it.
    for (const it of r.followUp?.items ?? []) {
      const threadId = it?.threadId;
      if (typeof threadId !== 'number' || it.status === 'not_checked') continue;
      if (!isStillOpenFollowUp(it.status)) {
        mine.set(threadId, null);
        continue;
      }
      mine.set(threadId, {
        threadId,
        // The one-line "how" (what is still needed) first; the explanation on an older row.
        reason: (it.how ?? '').trim() || it.explanation,
        severity: sev(it.severity),
        source: 'follow_up',
        priorFindingId: it.priorFindingId,
        ...(it.status === 'reply_disputed' ? { disputed: true } : {}),
      });
    }
    for (const [k, v] of mine) out.set(k, v);
  }
  return [...out.values()].filter((c): c is StillOpenCandidate => c != null).sort((a, b) => a.threadId - b.threadId);
}

/** What is already on GitHub about a thread (any Limn's marker) and in this account's claims. */
export interface StillOpenThreadFacts {
  resolved: boolean;
  reopenedBefore: boolean;
  repliedAtHead: boolean;
  // Any Limn's still-open reply on the thread, at any head (or this account's reply claim).
  repliedBefore?: boolean;
  // A new thread continuing it exists — or the thread IS a continuation (never continued again).
  escalatedBefore: boolean;
  severity: StillOpenSeverity | null;
  // The PR is the reader's own (decision D2).
  ownPr?: boolean;
  // The READER resolved the thread (its `resolvedByLogin` is the account's login): nothing is written.
  resolvedByReader?: boolean;
}

export interface StillOpenPlan {
  reply: boolean;
  reopen: boolean;
  escalate: boolean;
}

/** THE PER-THREAD RULE (header). Pure. */
export function planStillOpen(f: StillOpenThreadFacts): StillOpenPlan {
  if (f.resolved && f.resolvedByReader === true) return { reply: false, reopen: false, escalate: false };
  if (!f.resolved) return { reply: !f.repliedAtHead, reopen: false, escalate: false };
  // D2: the reader's own PR — the reply only, once ever on a resolved thread; never reopen or continue.
  if (f.ownPr === true) return { reply: !f.repliedAtHead && f.repliedBefore !== true, reopen: false, escalate: false };
  if (!f.reopenedBefore) return { reply: !f.repliedAtHead, reopen: true, escalate: false };
  const serious = f.severity === 'blocker' || f.severity === 'warning';
  return { reply: false, reopen: false, escalate: serious && !f.escalatedBefore };
}

const sameHead = (a: string | null, b: string): boolean => a != null && a.toLowerCase() === b.toLowerCase();

/**
 * A thread's facts from the synced comments (every Limn's markers) and this account's claim keys.
 * `prComments`: every review comment on the PR (a continuation thread is a new root elsewhere).
 * Pure.
 */
export function stillOpenThreadFacts(a: {
  thread: { githubNodeId: string; isResolved: boolean };
  // The thread's comments, OLDEST FIRST (the first is its root).
  threadComments: ReadonlyArray<{ body: string | null }>;
  prComments: ReadonlyArray<{ body: string | null }>;
  rootDatabaseId: string | null;
  headSha: string;
  claims: ReadonlySet<string>;
  severity: StillOpenSeverity | null;
  ownPr?: boolean;
  resolvedByReader?: boolean;
}): StillOpenThreadFacts {
  const node = a.thread.githubNodeId;
  const [root, ...replies] = a.threadComments;
  const marks = replies.map((c) => parseStillOpenMarker(c.body)).filter((m) => m != null);
  const continued =
    a.rootDatabaseId != null &&
    a.prComments.some((c) => parseStillOpenMarker(c.body)?.continuesCommentId === a.rootDatabaseId);
  // The thread IS a continuation: its root names the thread it continues.
  const isContinuation = parseStillOpenMarker(root?.body)?.continuesCommentId != null;
  const replyPrefix = `reply:${node}:`;
  return {
    resolved: a.thread.isResolved,
    reopenedBefore: a.claims.has(claimKey('reopen', node)) || marks.some((m) => m!.reopened),
    repliedAtHead: a.claims.has(claimKey('reply', node, a.headSha)) || marks.some((m) => sameHead(m!.headSha, a.headSha)),
    repliedBefore: marks.length > 0 || [...a.claims].some((k) => k.startsWith(replyPrefix)),
    escalatedBefore: a.claims.has(claimKey('escalate', node)) || continued || isContinuation,
    severity: a.severity,
    ownPr: a.ownPr === true,
    ...(a.resolvedByReader === true && a.thread.isResolved ? { resolvedByReader: true } : {}),
  };
}

/** What a LIVE read of one thread on GitHub says (gap 3). Bodies only; oldest first. */
export interface StillOpenLiveThread {
  isResolved: boolean;
  comments: ReadonlyArray<{ body: string | null }>;
  // The ROOT comment of every review thread on the PR (for `c=`).
  prRoots: ReadonlyArray<{ body: string | null }>;
}

/**
 * The synced facts with GitHub's live word folded in: what any Limn already did (a reply at this head,
 * a reopen, a continuation) is the UNION of both readings; resolved is GitHub's live state. Pure.
 */
export function mergeLiveFacts(
  synced: StillOpenThreadFacts,
  live: StillOpenLiveThread,
  a: { githubNodeId: string; rootDatabaseId: string | null; headSha: string },
): StillOpenThreadFacts {
  const l = stillOpenThreadFacts({
    thread: { githubNodeId: a.githubNodeId, isResolved: live.isResolved },
    threadComments: live.comments,
    prComments: live.prRoots,
    rootDatabaseId: a.rootDatabaseId,
    headSha: a.headSha,
    claims: new Set(),
    severity: synced.severity,
    ownPr: synced.ownPr,
  });
  return {
    resolved: live.isResolved,
    reopenedBefore: synced.reopenedBefore || l.reopenedBefore,
    repliedAtHead: synced.repliedAtHead || l.repliedAtHead,
    repliedBefore: synced.repliedBefore === true || l.repliedBefore === true,
    escalatedBefore: synced.escalatedBefore || l.escalatedBefore,
    severity: synced.severity,
    ownPr: synced.ownPr,
    // Who resolved it is the sync's word; it holds only while GitHub still says resolved.
    ...(synced.resolvedByReader === true && live.isResolved ? { resolvedByReader: true } : {}),
  };
}

const nothingPlanned = (p: StillOpenPlan): boolean => !p.reply && !p.reopen && !p.escalate;

export function claimKey(action: 'reply' | 'reopen' | 'escalate' | 'read', threadNodeId: string, headSha?: string): string {
  return action === 'reply' || action === 'read'
    ? `${action}:${threadNodeId}:${(headSha ?? '').toLowerCase()}`
    : `${action}:${threadNodeId}`;
}

/** The reply on the thread: the lead, the reason, the footer, the markers. */
export function stillOpenReplyBody(reason: string | null, headSha: string, footer: string, reopened: boolean): string {
  const text = stillOpenReasonText(reason) || 'This is not addressed yet.';
  // No footer on a reply the reader pressed (manual-reply.ts): it is theirs, not an automatic post.
  const foot = footer.trim() !== '' ? `\n\n${footer}` : '';
  return `${STILL_OPEN_LEAD} ${text}${foot}\n\n${FINDING_MARKER}\n${stillOpenMarker({ headSha, reopened })}`;
}

/** The text of a NEW thread that continues an earlier one (the seam adds the lead, footer, marker). */
export function stillOpenNewThreadText(reason: string | null, headSha: string, earlierUrl: string | null, rootDatabaseId: string | null): string {
  const text = stillOpenReasonText(reason) || 'This is not addressed yet.';
  const where = earlierUrl ? `[an earlier thread](${earlierUrl})` : 'an earlier thread';
  return `This point is still open. It continues ${where}, which was reopened once already.\n\n${text}\n\n${stillOpenMarker({ headSha, continuesCommentId: rootDatabaseId })}`;
}

/** The pieces that touch GitHub, so a test can replace them. */
export interface StillOpenDeps {
  // ONE small read of a thread just before writing on it (gap 3). Throws on any failure.
  liveThread(accountId: number, threadNodeId: string): Promise<StillOpenLiveThread>;
  reply(accountId: number, threadNodeId: string, body: string): Promise<{ commentId: string | null }>;
  unresolve(accountId: number, threadNodeId: string): Promise<void>;
  stampUnresolved(threadId: number, accountId: number): Promise<void>;
  newThread(ctx: AgentContext, args: PostFindingArgs): Promise<PostFindingOutcome>;
  notePrChanged(accountId: number, prIds: number[]): Promise<void>;
  settle(a: { accountId: number; prId: number; log: AgentContext['log'] }): Promise<{ visible: boolean }>;
}

const LIVE_THREAD_QUERY = /* GraphQL */ `
  query StillOpenLiveThread($thread: ID!) {
    node(id: $thread) {
      ... on PullRequestReviewThread {
        isResolved
        comments(last: 100) {
          nodes {
            body
          }
        }
        pullRequest {
          reviewThreads(last: 100) {
            nodes {
              comments(first: 1) {
                nodes {
                  body
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface LiveThreadResponse {
  node: {
    isResolved?: boolean;
    comments?: { nodes: Array<{ body: string | null } | null> | null } | null;
    pullRequest?: {
      reviewThreads?: { nodes: Array<{ comments?: { nodes: Array<{ body: string | null } | null> | null } | null } | null> | null } | null;
    } | null;
  } | null;
}

export const defaultStillOpenDeps: StillOpenDeps = {
  async liveThread(accountId, threadNodeId) {
    const [{ getAccessToken }, { getGraphqlClientFor }] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/client.js'),
    ]);
    const gql = getGraphqlClientFor(await getAccessToken(accountId));
    const res = await gql<LiveThreadResponse>(LIVE_THREAD_QUERY, { thread: threadNodeId });
    const n = res.node;
    // Never guess: a thread GitHub does not describe fully is a failed read.
    if (n == null || typeof n.isResolved !== 'boolean' || n.comments?.nodes == null || n.pullRequest?.reviewThreads?.nodes == null) {
      throw new Error('GitHub did not return the thread.');
    }
    return {
      isResolved: n.isResolved,
      comments: n.comments.nodes.filter((c) => c != null).map((c) => ({ body: c!.body ?? null })),
      prRoots: n.pullRequest.reviewThreads.nodes
        .map((t) => t?.comments?.nodes?.[0])
        .filter((c) => c != null)
        .map((c) => ({ body: c!.body ?? null })),
    };
  },
  async reply(accountId, threadNodeId, body) {
    const [{ getAccessToken }, { addReviewThreadReply }, ledger] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/mutations.js'),
      import('../../db/limn-actions.js'),
    ]);
    const origin = ledger.orReader(await ledger.limnOriginForThread(accountId, threadNodeId, 'auto'));
    const c = await addReviewThreadReply(await getAccessToken(accountId), threadNodeId, body, origin);
    return { commentId: c.databaseId != null ? String(c.databaseId) : null };
  },
  async unresolve(accountId, threadNodeId) {
    const [{ getAccessToken }, { setReviewThreadResolved }, ledger] = await Promise.all([
      import('../../auth/account.js'),
      import('../../github/mutations.js'),
      import('../../db/limn-actions.js'),
    ]);
    const origin = ledger.orReader(await ledger.limnOriginForThread(accountId, threadNodeId, 'auto'));
    await setReviewThreadResolved(await getAccessToken(accountId), threadNodeId, false, origin);
  },
  async stampUnresolved(threadId, accountId) {
    const { stampThreadResolved } = await import('../../db/queries.js');
    await stampThreadResolved(threadId, false, accountId);
  },
  async newThread(ctx, args) {
    return ctx.review.postFinding(args);
  },
  async notePrChanged(accountId, prIds) {
    const { notePrChangedForPrs } = await import('../../sync/pr-settle.js');
    await notePrChangedForPrs(accountId, prIds);
  },
  async settle(a) {
    const { settlePrAfterWrite } = await import('../../sync/resync-after-write.js');
    return settlePrAfterWrite(a);
  },
};

export interface StillOpenResult {
  replied: number[];
  reopened: number[];
  escalated: number[];
  failed: number[];
  // Threads left alone because the live read failed (recorded as this head's reply claim).
  unread: number[];
}

/**
 * Say on GitHub which earlier points this posted review holds open. Called by `maybeAutoPostReview`
 * once a run went down the posting path (an auto run with auto-posting on, or "Review and post").
 * `pairFirstReviewId`: a Claude + Codex pair's first half. Never throws.
 */
export async function maybePostStillOpen(
  ctx: AgentContext,
  a: { accountId: number; prId: number; reviewId: number; pairFirstReviewId?: number | null },
  deps: StillOpenDeps = defaultStillOpenDeps,
): Promise<StillOpenResult | null> {
  try {
    return await postStillOpen(ctx, a, deps);
  } catch (err) {
    ctx.log.warn(`still open review ${a.reviewId}: ${errText(err)}`);
    return null;
  }
}

async function postStillOpen(
  ctx: AgentContext,
  { accountId, prId, reviewId, pairFirstReviewId }: { accountId: number; prId: number; reviewId: number; pairFirstReviewId?: number | null },
  deps: StillOpenDeps,
): Promise<StillOpenResult | null> {
  const review = await getClaudeReviewById(ctx, reviewId, accountId);
  if (!review || review.prId !== prId || review.status !== 'succeeded' || review.kind === 'replies') return null;
  const runs: ClaudeReview[] = [];
  if (pairFirstReviewId != null && pairFirstReviewId !== reviewId) {
    const f = await getClaudeReviewById(ctx, pairFirstReviewId, accountId);
    if (f && f.prId === prId && f.status === 'succeeded' && f.headSha === review.headSha) runs.push(f);
  }
  runs.push(review);
  const t = sch(ctx);
  const { reviewThreads: rt, reviewComments: rc, pullRequests: prs, repos, claudeStillOpenPosts: sop } = t;
  if (!sop) return null;

  // The PR, account-scoped, at the head the review read (a judgement of an older head says nothing
  // about the code on GitHub now).
  const pr = (
    (await ctx.db
      .select({ owner: repos.owner, name: repos.name, number: prs.number, headSha: prs.headSha })
      .from(prs)
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ owner: string; name: string; number: number; headSha: string | null }>
  )[0];
  if (pr == null || pr.headSha == null || pr.headSha.toLowerCase() !== review.headSha.toLowerCase()) return null;

  const comments = (await ctx.db
    .select({ id: rc.id, threadId: rc.threadId, databaseId: rc.databaseId, body: rc.body, createdAt: rc.createdAt })
    .from(rc)
    .where(eq(rc.prId, prId))
    .execute()) as Array<{ id: number; threadId: number; databaseId: string | null; body: string | null; createdAt: Date | null }>;
  const byThread = new Map<number, typeof comments>();
  for (const c of comments.sort((x, y) => (x.createdAt?.getTime() ?? 0) - (y.createdAt?.getTime() ?? 0) || x.id - y.id)) {
    const list = byThread.get(c.threadId) ?? [];
    list.push(c);
    byThread.set(c.threadId, list);
  }
  // Limn finding roots and their lead's severity (the shared predicate, as limnFindingThreadIdsForPrs).
  const limnRoots = new Map<number, { severity: StillOpenSeverity | null }>();
  for (const [threadId, list] of byThread) {
    const post = limnFindingPost(list[0]?.body, { threadRoot: true });
    if (post != null && !post.stillOpen) limnRoots.set(threadId, { severity: sev(post.severity) });
  }
  const candidates = stillOpenCandidates(runs, limnRoots);
  if (candidates.length === 0) return null;

  const threads = (await ctx.db
    .select({
      id: rt.id,
      githubNodeId: rt.githubNodeId,
      path: rt.path,
      line: rt.line,
      isResolved: rt.isResolved,
      isOutdated: rt.isOutdated,
      resolvedByLogin: rt.resolvedByLogin,
    })
    .from(rt)
    .where(and(eq(rt.prId, prId), inArray(rt.id, candidates.map((c) => c.threadId))))
    .execute()) as Array<{
    id: number;
    githubNodeId: string;
    path: string;
    line: number | null;
    isResolved: boolean;
    isOutdated: boolean;
    resolvedByLogin: string | null;
  }>;
  const { accountLoginOf } = await import('./finding-replies.js');
  const readerLogin = (await accountLoginOf(ctx, accountId))?.toLowerCase() ?? null;
  const threadOf = new Map(threads.map((x) => [x.id, x]));
  const claimRows = (await ctx.db
    .select({ key: sop.claimKey })
    .from(sop)
    .where(and(eq(sop.accountId, accountId), eq(sop.prId, prId)))
    .execute()) as Array<{ key: string }>;
  const claims = new Set(claimRows.map((r) => r.key));

  // D2: the reader's own PR — replies only.
  const { prAuthorIsAccount } = await import('../../coding/ai-fix/auto-fix.js');
  const ownPr = await prAuthorIsAccount(ctx, accountId, prId);

  const footer = runs.length > 1 ? PAIR_AUTO_POST_FOOTER : autoPostFooter(aiRunProviderName(review));
  const result: StillOpenResult = { replied: [], reopened: [], escalated: [], failed: [], unread: [] };
  let wrote = false;

  // ⚠ THE CLAIM: insert-or-nothing on the unique (account, key). true = this call owns the write.
  const claim = async (
    action: 'reply' | 'reopen' | 'escalate' | 'read',
    thread: { id: number; githubNodeId: string },
    c: StillOpenCandidate,
  ): Promise<number | null> => {
    const key = claimKey(action, thread.githubNodeId, review.headSha);
    const rows = (await ctx.db
      .insert(sop)
      .values({
        accountId,
        prId,
        threadId: thread.id,
        threadNodeId: thread.githubNodeId,
        claimKey: key,
        action,
        reviewId,
        headSha: review.headSha,
        status: 'posting',
        reason: stillOpenReasonText(c.reason) || null,
        severity: c.severity,
      })
      .onConflictDoNothing({ target: [sop.accountId, sop.claimKey] })
      .returning({ id: sop.id })
      .execute()) as Array<{ id: number }>;
    if (rows.length === 0) return null;
    claims.add(key);
    return rows[0]!.id;
  };
  const settleClaim = async (id: number, status: 'posted' | 'failed', extra: { commentId?: string | null; error?: string | null }) => {
    await ctx.db
      .update(sop)
      .set({ status, commentId: extra.commentId ?? null, error: extra.error ?? null, updatedAt: new Date() })
      .where(eq(sop.id, id))
      .execute()
      .catch((err: unknown) => ctx.log.warn(`still open review ${reviewId}: could not record a result: ${errText(err)}`));
  };

  for (const c of candidates) {
    const thread = threadOf.get(c.threadId);
    if (thread == null || !thread.githubNodeId) continue;
    const list = byThread.get(thread.id) ?? [];
    const rootDatabaseId = list[0]?.databaseId ?? null;
    // Gap 2: a disputed reply on an UNRESOLVED thread is the pushback's (one reply, auto-pushback.ts).
    if (c.disputed === true && !thread.isResolved) continue;
    const synced = stillOpenThreadFacts({
      thread,
      threadComments: list,
      prComments: comments,
      rootDatabaseId,
      headSha: review.headSha,
      claims,
      severity: c.severity,
      ownPr,
      resolvedByReader: readerLogin != null && (thread.resolvedByLogin ?? '').toLowerCase() === readerLogin,
    });
    if (nothingPlanned(planStillOpen(synced))) continue;
    // A live read that failed at this head already: nothing more on this thread at this head.
    if (claims.has(claimKey('read', thread.githubNodeId, review.headSha))) continue;
    // Gap 3: read the thread LIVE, then plan again on what GitHub says now. A failed read writes
    // nothing; it is recorded (`read:<node>:<head>`, failed, with why) and not tried again at this head.
    let facts: StillOpenThreadFacts;
    try {
      const live = await deps.liveThread(accountId, thread.githubNodeId);
      facts = mergeLiveFacts(synced, live, { githubNodeId: thread.githubNodeId, rootDatabaseId, headSha: review.headSha });
    } catch (err) {
      const id = await claim('read', thread, c);
      if (id != null) await settleClaim(id, 'failed', { error: `Nothing written: couldn't read the thread on GitHub first (${errText(err)}).` });
      result.unread.push(thread.id);
      continue;
    }
    if (c.disputed === true && !facts.resolved) continue;
    let plan = planStillOpen(facts);
    if (nothingPlanned(plan)) continue;
    let failedHere = false;

    // REOPEN — once per thread, ever. Lost claim ⇒ it was reopened before: plan again on that fact.
    let reopenClaim: number | null = null;
    if (plan.reopen) {
      reopenClaim = await claim('reopen', thread, c);
      if (reopenClaim == null) plan = planStillOpen({ ...facts, reopenedBefore: true });
    }
    // THE REPLY — once per thread per head.
    let replyFailed = false;
    if (plan.reply) {
      const id = await claim('reply', thread, c);
      if (id != null) {
        try {
          const { commentId } = await deps.reply(
            accountId,
            thread.githubNodeId,
            stillOpenReplyBody(c.reason, review.headSha, footer, reopenClaim != null),
          );
          wrote = true;
          await settleClaim(id, 'posted', { commentId });
          result.replied.push(thread.id);
        } catch (err) {
          replyFailed = true;
          failedHere = true;
          await settleClaim(id, 'failed', { error: errText(err) });
        }
      }
    }
    // THE UNRESOLVE, after the reply that explains it (never without one: a failed reply leaves the
    // thread resolved, and the claim is spent — never retried).
    if (reopenClaim != null) {
      if (replyFailed) {
        failedHere = true;
        await settleClaim(reopenClaim, 'failed', { error: 'The reply failed, so the thread was left resolved.' });
      } else {
        try {
          await deps.unresolve(accountId, thread.githubNodeId);
          wrote = true;
          await settleClaim(reopenClaim, 'posted', {});
          result.reopened.push(thread.id);
          await deps.stampUnresolved(thread.id, accountId).catch((err) =>
            ctx.log.warn(`still open review ${reviewId}: could not stamp thread ${thread.id}: ${errText(err)}`),
          );
        } catch (err) {
          failedHere = true;
          await settleClaim(reopenClaim, 'failed', { error: errText(err) });
        }
      }
    }
    // A NEW THREAD — a warning or blocker reopened once already. Once per thread, ever.
    if (plan.escalate) {
      const id = await claim('escalate', thread, c);
      if (id != null) {
        const reraise =
          c.priorFindingId != null
            ? runs.flatMap((r) => r.findings).find((f) => f.priorFindingId === c.priorFindingId && f.line != null)
            : undefined;
        const onLine = !thread.isOutdated && thread.line != null;
        const url = rootDatabaseId != null ? `https://github.com/${pr.owner}/${pr.name}/pull/${pr.number}#discussion_r${rootDatabaseId}` : null;
        try {
          const outcome = await deps.newThread(ctx, {
            owner: pr.owner,
            name: pr.name,
            prNumber: pr.number,
            limn: { accountId, prId, origin: 'auto', source: { table: 'claude_reviews', id: review.id } },
            reviewHeadSha: review.headSha,
            finding: {
              id: -thread.id,
              path: reraise?.path ?? thread.path,
              line: onLine ? thread.line : (reraise?.line ?? thread.line),
              side: reraise?.side ?? 'RIGHT',
              // On the thread's current line, or the re-raise's own anchored line; else the seam
              // re-anchors to the file's first change, or posts a PR-level comment.
              anchored: onLine || reraise?.anchored === true,
              fileInDiff: onLine || reraise?.fileInDiff === true,
              body: stillOpenNewThreadText(c.reason, review.headSha, url, rootDatabaseId),
              suggestion: null,
              severity: c.severity,
              footer,
            },
          });
          if (outcome.headMoved) {
            // Nothing was written: release the claim (a later run at the new head may try).
            await ctx.db.delete(sop).where(eq(sop.id, id)).execute().catch(() => {});
            claims.delete(claimKey('escalate', thread.githubNodeId));
          } else {
            wrote = true;
            await settleClaim(id, 'posted', { commentId: outcome.commentId });
            result.escalated.push(thread.id);
          }
        } catch (err) {
          failedHere = true;
          await settleClaim(id, 'failed', { error: errText(err) });
        }
      }
    }
    if (failedHere) result.failed.push(thread.id);
  }
  if (wrote) {
    await deps.notePrChanged(accountId, [prId]).catch(() => {});
    await deps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  }
  return result;
}
