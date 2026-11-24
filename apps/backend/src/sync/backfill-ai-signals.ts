// ONE-TIME AI VENDOR SIGNALS BACKFILL — PRs of the last 90 days the detector has not read at the
// current `AI_SIGNALS_VERSION` (docs/AI-ADOPTION-REPORT.md § The backfill).
//
// `persistPr` scans every PR it writes (shared `detectAiPrSignals` / `detectAiCommitSignals`, on the
// FULL title, description and commit messages while they are in hand), but an incremental walk only
// touches PRs updated since the last one. A PR merged last month, before migration 0219, would never
// be scanned, and the adoption report's "before" window is exactly those PRs. The text is not stored
// (lean storage), so the only way to scan it is to read it again.
//
// So after each walk this re-reads, by node id, up to AI_SIGNALS_BACKFILL_PER_RUN PRs in the repo
// that are open or merged in the last 90 days and whose `ai_signals_version` is NULL or older than
// the detector's: newest first. A detector change that bumps the version re-scans them the same way.
// The write is the SAME columns `persistPr` writes, through the same `aiPrColumnsFor` /
// `aiCommitColumnsFor`. Commit verdicts are written by (pr_id, sha) onto rows the walk stored; a
// commit the walk never stored is not created here. A PR with more than 100 commits is stamped
// anyway: its older commits are never seen (the report's method slide says so).
//
// A PR GitHub does not return, or returns with a selection nulled, is left unstamped; the in-process
// `attempted` set means it is asked for at most once per process, which bounds the waste to one read
// per restart (the backfill-commit-headlines.ts posture).
//
// COST: `nodes(ids:)` over at most AI_SIGNALS_NODE_BATCH PRs with one connection (commits, last 100)
// — about one point per batch; the scalars are free and the payload is the cost. The cheap-consumer
// budget contract: skip while the token is known-limited (`isLimited`) or its budget is low
// (`isBudgetLow`), report a limit through `noteLimited` and stop, feed `noteBudget` on every
// response, never clear `limitedUntil`. A limit is never surfaced as an error. STRICTLY NON-FATAL:
// the sync-manager tails catch and log anything this throws.
import { and, desc, eq, gte, isNull, lt, or } from 'drizzle-orm';
import { AI_SIGNALS_VERSION } from '@pierre-review/shared';
import { db, runTransaction, schema } from '../db/client.js';
import { getAccessToken } from '../auth/account.js';
import { getGraphqlClientFor, graphqlTolerant, isRateLimitError } from '../github/client.js';
import { AI_SIGNALS_NODES_QUERY, type AiSignalsNodesResponse } from '../github/queries.js';
import { isBudgetLow, isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import { aiCommitColumnsFor, aiPrColumnsFor, type AiPrColumns } from './upsert.js';

const { pullRequests, commits } = schema;

/** PRs one repo may scan per walk. Three batches — about three points. */
export const AI_SIGNALS_BACKFILL_PER_RUN = 60;
/** PRs per `nodes(ids:)` read: 20 PRs × 100 commit messages keeps one response a few hundred KB. */
const AI_SIGNALS_NODE_BATCH = 20;
/** How far back a merged PR is worth reading (the adoption report's longest comparison). */
export const AI_SIGNALS_BACKFILL_DAYS = 90;
const DAY_MS = 86_400_000;

/** `${accountId}:${prId}` — asked once per process (see the header). Not a token or data cache. */
const attempted = new Set<string>();

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** `aiPrColumnsFor` answered with columns (not `{}`, "not received"). */
function received<T extends object>(cols: T | Record<string, never>): cols is T {
  return Object.keys(cols).length > 0;
}

function parseResetAt(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The worklist, exported for the test AND verify:isolation. Account + repo scoped; skips PRs
 *  already asked for in this process. `nowMs` is injectable for the test only. */
export async function aiSignalsBackfillWorklist(
  accountId: number,
  repoId: number,
  limit: number = AI_SIGNALS_BACKFILL_PER_RUN,
  nowMs: number = Date.now(),
): Promise<{ id: number; nodeId: string }[]> {
  const since = new Date(nowMs - AI_SIGNALS_BACKFILL_DAYS * DAY_MS);
  const rows = await db
    .select({ id: pullRequests.id, nodeId: pullRequests.githubNodeId })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        or(eq(pullRequests.state, 'open'), gte(pullRequests.mergedAt, since)),
        or(isNull(pullRequests.aiSignalsVersion), lt(pullRequests.aiSignalsVersion, AI_SIGNALS_VERSION)),
      ),
    )
    // Newest first: the report's "after" window, then its "before" window.
    .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id))
    .limit(limit + attempted.size)
    .execute();
  return rows
    .filter((r) => !attempted.has(`${accountId}:${r.id}`))
    .slice(0, limit)
    .map((r) => ({ id: r.id, nodeId: r.nodeId }));
}

export async function backfillAiSignals(accountId: number, repoId: number, log?: Logger): Promise<number> {
  if (isLimited(accountId) || isBudgetLow(accountId)) return 0;
  const rows = await aiSignalsBackfillWorklist(accountId, repoId);
  if (rows.length === 0) return 0;

  const token = await getAccessToken(accountId);
  const gql = getGraphqlClientFor(token);
  const byNode = new Map(rows.map((r) => [r.nodeId, r] as const));
  let stamped = 0;

  for (let i = 0; i < rows.length; i += AI_SIGNALS_NODE_BATCH) {
    if (isLimited(accountId) || isBudgetLow(accountId)) break;
    const batchRows = rows.slice(i, i + AI_SIGNALS_NODE_BATCH);
    let res: AiSignalsNodesResponse;
    try {
      res = await graphqlTolerant<AiSignalsNodesResponse>(
        gql,
        AI_SIGNALS_NODES_QUERY,
        { ids: batchRows.map((r) => r.nodeId) },
        () => log?.warn('AI signals backfill: partial GraphQL response'),
      );
    } catch (err) {
      const rl = isRateLimitError(err);
      if (rl.limited) {
        // Pre-empted, never an error: the budget remembers it and the next walk resumes.
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
    // Detected BEFORE the transaction (the `persistPr` rule): pure CPU over author-written text
    // never runs while the write lock is held.
    const writes: { prId: number; pr: AiPrColumns; commits: { sha: string; aiSignals: string }[] }[] = [];
    for (const n of res.nodes ?? []) {
      if (n == null || typeof n.id !== 'string') continue;
      // Only PRs this account's worklist asked for, matched back by node id — a node GitHub
      // returned that is not in this batch cannot reach a write.
      const row = byNode.get(n.id);
      if (!row) continue;
      const prColumns = aiPrColumnsFor(n);
      // Not received (a nulled title, body or commit message): write nothing, leave it unstamped.
      if (!received<AiPrColumns>(prColumns)) continue;
      const commitWrites: { sha: string; aiSignals: string }[] = [];
      for (const cn of n.commits?.nodes ?? []) {
        const c = cn?.commit;
        if (c == null || typeof c.oid !== 'string') continue;
        const cols = aiCommitColumnsFor(c);
        if (received<{ aiSignals: string }>(cols)) commitWrites.push({ sha: c.oid, aiSignals: cols.aiSignals });
      }
      writes.push({ prId: row.id, pr: prColumns, commits: commitWrites });
    }
    if (writes.length === 0) continue;
    await runTransaction(async (tx) => {
      for (const w of writes) {
        for (const c of w.commits) {
          await tx
            .update(commits)
            .set({ aiSignals: c.aiSignals })
            .where(and(eq(commits.prId, w.prId), eq(commits.sha, c.sha)))
            .execute();
        }
        const hit = await tx
          .update(pullRequests)
          .set(w.pr)
          .where(and(eq(pullRequests.id, w.prId), eq(pullRequests.accountId, accountId)))
          .returning({ id: pullRequests.id })
          .execute();
        stamped += hit.length;
      }
    });
  }
  if (stamped > 0) log?.info(`AI signals backfill: ${stamped} pull request(s)`);
  return stamped;
}

/** Exposed for the unit test. */
export const __aiSignalsBackfillTesting = {
  AI_SIGNALS_NODE_BATCH,
  resetAttempted: (): void => attempted.clear(),
};
