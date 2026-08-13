import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';
import type {
  BranchCheckRun,
  BranchStatusResponse,
  BranchTrendDay,
  BranchTrendsResponse,
  CiStatus,
} from '@pierre-review/shared';

const { repos, users, branchCommits, pullRequests } = schema;

// How many merged PRs the expanded row lists per repo. DELIBERATELY far under what the sync
// retains (`BRANCH_COMMIT_WINDOW` = 100 commits, feeding `getBranchTrends`): the list is a
// glance, deeper history is the trend strip's job — and the cap keeps the hot workspace-wide
// strip's WIRE payload lean. ⚠ The DB read below is bounded by BRANCH_COMMIT_WINDOW × repos,
// not this cap — the JS loop discards the surplus. Accepted for now (indexed read, 60s client
// cache); if it ever matters, the fix is a per-repo windowed subquery, not a lower sync window.
const READ_PR_CAP = 10;

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
  // One pass over the account's commits for the scoped repos, newest first; grouped into their
  // merged PRs in JS. The whole set is at most `BRANCH_COMMIT_WINDOW × repos` rows (the sync
  // trims per repo; the grouping below then keeps only READ_PR_CAP PR groups of each), so there
  // is no per-repo query fan-out and no unbounded result. Commit authors are deliberately not
  // selected any more — the listed unit is the PR, whose author comes off the PR row below.
  const commitRows = await db
    .select({
      repoId: branchCommits.repoId,
      sha: branchCommits.sha,
      messageHeadline: branchCommits.messageHeadline,
      committedAt: branchCommits.committedAt,
      ciStatus: branchCommits.ciStatus,
      failingChecks: branchCommits.failingChecks,
      prNumber: branchCommits.prNumber,
    })
    .from(branchCommits)
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
  const prByRepoNumber = new Map<
    string,
    {
      id: number;
      title: string;
      mergedAt: Date | null;
      authorLogin: string | null;
      authorAvatarUrl: string | null;
    }
  >();
  if (prNumbers.length > 0) {
    const prRows = await db
      .select({
        id: pullRequests.id,
        repoId: pullRequests.repoId,
        number: pullRequests.number,
        title: pullRequests.title,
        mergedAt: pullRequests.mergedAt,
        authorLogin: users.githubLogin,
        authorAvatarUrl: users.avatarUrl,
      })
      .from(pullRequests)
      .leftJoin(users, eq(users.id, pullRequests.authorId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, ids),
          inArray(pullRequests.number, prNumbers),
        ),
      )
      .execute();
    for (const p of prRows)
      prByRepoNumber.set(`${p.repoId}:${p.number}`, {
        id: p.id,
        title: p.title,
        mergedAt: p.mergedAt,
        authorLogin: p.authorLogin ?? null,
        authorAvatarUrl: p.authorAvatarUrl ?? null,
      });
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

  // Consolidate each repo's retained trunk commits into their MERGED PRs. Rows arrive newest
  // first, so groups form in most-recent-commit order; the final per-repo list is then ordered
  // by mergedAt (the PR row's when resolved, else the group's newest commit time) and capped.
  // Direct pushes (prNumber null) are deliberately NOT listed — they stay visible in the trend
  // chart's cells; the list answers "what merged", not "what landed".
  interface PrGroup {
    prNumber: number;
    newestCommitAt: Date;
    ciStatus: CiStatus;
    commits: { sha: string; messageHeadline: string }[];
  }
  const groupsByRepo = new Map<number, Map<number, PrGroup>>();
  const lastCommitAtByRepo = new Map<number, Date>();
  for (const c of commitRows) {
    // Newest raw commit per repo — INDEPENDENT of PR membership, so a direct-push-only repo
    // still reads as recently active (the newest commit's own timestamp, never our observation
    // time: `defaultBranchUpdatedAt` is when we LOOKED, which would make an idle repo read as
    // freshly active).
    if (!lastCommitAtByRepo.has(c.repoId)) lastCommitAtByRepo.set(c.repoId, c.committedAt);
    if (c.prNumber == null) continue;
    const groups = groupsByRepo.get(c.repoId) ?? new Map<number, PrGroup>();
    groupsByRepo.set(c.repoId, groups);
    const g = groups.get(c.prNumber);
    if (g == null) {
      groups.set(c.prNumber, {
        prNumber: c.prNumber,
        newestCommitAt: c.committedAt,
        // The group's rollup is its NEWEST commit's — for a merge-commit PR that is the merge
        // commit itself, i.e. the trunk state this PR produced. Nullable column ("no CI
        // observed") reads as 'unknown' on the wire.
        ciStatus: (c.ciStatus ?? 'unknown') as CiStatus,
        commits: [{ sha: c.sha, messageHeadline: c.messageHeadline }],
      });
    } else {
      g.commits.push({ sha: c.sha, messageHeadline: c.messageHeadline });
    }
  }

  return {
    repos: repoRows.map((r) => {
      const groups = [...(groupsByRepo.get(r.id)?.values() ?? [])];
      const mergedPrs = groups
        .map((g) => {
          const pr = prByRepoNumber.get(`${r.id}:${g.prNumber}`);
          return {
            prNumber: g.prNumber,
            // Null while prNumber is set means "that PR isn't synced for this account"
            // (squash-merged before the backfill window, or a repo added later): the client
            // links out to github.com rather than dropping the reference.
            prId: pr?.id ?? null,
            title: pr?.title ?? null,
            authorLogin: pr?.authorLogin ?? null,
            authorAvatarUrl: pr?.authorAvatarUrl ?? null,
            // "In the order they were merged": the PR row's mergedAt when resolved, else the
            // newest consolidated commit's time — never null, so the sort below is total.
            mergedAt: (pr?.mergedAt ?? g.newestCommitAt).toISOString(),
            ciStatus: g.ciStatus,
            commits: g.commits,
          };
        })
        .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
        .slice(0, READ_PR_CAP);
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
        lastCommitAt: lastCommitAtByRepo.get(r.id)?.toISOString() ?? null,
        mergedPrs,
      };
    }),
  };
}

// Trend window for `getBranchTrends`. Exported because the sync side keys off the SAME number
// twice: the trim in sync/branch-status.ts retains rows inside this window even beyond its
// 100-commit bound (so the one-time history backfill survives the next tick), and the backfill
// itself fetches `history(since: now − TREND_DAYS)`. This read filter is ALSO where the "no
// year-old bars" promise lives — the writer never deletes a row the newest-100 bound protects,
// however old (see the trim's comment).
export const TREND_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * The ONE lazy series behind an expanded default-branch row: per UTC day, failing trunk commits
 * (the DayStrip cells) and PRs merged into the default branch (the line band above them) — a
 * single shared axis, dense from the oldest retained commit day to today, so the two facts
 * align cell-for-cell.
 *
 * Fetched only when a row expands — deliberately NOT part of `getBranchStatus`, whose payload is
 * a hot workspace-wide read. Bucketed in JS rather than SQL date functions (dialect-divergent),
 * which is fine because the sync trims `branch_commits` to ≤100 rows per repo and the merged-PR
 * read is bounded by the axis window.
 *
 * Returns null when the repo isn't owned by the account (→ 404 at the route).
 */
export async function getBranchTrends(
  accountId: number,
  repoId: number,
): Promise<BranchTrendsResponse | null> {
  const repoRows = await db
    .select({ id: repos.id, defaultBranchName: repos.defaultBranchName })
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
    .execute();
  const repo = repoRows[0];
  if (repo == null) return null;

  const now = Date.now();

  const commitRows = await db
    .select({ committedAt: branchCommits.committedAt, ciStatus: branchCommits.ciStatus })
    .from(branchCommits)
    .where(
      and(
        eq(branchCommits.accountId, accountId),
        eq(branchCommits.repoId, repoId),
        gte(branchCommits.committedAt, new Date(now - TREND_DAYS * DAY_MS)),
      ),
    )
    .execute();

  const failedByDay = new Map<string, number>();
  const passedByDay = new Map<string, number>();
  for (const c of commitRows) {
    const day = c.committedAt.toISOString().slice(0, 10);
    // "Failed" is the red rollup pair — the same predicate as the strip's own failing count —
    // and "passed" is 'success' alone: pending/unknown/null are neither, so a day's cell can
    // legitimately show fewer commits than landed.
    if (c.ciStatus === 'failure' || c.ciStatus === 'error') {
      failedByDay.set(day, (failedByDay.get(day) ?? 0) + 1);
    } else if (c.ciStatus === 'success') {
      passedByDay.set(day, (passedByDay.get(day) ?? 0) + 1);
    }
  }
  // The axis is dense from the OLDEST RETAINED commit day to today, zero-filled — but never
  // padded back to the full 90 days: on a busy repo the 100-commit cap trims inside the date
  // window, and days before the oldest retained commit are trimmed history, not quiet days.
  // Padding them would draw a green past we never observed. The merged-PR line shares this
  // axis on purpose (that is the whole point of the single chart), so it is truncated to the
  // same span even though pullRequests could answer further back.
  const oldestDay = commitRows
    .map((c) => c.committedAt.toISOString().slice(0, 10))
    .sort()[0];
  const daily: BranchTrendDay[] = [];
  if (oldestDay != null) {
    const startMs = Date.parse(`${oldestDay}T00:00:00Z`);
    const endMs = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);

    // PRs merged into the default branch, counted per UTC day of `mergedAt`. `baseRefName =
    // <default branch>` excludes NULL bases by construction (SQL equality) and on PURPOSE — an
    // unhydrated base is not evidence the PR landed on trunk. A repo whose default branch name
    // we haven't synced yet has nothing attributable, so its line is flat zero rather than a
    // guess.
    const mergedByDay = new Map<string, number>();
    if (repo.defaultBranchName != null) {
      const mergedRows = await db
        .select({ mergedAt: pullRequests.mergedAt })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.accountId, accountId),
            eq(pullRequests.repoId, repoId),
            eq(pullRequests.baseRefName, repo.defaultBranchName),
            gte(pullRequests.mergedAt, new Date(startMs)),
          ),
        )
        .execute();
      for (const p of mergedRows) {
        // The predicate already excludes NULL mergedAt; the guard is for the type, not the data.
        if (p.mergedAt == null) continue;
        const day = p.mergedAt.toISOString().slice(0, 10);
        mergedByDay.set(day, (mergedByDay.get(day) ?? 0) + 1);
      }
    }

    for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
      const day = new Date(ms).toISOString().slice(0, 10);
      daily.push({
        day,
        failed: failedByDay.get(day) ?? 0,
        passed: passedByDay.get(day) ?? 0,
        merged: mergedByDay.get(day) ?? 0,
      });
    }
  }

  return { repoId, daily };
}
