import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';
import type {
  BranchCheckRun,
  BranchCommit,
  BranchStatusResponse,
  CiStatus,
} from '@pierre-review/shared';

const { repos, users, branchCommits, pullRequests } = schema;

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
      failingChecks: branchCommits.failingChecks,
      prNumber: branchCommits.prNumber,
      authorLogin: users.githubLogin,
      authorUserAvatarUrl: users.avatarUrl,
    })
    .from(branchCommits)
    .leftJoin(users, eq(users.id, branchCommits.authorUserId))
    .where(and(eq(branchCommits.accountId, accountId), inArray(branchCommits.repoId, ids)))
    .orderBy(desc(branchCommits.committedAt))
    .execute();

  // Resolve each commit's associated PR NUMBER (stored by the branch sync) to the LOCAL
  // pull_requests row, so the client's chip can open that PR's own detail tab instead of leaving
  // the app. One extra query, bounded by the distinct numbers across the scoped repos' windows.
  //
  // Isolation: the predicate carries `accountId` AND restricts to `ids` — the repo ids already
  // resolved from the account-scoped `repos` listing above — so a number can only ever match a PR
  // THIS account synced. A number that belongs to another tenant's data cannot resolve.
  //
  // The map key is `(repoId, number)`, NEVER the bare number: PR numbers are unique only WITHIN a
  // repo, so a number-keyed map would cross-link repo A's #12 onto repo B's commit and open the
  // wrong PR. The `inArray × inArray` predicate deliberately over-matches (it can return repo A's
  // #12 when only repo B asked for it); keying by the pair is what makes that harmless. A future
  // "simplification" to a bare number key is silently wrong, which is why there is a seeded test
  // for it rather than only this comment.
  const prNumbers = [
    ...new Set(commitRows.map((c) => c.prNumber).filter((n): n is number => n != null)),
  ];
  const prIdByRepoNumber = new Map<string, number>();
  if (prNumbers.length > 0) {
    const prRows = await db
      .select({
        id: pullRequests.id,
        repoId: pullRequests.repoId,
        number: pullRequests.number,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, ids),
          inArray(pullRequests.number, prNumbers),
        ),
      )
      .execute();
    for (const p of prRows) prIdByRepoNumber.set(`${p.repoId}:${p.number}`, p.id);
  }

  // The HEAD commit's failing checks, keyed by `(repoId, sha)` over the UNCAPPED rows. Matching by
  // SHA rather than by position is load-bearing: `commits` below is ordered by committer date and
  // then CAPPED, and a backdated committer date (a rebase, or a cherry-pick with
  // --committer-date-is-author-date) can sort the head commit outside the cap — which would give
  // an empty summary on a repo whose ciStatus says failure. Built from `commitRows` for that
  // reason, never from the capped list.
  const failingByRepoSha = new Map<string, BranchCheckRun[]>();
  for (const c of commitRows) {
    if (c.failingChecks != null) {
      failingByRepoSha.set(`${c.repoId}:${c.sha}`, c.failingChecks);
    }
  }

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
      // Nullable for two reasons — "no failures observed" and "written before this column
      // existed" — and the wire type is a plain array either way, so the client's caret rule is
      // one length check rather than a null dance.
      failingChecks: c.failingChecks ?? [],
      // The number is emitted even when it resolves to nothing: the client falls back to a
      // github.com link for a PR this account never synced (squash-merged before the backfill
      // window, or in a repo added later), which beats dropping the reference.
      prNumber: c.prNumber ?? null,
      prId:
        c.prNumber != null
          ? (prIdByRepoNumber.get(`${c.repoId}:${c.prNumber}`) ?? null)
          : null,
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
        // Derived, not a second stored copy: the head commit's own row already holds its failures.
        // Matched by SHA against the uncapped rows (see failingByRepoSha); no match — a trimmed
        // head, or nothing synced yet — degrades to the CI label alone.
        failingChecks:
          r.headSha != null ? (failingByRepoSha.get(`${r.id}:${r.headSha}`) ?? []) : [],
        // The newest commit's own timestamp, not our observation time (`defaultBranchUpdatedAt`
        // is when we LOOKED, which would make an idle repo read as freshly active).
        lastCommitAt: commits[0]?.committedAt ?? null,
        commits,
      };
    }),
  };
}
