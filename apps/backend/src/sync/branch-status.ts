import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema, runTransaction } from '../db/client.js';
import { getGraphqlClientFor, graphqlTolerant, withGithubRetry } from '../github/client.js';
import {
  DEFAULT_BRANCH_QUERY,
  type DefaultBranchResponse,
  type GqlBranchCommit,
} from '../github/branch-queries.js';
// One shared mapper: GitHub's `StatusState` enum is identical on a Commit's rollup and on a PR
// head's, so this reuses sync/upsert.ts's rather than keeping a second copy that could drift.
import { ciStatusFrom } from './upsert.js';
import type { CiStatus } from '@pierre-review/shared';

const { repos, users, branchCommits } = schema;

// How many trunk commits we keep per repo. Also the GraphQL page size, so the fetch and the
// retained window are the same number by construction — a smaller fetch would leave stale rows
// alive below it, a larger one would write rows the trim immediately deletes.
export const BRANCH_COMMIT_WINDOW = 20;

export interface BranchSyncLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}


export interface SyncBranchStatusOptions {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  log?: BranchSyncLogger;
}

export interface BranchStatusSyncResult {
  branchName: string | null;
  headSha: string | null;
  ciStatus: CiStatus;
  commitCount: number;
  rateLimitCost: number;
}

/**
 * Snapshot a repo's DEFAULT BRANCH: its head sha + CI rollup onto `repos`, and the most recent
 * `BRANCH_COMMIT_WINDOW` trunk commits (with their own per-commit CI state) into
 * `branch_commits`.
 *
 * Why this can't come from the existing tables: `commits` is PR-scoped, and a squash-merged PR
 * never appears there under the SHA that actually landed on trunk. So "is main green, and what
 * landed on it" is unanswerable without its own read.
 *
 * Idempotent — commits upsert on `(accountId, repoId, sha)`, so a re-sync of the same window
 * updates each commit's CI state in place (a commit that was `pending` last tick becomes
 * `success` on this one) rather than duplicating rows.
 *
 * Author mapping is deliberately LOOKUP-ONLY: a trunk committer who resolves to an already-known
 * `users` row gets `authorUserId` (so the UI can render their synced avatar + the maintainer
 * shield); anyone else is stored as raw `authorName`/`authorAvatarUrl`. We do NOT insert users
 * here — `users` is a GLOBAL table, and creating rows for every drive-by trunk committer would
 * grow it with identities that appear nowhere else in the account's data.
 */
export async function syncBranchStatus(
  opts: SyncBranchStatusOptions,
): Promise<BranchStatusSyncResult> {
  const { owner, name, repoId, accountId, token } = opts;
  const client = getGraphqlClientFor(token);

  const resp = await withGithubRetry(() =>
    graphqlTolerant<DefaultBranchResponse>(
      client,
      DEFAULT_BRANCH_QUERY,
      { owner, name, first: BRANCH_COMMIT_WINDOW },
      (errors) =>
        opts.log?.warn(
          `branch-status ${owner}/${name}: partial GraphQL — continuing without forbidden fields`,
          errors,
        ),
    ),
  );

  const ref = resp.repository?.defaultBranchRef ?? null;
  const branchName = ref?.name ?? null;
  // `target` is a nullable INTERFACE — a branch whose tip isn't a Commit selects nothing, so
  // every field below is optional even when `target` itself is present.
  const target = ref?.target ?? null;
  const headSha = target?.oid ?? null;
  const headCi = ciStatusFrom(target?.statusCheckRollup?.state);
  const nodes: GqlBranchCommit[] = (target?.history?.nodes ?? []).filter(
    (n): n is GqlBranchCommit => n != null && typeof n.oid === 'string',
  );

  // Resolve the commit authors we already know, in ONE query. GraphQL gives a login only when
  // the commit email maps to a GitHub account; the rest keep their raw git name.
  const logins = [
    ...new Set(
      nodes
        .map((n) => n.author?.user?.login)
        .filter((l): l is string => typeof l === 'string' && l.length > 0),
    ),
  ];
  const userIdByLogin = new Map<string, number>();
  if (logins.length > 0) {
    const rows = await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.githubLogin, logins))
      .execute();
    for (const r of rows) userIdByLogin.set(r.login, r.id);
  }

  await runTransaction(async (tx) => {
    for (const n of nodes) {
      const login = n.author?.user?.login ?? null;
      const authorUserId = login != null ? userIdByLogin.get(login) ?? null : null;
      await tx
        .insert(branchCommits)
        .values({
          accountId,
          repoId,
          sha: n.oid,
          messageHeadline: n.messageHeadline,
          authorUserId,
          // Prefer the git author name; fall back to the login so a commit by a known GitHub
          // account with a blank git name still shows SOMETHING attributable.
          authorName: n.author?.name ?? login,
          authorAvatarUrl: n.author?.avatarUrl ?? null,
          committedAt: new Date(n.committedDate),
          ciStatus: ciStatusFrom(n.statusCheckRollup?.state),
        })
        .onConflictDoUpdate({
          target: [branchCommits.accountId, branchCommits.repoId, branchCommits.sha],
          set: {
            messageHeadline: n.messageHeadline,
            authorUserId,
            authorName: n.author?.name ?? login,
            authorAvatarUrl: n.author?.avatarUrl ?? null,
            committedAt: new Date(n.committedDate),
            ciStatus: ciStatusFrom(n.statusCheckRollup?.state),
          },
        })
        .execute();
    }

    // Trim to the newest window IN the same transaction, so the table can never be observed
    // holding an unbounded history. Done as select-then-delete-by-id rather than a correlated
    // DELETE … LIMIT, which is not portable across sqlite and Postgres.
    const kept = await tx
      .select({ id: branchCommits.id })
      .from(branchCommits)
      .where(and(eq(branchCommits.accountId, accountId), eq(branchCommits.repoId, repoId)))
      .orderBy(desc(branchCommits.committedAt))
      .execute();
    const stale = kept.slice(BRANCH_COMMIT_WINDOW).map((r) => r.id);
    // Guard the empty case: `inArray(col, [])` is a degenerate predicate whose behaviour
    // differs by dialect, and there is nothing to delete anyway.
    if (stale.length > 0) {
      await tx.delete(branchCommits).where(inArray(branchCommits.id, stale)).execute();
    }

    await tx
      .update(repos)
      .set({
        defaultBranchName: branchName,
        defaultBranchHeadSha: headSha,
        defaultBranchCiStatus: headCi,
        defaultBranchUpdatedAt: new Date(),
      })
      // Ownership is part of the predicate, not an assumption about the caller.
      .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
      .execute();
  });

  return {
    branchName,
    headSha,
    ciStatus: headCi,
    commitCount: nodes.length,
    rateLimitCost: resp.rateLimit?.cost ?? 0,
  };
}
