// ONE-SHOT DEPENDENCY + SECURITY BACKFILL — open automation PRs the detector has never read.
//
// `persistPr` classifies every PR it writes (sync/security-detect.ts, on the FULL `bodyText`), but
// an incremental walk only touches PRs updated since the last one. An open Dependabot PR that has
// sat untouched since before migration 0067 would otherwise never be classified, and a security
// fix waiting for a merge is exactly the PR that sits untouched.
//
// So after each walk this re-reads, by node id, up to PR_SECURITY_BACKFILL_PER_RUN open PRs in the
// repo whose `security_checked_at` is still NULL and that COULD be dependency automation: an
// automated author (by any of the account-free signals — `users.is_bot`, `github_type = 'Bot'`,
// the vendor and review-bot login tables, Semgrep's per-org prefix) or a tool's own branch/title
// marker (a Snyk fix under a person's token). A human PR with no marker is never fetched — its
// NULL means "not classified", and no reader may take it for "classified clean".
//
// Each PR is stamped when its classification is written, so it is fetched ONCE; a PR GitHub does
// not return — or returns with `bodyText` nulled — is left NULL and retried on a later walk
// (bounded by the per-run cap, never a loop). The write is the SAME four columns `persistPr`
// writes, through the same `securityColumnsFor`.
//
// COST: `nodes(ids:)` over at most PR_SECURITY_NODE_BATCH PRs with one leaf connection (labels) —
// about one point per batch. The cheap-consumer budget contract: skip when the token is already
// known-limited (`isLimited`), report a limit through `noteLimited`, feed `noteBudget`. STRICTLY
// NON-FATAL: a failure here must never be the reason a sync reports failure.
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { db, runTransaction, schema } from '../db/client.js';
import { getAccessToken } from '../auth/account.js';
import { getGraphqlClientFor, graphqlTolerant, isRateLimitError } from '../github/client.js';
import { PR_SECURITY_NODES_QUERY, type PrSecurityNodesResponse } from '../github/queries.js';
import { isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import {
  automationVendorLoginsForSql,
  automationVendorPrefixes,
  reviewBotLogins,
} from './bot-detection.js';
import { securityColumnsFor, type SecurityColumns } from './upsert.js';

const { pullRequests, users } = schema;

/** Open PRs one repo may classify per walk. Three batches — ~3 points, a few seconds. */
export const PR_SECURITY_BACKFILL_PER_RUN = 60;
/** Dependabot bodies run to 65 KB each; 20 × 65 KB keeps one response near 1.3 MB. */
const PR_SECURITY_NODE_BATCH = 20;

/** The tools' own branch prefixes and title prefixes (security-detect.ts's rule 1) — what makes a
 *  PR under a PERSON's account a candidate. ⚠ Exact-case literals: pg `LIKE` is case-sensitive,
 *  and none of these contains `_`, LIKE's single-character wildcard. */
const MARKER_BRANCH_PREFIXES = [
  'dependabot/',
  'renovate/',
  'snyk-fix-',
  'snyk-upgrade-',
  'depfu/',
  'whitesource-remediate/',
  'socket/fix/',
  'frogbot-',
  'cx-ai-agent-',
] as const;
const MARKER_TITLE_PREFIXES = ['[Snyk] ', '[Aikido] ', 'Checkmarx AI Remediation', '[🐸 Frogbot]'] as const;

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

function parseResetAt(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The worklist, exported for the test AND verify:isolation. Account + repo scoped. `labels` is
 *  the STORED list, the fallback when a response arrives with its labels selection nulled. */
export async function prSecurityBackfillWorklist(
  accountId: number,
  repoId: number,
  limit: number = PR_SECURITY_BACKFILL_PER_RUN,
): Promise<{ id: number; nodeId: string; headRefName: string | null; labels: string[] }[]> {
  // Every login in BOTH spellings, lowercased — SQL cannot strip the `[bot]` suffix the way the
  // vocabulary's normaliser does, and `x` / `x[bot]` are separate `users` rows.
  const reviewLogins = reviewBotLogins().map((l) => l.toLowerCase());
  const logins = [
    ...new Set([
      ...automationVendorLoginsForSql(),
      ...reviewLogins,
      ...reviewLogins.map((l) => `${l}[bot]`),
    ]),
  ];
  const loweredLogin = sql`lower(${users.githubLogin})`;
  const automatedAuthors = db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        eq(users.isBot, true),
        eq(users.githubType, 'Bot'),
        inArray(loweredLogin, logins),
        ...automationVendorPrefixes().map((p) => like(loweredLogin, `${p}%`)),
      ),
    );
  const rows = await db
    .select({
      id: pullRequests.id,
      nodeId: pullRequests.githubNodeId,
      headRefName: pullRequests.headRefName,
      labels: pullRequests.labels,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'open'),
        isNull(pullRequests.securityCheckedAt),
        or(
          inArray(pullRequests.authorId, automatedAuthors),
          ...MARKER_BRANCH_PREFIXES.map((p) => like(pullRequests.headRefName, `${p}%`)),
          ...MARKER_TITLE_PREFIXES.map((p) => like(pullRequests.title, `${p}%`)),
        ),
      ),
    )
    // Most recently active first: those are the PRs inside the Pending board's activity floor.
    .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id))
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    headRefName: r.headRefName,
    labels: (r.labels ?? []).map((l) => l.name),
  }));
}

export async function backfillPrSecurity(
  accountId: number,
  repoId: number,
  log?: Logger,
): Promise<number> {
  if (isLimited(accountId)) return 0;
  const rows = await prSecurityBackfillWorklist(accountId, repoId);
  if (rows.length === 0) return 0;

  const token = await getAccessToken(accountId);
  const gql = getGraphqlClientFor(token);
  const byNode = new Map(rows.map((r) => [r.nodeId, r] as const));
  let written = 0;

  for (let i = 0; i < rows.length; i += PR_SECURITY_NODE_BATCH) {
    if (isLimited(accountId)) break;
    const batch = rows.slice(i, i + PR_SECURITY_NODE_BATCH).map((r) => r.nodeId);
    let res: PrSecurityNodesResponse;
    try {
      res = await graphqlTolerant<PrSecurityNodesResponse>(
        gql,
        PR_SECURITY_NODES_QUERY,
        { ids: batch },
        () => log?.warn('security backfill: partial GraphQL response'),
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
    // Only PRs this account's worklist asked for, matched back by node id — a node GitHub returned
    // that is not in this batch cannot reach a write.
    const found = (res.nodes ?? []).filter(
      (n): n is NonNullable<typeof n> => n != null && typeof n.id === 'string' && byNode.has(n.id),
    );
    // Classified BEFORE the transaction (the `persistPr` rule): pure CPU over author-written text
    // never runs while the write lock is held.
    const writes: {
      row: NonNullable<ReturnType<typeof byNode.get>>;
      set: SecurityColumns & { headRefName?: string };
    }[] = [];
    for (const n of found) {
      // `bodyText` and `title` are `String!`: a null is a nulled selection, an absent key a node
      // that is not a PullRequest. Either way nothing was received — write nothing, retry later.
      if (typeof n.bodyText !== 'string' || typeof n.title !== 'string') continue;
      const row = byNode.get(n.id!)!;
      const receivedBranch = typeof n.headRefName === 'string' ? n.headRefName : null;
      const columns = securityColumnsFor({
        title: n.title,
        headRefName: receivedBranch ?? row.headRefName,
        labels: n.labels
          ? n.labels.nodes.flatMap((l) => (l?.name != null ? [l.name] : []))
          : row.labels,
        bodyText: n.bodyText,
      });
      writes.push({
        row,
        set: {
          ...columns,
          // Fill a branch the walk never stored; never overwrite one it did.
          ...(row.headRefName == null && receivedBranch != null ? { headRefName: receivedBranch } : {}),
        },
      });
    }
    await runTransaction(async (tx) => {
      for (const { row, set } of writes) {
        await tx
          .update(pullRequests)
          .set(set)
          .where(and(eq(pullRequests.id, row.id), eq(pullRequests.accountId, accountId)))
          .execute();
        written += 1;
      }
    });
  }
  if (written > 0) log?.info(`security backfill: ${written} pull request(s)`);
  return written;
}

/** Exposed for the unit test. */
export const __prSecurityBackfillTesting = { PR_SECURITY_NODE_BATCH };
