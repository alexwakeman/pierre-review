// ONE-SHOT COMMIT-HEADLINE BACKFILL — open PRs whose stored commits predate `message_headline`.
//
// My Turn's "Pushed since" card lists the subject line of each commit a person pushed after your
// last action. The board may not fetch on mount, so the line is STORED (`commits.message_headline`,
// migration 0072 / pg 0059) and the walk writes it for every PR it touches. A repo still carries
// older open PRs the walk never revisits; their commits sit at NULL ("not synced yet") until this
// fills them.
//
// So after each walk this re-reads, by node id, up to COMMIT_HEADLINE_BACKFILL_PER_RUN open PRs in
// the repo that have at least one commit with no headline — most recently active first, the PRs
// inside the Pending board's activity floor. One `nodes(ids:)` read per batch of
// COMMIT_HEADLINE_NODE_BATCH PRs (about one GraphQL point each). It writes ONLY `message_headline`,
// ONLY on rows that are still NULL, and only for an oid GitHub actually sent.
//
// A commit older than the PR's last 100 is never returned, so a PR can stay a candidate for ever;
// the in-process `attempted` set means each PR is asked for at most once per process, which bounds
// the waste to one read per restart. STRICTLY NON-FATAL, and it follows the cheap-consumer budget
// contract (skip while `isLimited`, `noteLimited` on a limit, `noteBudget` on every response).
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, runTransaction, schema } from '../db/client.js';
import { getAccessToken } from '../auth/account.js';
import { getGraphqlClientFor, graphqlTolerant, isRateLimitError } from '../github/client.js';
import {
  COMMIT_HEADLINE_NODES_QUERY,
  type CommitHeadlineNodesResponse,
} from '../github/queries.js';
import { isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';

const { pullRequests, commits } = schema;

/** Open PRs one repo may backfill per walk. Two batches — about two points. */
export const COMMIT_HEADLINE_BACKFILL_PER_RUN = 40;
/** PRs per `nodes(ids:)` read: 20 × 100 commits keeps one response small. */
const COMMIT_HEADLINE_NODE_BATCH = 20;
/** Matches the walk's write (`persistPr`). */
const HEADLINE_MAX_CHARS = 200;

/** `${accountId}:${prId}` — asked once per process (see the header). Not a token or data cache. */
const attempted = new Set<string>();

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

function parseResetAt(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The worklist, exported for the test. Account + repo scoped; skips PRs already asked for. */
export async function commitHeadlineBackfillWorklist(
  accountId: number,
  repoId: number,
  limit: number = COMMIT_HEADLINE_BACKFILL_PER_RUN,
): Promise<{ id: number; nodeId: string }[]> {
  const rows = await db
    .selectDistinct({
      id: pullRequests.id,
      nodeId: pullRequests.githubNodeId,
      updatedAt: pullRequests.updatedAt,
    })
    .from(commits)
    .innerJoin(pullRequests, eq(pullRequests.id, commits.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'open'),
        isNull(commits.messageHeadline),
      ),
    )
    .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id))
    .limit(limit + attempted.size)
    .execute();
  return rows
    .filter((r) => !attempted.has(`${accountId}:${r.id}`))
    .slice(0, limit)
    .map((r) => ({ id: r.id, nodeId: r.nodeId }));
}

export async function backfillCommitHeadlines(
  accountId: number,
  repoId: number,
  log?: Logger,
): Promise<number> {
  if (isLimited(accountId)) return 0;
  const rows = await commitHeadlineBackfillWorklist(accountId, repoId);
  if (rows.length === 0) return 0;

  const token = await getAccessToken(accountId);
  const gql = getGraphqlClientFor(token);
  const byNode = new Map(rows.map((r) => [r.nodeId, r] as const));
  let written = 0;

  for (let i = 0; i < rows.length; i += COMMIT_HEADLINE_NODE_BATCH) {
    if (isLimited(accountId)) break;
    const batchRows = rows.slice(i, i + COMMIT_HEADLINE_NODE_BATCH);
    let res: CommitHeadlineNodesResponse;
    try {
      res = await graphqlTolerant<CommitHeadlineNodesResponse>(
        gql,
        COMMIT_HEADLINE_NODES_QUERY,
        { ids: batchRows.map((r) => r.nodeId) },
        () => log?.warn('commit headline backfill: partial GraphQL response'),
      );
    } catch (err) {
      const rl = isRateLimitError(err);
      if (rl.limited) {
        noteLimited(accountId, rl.resumeAt);
        break;
      }
      throw err;
    }
    // Asked, whatever came back — a PR GitHub will not serve is not asked again this process.
    for (const r of batchRows) attempted.add(`${accountId}:${r.id}`);
    if (res.rateLimit) {
      noteBudget(accountId, {
        remaining: res.rateLimit.remaining ?? null,
        resetAt: parseResetAt(res.rateLimit.resetAt),
      });
    }
    const writes: { prId: number; sha: string; headline: string }[] = [];
    for (const n of res.nodes ?? []) {
      if (n == null || typeof n.id !== 'string') continue;
      // Only PRs this account's worklist asked for — matched back by node id.
      const row = byNode.get(n.id);
      if (!row || !n.commits) continue;
      for (const c of n.commits.nodes ?? []) {
        const oid = c?.commit?.oid;
        const headline = c?.commit?.messageHeadline;
        // A nulled or absent headline was not received: write nothing.
        if (typeof oid !== 'string' || typeof headline !== 'string') continue;
        writes.push({ prId: row.id, sha: oid, headline: headline.slice(0, HEADLINE_MAX_CHARS) });
      }
    }
    if (writes.length === 0) continue;
    await runTransaction(async (tx) => {
      for (const w of writes) {
        const hit = await tx
          .update(commits)
          .set({ messageHeadline: w.headline })
          .where(
            and(
              eq(commits.prId, w.prId),
              eq(commits.sha, w.sha),
              // Never overwrite what a walk wrote in the meantime.
              isNull(commits.messageHeadline),
            ),
          )
          .returning({ id: commits.id })
          .execute();
        written += hit.length;
      }
    });
  }
  if (written > 0) log?.info(`commit headline backfill: ${written} commit(s)`);
  return written;
}

/** Exposed for the unit test. */
export const __commitHeadlineBackfillTesting = {
  COMMIT_HEADLINE_NODE_BATCH,
  resetAttempted: (): void => attempted.clear(),
};
