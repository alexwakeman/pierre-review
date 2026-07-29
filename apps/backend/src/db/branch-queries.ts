import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';
import type { BranchCommit, BranchStatusResponse, CiStatus } from '@pierre-review/shared';

const { repos, users, branchCommits } = schema;

// Kept in lockstep with `sync/branch-status.ts`'s BRANCH_COMMIT_WINDOW — the sync trims to this
// many rows per repo, so the read cap only ever matters if the two drift.
const READ_COMMIT_CAP = 20;

/**
 * Default-branch health for every repo in scope: the stored head snapshot plus that branch's
 * recent commits.
 *
 * Account-scoped on BOTH tables independently. `branch_commits.accountId` is denormalized
 * precisely so the commit read is a single indexed predicate rather than a join back through
 * `repos` — but the repo listing is scoped too, so a `repoIds` array naming another tenant's
 * repos selects nothing rather than leaking rows.
 *
 * Repos with no synced branch data still appear, with nulls: the client renders one row per
 * repo in the visible set, and "unknown" is the truthful state for a repo added a minute ago.
 *
 * `repoIds` null/empty ⇒ every repo the account owns.
 */
export async function getBranchStatus(
  accountId: number,
  repoIds: number[] | null,
): Promise<BranchStatusResponse> {
  const scoped = repoIds != null && repoIds.length > 0;
  const repoRows = await db
    .select({
      id: repos.id,
      branchName: repos.defaultBranchName,
      headSha: repos.defaultBranchHeadSha,
      ciStatus: repos.defaultBranchCiStatus,
      updatedAt: repos.defaultBranchUpdatedAt,
    })
    .from(repos)
    .where(
      scoped
        ? and(eq(repos.accountId, accountId), inArray(repos.id, repoIds))
        : eq(repos.accountId, accountId),
    )
    .execute();

  if (repoRows.length === 0) return { repos: [] };

  const ids = repoRows.map((r) => r.id);
  // One pass over the account's commits for the scoped repos, newest first; bucketed in JS.
  // The whole set is at most `READ_COMMIT_CAP × repos` rows (the sync trims per repo), so there
  // is no per-repo query fan-out and no unbounded result.
  const commitRows = await db
    .select({
      repoId: branchCommits.repoId,
      sha: branchCommits.sha,
      messageHeadline: branchCommits.messageHeadline,
      authorName: branchCommits.authorName,
      authorAvatarUrl: branchCommits.authorAvatarUrl,
      committedAt: branchCommits.committedAt,
      ciStatus: branchCommits.ciStatus,
      authorLogin: users.githubLogin,
      authorUserAvatarUrl: users.avatarUrl,
    })
    .from(branchCommits)
    .leftJoin(users, eq(users.id, branchCommits.authorUserId))
    .where(and(eq(branchCommits.accountId, accountId), inArray(branchCommits.repoId, ids)))
    .orderBy(desc(branchCommits.committedAt))
    .execute();

  const byRepo = new Map<number, BranchCommit[]>();
  for (const c of commitRows) {
    const list = byRepo.get(c.repoId) ?? [];
    if (list.length >= READ_COMMIT_CAP) continue;
    list.push({
      sha: c.sha,
      messageHeadline: c.messageHeadline,
      authorLogin: c.authorLogin ?? null,
      authorName: c.authorName,
      // Prefer the synced user's avatar (kept fresh by every sync) over the one frozen onto the
      // commit row at fetch time; fall back to the commit's own for an unknown committer.
      authorAvatarUrl: c.authorUserAvatarUrl ?? c.authorAvatarUrl,
      committedAt: c.committedAt.toISOString(),
      // The column is nullable ("no CI observed yet"); the wire type is not — 'unknown' is the
      // single "we can't say" value the client already knows how to render.
      ciStatus: (c.ciStatus ?? 'unknown') as CiStatus,
    });
    byRepo.set(c.repoId, list);
  }

  return {
    repos: repoRows.map((r) => {
      const commits = byRepo.get(r.id) ?? [];
      return {
        repoId: r.id,
        branchName: r.branchName,
        headSha: r.headSha,
        ciStatus: (r.ciStatus ?? 'unknown') as CiStatus,
        // The newest commit's own timestamp, not our observation time (`defaultBranchUpdatedAt`
        // is when we LOOKED, which would make an idle repo read as freshly active).
        lastCommitAt: commits[0]?.committedAt ?? null,
        commits,
      };
    }),
  };
}
