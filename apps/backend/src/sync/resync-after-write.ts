// Post-write targeted resync — the "a posted comment must appear immediately" tail.
//
// Every other GitHub write in this app stamps its own row locally (upsertLocalPrComment,
// upsertLocalReply + stampThreadRepliedState, stampThreadResolved, upsertLocalReview,
// markPrMergedLocally, …), which is why only ONE of them ever told the user to wait for the
// next sync. An INLINE review comment can't be stamped that way: REST's
// POST /pulls/:n/comments returns the comment's own ids but NOT the enclosing
// PullRequestReviewThread's GraphQL node id, and without that node id a forged local thread
// row would have no reply/resolve identity — the thread would render but every action on it
// would 404. So rather than an optimistic echo we re-read the PR from GitHub through the
// SAME idempotent path the scheduler and the webhook receiver use (syncOnePr → persistPr),
// which is also literally what the user asked for: the real GitHub-API state of the comment
// they just posted.
//
// NOTHING here throws. A resync failure must never turn a successful post into an error —
// the comment is on GitHub either way — so callers branch on the returned flags instead.
import { and, eq, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db, schema } from '../db/client.js';
import { invalidatePrHydration } from './hydrate-detail.js';
import { syncOnePr } from './sync-one-pr.js';
import type { Logger } from './sync-repo.js';

const { pullRequests, repos, reviewComments } = schema;

// The sync layer logs with a plain 3-method interface; scheduler.ts and the webhook
// receiver both build the same shim over their Fastify/pino logger. Exported so the
// refresh route's tail (sync/refresh-pr.ts) doesn't grow a fourth copy.
export function asSyncLogger(log: FastifyBaseLogger): Logger {
  return {
    info: (m, ...a) => log.info(a.length ? { a } : {}, m),
    warn: (m, ...a) => log.warn(a.length ? { a } : {}, m),
    error: (m, ...a) => log.error(a.length ? { a } : {}, m),
  };
}

export interface PrSyncTarget {
  repoId: number;
  owner: string;
  name: string;
  number: number;
  // The stored row's updatedAt — the refresh route compares it around a walk to decide
  // `changed`; this module ignores it.
  updatedAt: Date;
}

/**
 * Resolve the coordinates a targeted sync needs from a local PR id. Account-scoped even
 * though the write route has already proved ownership, so the isolation guarantee is
 * structural rather than inherited from a caller. Exported for sync/refresh-pr.ts (and
 * named in scripts/verify-isolation.ts — id-addressed reads outside db/queries.ts are
 * invisible to the isolation walk unless imported explicitly).
 */
export async function getPrSyncTarget(
  prId: number,
  accountId: number,
): Promise<PrSyncTarget | null> {
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.id, prId), eq(repos.accountId, accountId)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

/**
 * Make the local DB reflect GitHub for ONE PR, right now. Returns true when the PR was
 * re-fetched and persisted. Never throws.
 */
export async function resyncPrAfterWrite(args: {
  prId: number;
  accountId: number;
  log: FastifyBaseLogger;
}): Promise<boolean> {
  const { prId, accountId, log } = args;
  try {
    const target = await getPrSyncTarget(prId, accountId);
    if (!target) return false;
    // Order is load-bearing: bust the server-side 60s hydration cache FIRST, so even if
    // the sync below fails the client's follow-up GET can't be served a pre-write
    // snapshot (a new comment's diffHunk is lean-gated, i.e. hydration-only).
    invalidatePrHydration(accountId, target.owner, target.name, target.number);
    // waitForInFlight: a webhook/adaptive sync already running for this PR may have read
    // GitHub BEFORE our write, so its success proves nothing about the new row — queue
    // behind it and then fetch ourselves.
    return await syncOnePr(target.repoId, target.number, asSyncLogger(log), {
      waitForInFlight: true,
    });
  } catch (err) {
    log.warn({ err }, `resyncPrAfterWrite: PR ${prId} failed`);
    return false;
  }
}

/** What the client needs to know about a just-posted inline comment's local visibility. */
export interface ReviewCommentVisibility {
  // The comment is in the local DB — refetching the PR detail is GUARANTEED to render it.
  visible: boolean;
  // Local reviewThreads.id it landed in (for scroll-to + highlight); null unless visible.
  threadId: number | null;
}

/**
 * Did the freshly-posted inline comment actually land in the local DB? Account-scoped via
 * pullRequests → repos even though the caller already proved ownership of `prId`.
 *
 * Matches on GitHub's NUMERIC id (REST `id` === GraphQL `fullDatabaseId`, stored in the TEXT
 * column `review_comments.database_id`) OR the node id, and here's why both: REST's
 * `node_id` and GraphQL's `id` are the same string for current-generation ids, but that is a
 * convention, not a contract (GitHub's node-id migration changed the encoding once), and a
 * silent mismatch would leave `visible` false forever with no error anywhere. Either
 * identifier alone identifies exactly this comment, so an OR can only widen the match, never
 * hit the wrong row.
 */
export async function findPostedReviewComment(
  prId: number,
  accountId: number,
  githubDatabaseId: string,
  githubNodeId: string,
): Promise<{ id: number; threadId: number } | null> {
  const rows = await db
    .select({ id: reviewComments.id, threadId: reviewComments.threadId })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(reviewComments.prId, prId),
        eq(repos.accountId, accountId),
        or(
          eq(reviewComments.databaseId, githubDatabaseId),
          eq(reviewComments.githubNodeId, githubNodeId),
        ),
      ),
    )
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

/**
 * The whole tail of `POST /api/prs/:id/review-comment`: resync the PR, then PROVE the new
 * comment row exists before the route promises the client anything.
 *
 * The ordering guarantee is "a committed transaction, then a confirming SELECT" — persistPr
 * runs inside runTransaction, so by the time syncOnePr resolves the row is durable, and only
 * then do we read it. Never throws, and never reports visibility it hasn't verified.
 */
export async function confirmPostedReviewComment(args: {
  prId: number;
  accountId: number;
  githubDatabaseId: string;
  githubNodeId: string;
  log: FastifyBaseLogger;
}): Promise<ReviewCommentVisibility> {
  const { prId, accountId, githubDatabaseId, githubNodeId, log } = args;
  try {
    const synced = await resyncPrAfterWrite({ prId, accountId, log });
    if (!synced) return { visible: false, threadId: null };
    const row = await findPostedReviewComment(
      prId,
      accountId,
      githubDatabaseId,
      githubNodeId,
    );
    // A synced-but-not-found comment is a real case, not a bug: the targeted query pages
    // reviewThreads(first: 50), so on a bot-flooded PR with more threads than that the new
    // one may not be in the page at all. Report it honestly rather than guessing.
    if (!row) {
      log.warn(
        `confirmPostedReviewComment: PR ${prId} resynced but comment ${githubDatabaseId} not found locally`,
      );
      return { visible: false, threadId: null };
    }
    return { visible: true, threadId: row.threadId };
  } catch (err) {
    log.warn({ err }, `confirmPostedReviewComment: PR ${prId} verification failed`);
    return { visible: false, threadId: null };
  }
}
