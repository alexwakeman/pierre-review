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
import { isLimited } from '../github/rate-budget.js';
import { invalidatePrHydration } from './hydrate-detail.js';
import {
  getPrSettleFacts,
  headExpectationMet,
  isPrSettled,
  schedulePrSettle,
  type PrSettleExpectation,
} from './pr-settle.js';
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
    return await resyncOnce(prId, accountId, asSyncLogger(log));
  } catch (err) {
    log.warn({ err }, `resyncPrAfterWrite: PR ${prId} failed`);
    return false;
  }
}

// The body of `resyncPrAfterWrite`, on the sync layer's 3-method logger so `settlePrAfterWrite`
// (whose callers include the background runner and the coding seam, which hold no Fastify
// logger) shares it rather than growing a second copy. MAY throw — both callers catch.
async function resyncOnce(prId: number, accountId: number, log: Logger): Promise<boolean> {
  const target = await getPrSyncTarget(prId, accountId);
  if (!target) return false;
  // Order is load-bearing: bust the server-side 60s hydration cache FIRST, so even if
  // the sync below fails the client's follow-up GET can't be served a pre-write
  // snapshot (a new comment's diffHunk is lean-gated, i.e. hydration-only).
  invalidatePrHydration(accountId, target.owner, target.name, target.number);
  // waitForInFlight: a webhook/adaptive sync already running for this PR may have read
  // GitHub BEFORE our write, so its success proves nothing about the new row — queue
  // behind it and then fetch ourselves.
  return await syncOnePr(target.repoId, target.number, log, {
    waitForInFlight: true,
  });
}

// ── settlePrAfterWrite — "resync, VERIFY, then keep watching" ───────────────────────────────
//
// `resyncPrAfterWrite` answers "did a sync run?". After a PUSH that is the wrong question: GitHub
// attaches a push to its pull request asynchronously and computes mergeability lazily, so a read
// milliseconds after `git push` can persist the old head, or the new head with a stale
// CONFLICTING/DIRTY, and still return true. The conflict resolver reported `visible: true` on
// exactly that row, and the Pending board then re-served the "Conflicts" card it had just fixed.
//
// So this composition:
//   1. the same resync (hydration bust, then syncOnePr queued behind any in-flight run);
//   2. an ACCOUNT-SCOPED read of what is now stored (getPrSettleFacts);
//   3. for a HEAD expectation only, a few inline re-reads, bounded by a wall-clock deadline so a
//      caller holding a drain (the resolver's SIGTERM drain) is never held for long — the reader
//      is already watching a "Confirming…" step, and the pushed commit usually appears in 1-3s.
//      ⚠ THE DEADLINE STARTS BEFORE STEP 1 and every re-read is RACED against what is left of it,
//      so the inline half never runs past it. Step 1 itself is awaited in full (it queues behind a
//      sync already in flight — the pre-existing resync contract); when that alone outlasts the
//      budget there are simply no inline re-reads, and the ladder does the rest;
//   4. `visible` = the head expectation was MET (with no head expectation, the old semantics:
//      the resync ran);
//   5. anything still unmet — the head, a stale conflict verdict, an unknown merge column — is
//      handed to the background settle ladder (sync/pr-settle.ts). Mergeability is NEVER waited
//      for inline: it can take GitHub a minute, and the ladder is what reads it.
//
// ⚠ NEVER THROWS, and `visible: false` keeps its copy contract: the write happened, it will show
// up here shortly, and the SPA must never offer a retry (a retry double-pushes).

/** Inline re-read gaps for a head expectation, and the wall-clock deadline over the whole call
 *  (measured from its start, so the resync counts against it). */
let inlineRetryDelaysMs: readonly number[] = [1_000, 1_500, 2_500];
let inlineBudgetMs = 7_000;

/** Test-only: shrink the inline wait so a stale-head case does not cost a test 7 seconds. */
export function __setSettleInlineTiming(t: { delaysMs?: number[]; budgetMs?: number }): void {
  if (t.delaysMs) inlineRetryDelaysMs = [...t.delaysMs];
  if (t.budgetMs != null) inlineBudgetMs = t.budgetMs;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });

/** Did `p` settle within `ms`? A read that loses the race keeps running in the background — it
 *  persists whatever it reads, and the ladder's next step sees the row. `p` must never reject. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function settlePrAfterWrite(args: {
  accountId: number;
  prId: number;
  log: Logger;
  expect?: PrSettleExpectation;
}): Promise<{ visible: boolean }> {
  const { accountId, prId, log } = args;
  const expect: PrSettleExpectation = args.expect ?? {};
  const wantsHead = expect.headSha != null || expect.headNot != null;
  let visible = false;
  // Default to handing off: if anything below throws, the ladder is the safe continuation.
  let handOff = true;
  // Measured from the START, so a slow resync eats into the inline budget instead of adding to it.
  const deadline = Date.now() + inlineBudgetMs;
  try {
    const synced = await resyncOnce(prId, accountId, log);
    let facts = await getPrSettleFacts(prId, accountId);
    if (!facts) {
      // Not this account's PR, or gone — there is nothing to settle and nothing to schedule.
      handOff = false;
      return { visible: false };
    }
    if (wantsHead) {
      let retried = false;
      for (const delay of inlineRetryDelaysMs) {
        if (facts.state !== 'open' || headExpectationMet(facts, expect)) break;
        if (Date.now() + delay >= deadline) break;
        // A limited token is not asked again inline; the ladder pauses on the same signal.
        if (isLimited(accountId)) break;
        await sleep(delay);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        // No waitForInFlight: any run in flight started after the resync above, i.e. after the
        // write, so a stand-down loses nothing — and waiting behind it would break the deadline.
        // Raced against the remaining budget; a failed read is just a read that saw nothing new.
        const read = syncOnePr(facts.repoId, facts.number, log).catch(() => false);
        const finished = await settlesWithin(read, remaining);
        retried = true;
        facts = (await getPrSettleFacts(prId, accountId)) ?? facts;
        if (!finished) break;
      }
      // A PR-detail GET during the wait could have re-hydrated the OLD head's check runs.
      if (retried) invalidatePrHydration(accountId, facts.owner, facts.name, facts.number);
      visible = headExpectationMet(facts, expect);
    } else {
      visible = synced;
    }
    // A resync that never ran (a failed fetch) proved nothing about the post-write row, however
    // settled the stored one looks — so it hands off too.
    handOff = !isPrSettled(facts, expect) || (!wantsHead && !synced);
    return { visible };
  } catch (err) {
    log.warn(`settlePrAfterWrite: PR ${prId} failed: ${err instanceof Error ? err.message : err}`);
    return { visible };
  } finally {
    if (handOff) schedulePrSettle(accountId, prId, log, expect);
  }
}

/**
 * Targeted-sync a SECOND pull request a write just opened in the same repository as `prId`
 * (the resolver's "new branch + open a PR"). The number resolves ONLY within the original PR's
 * (account, repo) — a PR number is unique per repo, never per account. Never throws.
 */
export async function syncNewPrBesideAfterWrite(args: {
  accountId: number;
  prId: number;
  number: number;
  log: Logger;
}): Promise<boolean> {
  try {
    const target = await getPrSyncTarget(args.prId, args.accountId);
    if (!target) return false;
    return await syncOnePr(target.repoId, args.number, args.log);
  } catch (err) {
    args.log.warn(
      `syncNewPrBesideAfterWrite: PR #${args.number} beside ${args.prId} failed: ${err instanceof Error ? err.message : err}`,
    );
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
