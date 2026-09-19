// ONE-TIME REVIEW-REQUEST HISTORY BACKFILL — merged pull requests the walk will never revisit.
//
// The fat walk now carries each PR's request history (github/queries.ts `reviewRequestHistory`),
// but only for PRs it touches, and an incremental walk only touches PRs updated since the last one.
// Every PR merged before this feature shipped would otherwise stay "not known" forever, and
// Chronology's "asked to first look" would describe only the newest slice of the window — the
// retroactive-coverage trap in a new place.
//
// So after each walk this re-reads, by node id, up to REVIEW_REQUEST_BACKFILL_PER_RUN merged PRs
// in the trailing Chronology window whose `review_requests_synced_at` is still NULL. Each PR is
// stamped when its history is written, so it is fetched ONCE; a PR GitHub will not return is left
// NULL and re-tried on a later walk (bounded by the per-run cap, never a loop).
//
// COST: `nodes(ids:)` over at most REVIEW_REQUEST_NODE_BATCH PRs with one leaf connection each —
// about one point per batch. The cheap-consumer budget contract: skip when the token is already
// known-limited (`isLimited`), report a limit through `noteLimited`, feed `noteBudget`. STRICTLY
// NON-FATAL: a failure here must never be the reason a sync reports failure.
import { and, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { db, runTransaction, schema } from '../db/client.js';
import { getAccessToken } from '../auth/account.js';
import { getGraphqlClientFor, graphqlTolerant, isRateLimitError } from '../github/client.js';
import {
  REVIEW_REQUEST_HISTORY_NODES_QUERY,
  type ReviewRequestHistoryNodesResponse,
} from '../github/queries.js';
import { isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import { createUserResolver, persistReviewRequestHistory } from './upsert.js';

const { pullRequests } = schema;

/** PRs one repo may backfill per walk. Two batches — a couple of points, a few seconds. */
export const REVIEW_REQUEST_BACKFILL_PER_RUN = 100;
/** `nodes(ids:)` accepts at most 100; kept well under it (the PR_LIVENESS_NODE_BATCH reasoning). */
const REVIEW_REQUEST_NODE_BATCH = 50;
/** Chronology's longest window. Older merges are never read by it, so never fetched. */
const BACKFILL_WINDOW_DAYS = 90;

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

function parseResetAt(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function backfillReviewRequestHistory(
  accountId: number,
  repoId: number,
  log?: Logger,
): Promise<number> {
  if (isLimited(accountId)) return 0;
  const since = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 3_600_000);
  const rows = await db
    .select({ id: pullRequests.id, nodeId: pullRequests.githubNodeId })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'merged'),
        isNotNull(pullRequests.mergedAt),
        gte(pullRequests.mergedAt, since),
        isNull(pullRequests.reviewRequestsSyncedAt),
      ),
    )
    .limit(REVIEW_REQUEST_BACKFILL_PER_RUN)
    .execute();
  if (rows.length === 0) return 0;

  const token = await getAccessToken(accountId);
  const gql = getGraphqlClientFor(token);
  const idByNode = new Map(rows.map((r) => [r.nodeId, r.id] as const));
  const resolver = createUserResolver();
  let written = 0;

  for (let i = 0; i < rows.length; i += REVIEW_REQUEST_NODE_BATCH) {
    if (isLimited(accountId)) break;
    const batch = rows.slice(i, i + REVIEW_REQUEST_NODE_BATCH).map((r) => r.nodeId);
    let res: ReviewRequestHistoryNodesResponse;
    try {
      res = await graphqlTolerant<ReviewRequestHistoryNodesResponse>(
        gql,
        REVIEW_REQUEST_HISTORY_NODES_QUERY,
        { ids: batch },
        () => log?.warn('review-request backfill: partial GraphQL response'),
      );
    } catch (err) {
      const rl = isRateLimitError(err);
      if (rl.limited) {
        noteLimited(accountId, rl.resumeAt);
        break;
      }
      throw err;
    }
    if (res.rateLimit) {
      noteBudget(accountId, {
        remaining: res.rateLimit.remaining ?? null,
        resetAt: parseResetAt(res.rateLimit.resetAt),
      });
    }
    // Only PRs this account's query produced, matched back by node id — a node GitHub returned
    // that is not in this batch's worklist cannot reach a write.
    const found = (res.nodes ?? []).filter(
      (n): n is NonNullable<typeof n> => n != null && typeof n.id === 'string' && idByNode.has(n.id),
    );
    await runTransaction(async (tx) => {
      for (const n of found) {
        const prId = idByNode.get(n.id!)!;
        // A nulled selection (`reviewRequestHistory: null`) is "not received": the helper writes
        // nothing and leaves the stamp NULL, so this PR is tried again on a later walk.
        await persistReviewRequestHistory(tx, prId, n.reviewRequestHistory?.nodes, resolver);
        if (n.reviewRequestHistory != null) written += 1;
      }
    });
  }
  if (written > 0) log?.info(`review-request backfill: ${written} pull request(s)`);
  return written;
}

/** Exposed for the unit test. */
export const __reviewRequestBackfillTesting = { REVIEW_REQUEST_NODE_BATCH, BACKFILL_WINDOW_DAYS };
