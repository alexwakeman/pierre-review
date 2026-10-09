import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { TrackerContext } from '../context.js';
import { githubAccessFor } from '../context.js';
import { isBudgetLow } from '../../github/rate-budget.js';
import { JiraFetchError } from '../jira/fetch.js';
import { githubGraphql, noteGithubBudget } from './reader.js';

// DOES THIS REPO USE GITHUB ISSUES? — the fact behind the AUTOMATIC default tracker (migration 0094;
// docs/TRACKERS.md § Automatic default). A repo uses GitHub Issues when issues are ENABLED on it and
// at least one issue was linked to a pull request in the last `USAGE_WINDOW_DAYS`.
//
// ⚠ WHY ONE QUERY, AND WHY NOT THE STORED LINKS. `pull_requests.closing_issues` is read only for
// workspaces that ALREADY use GitHub Issues (./links.ts), so it can never be what first switches a
// workspace on, and `hasIssuesEnabled` is not on the repo walk. So both facts come from ONE small
// GraphQL call: `repository.hasIssuesEnabled` plus a `search` that returns only `issueCount` for
// `repo:<o/n> is:issue linked:pr updated:>=<90 days ago>` — measured at 1 point, no pagination, and
// exact where an `issues(filterBy:{since})` walk would have to page through timeline items to find a
// PR closer. (`linked:pr` is GitHub's own "linked to a pull request" — a closing reference or a
// Development-panel link.) It runs from the tracker tick, at most ONCE A DAY per repo, and ONLY for
// repos in a workspace with no stored tracker choice — a workspace that chose costs nothing.
//
// ⚠ A COLUMN IS WRITTEN ONLY ON A POSITIVE ANSWER. `graphqlTolerant` hands back nulled selections
// on a partial failure, so a null `hasIssuesEnabled` or `issueCount` leaves `uses_github_issues` as it
// was; `github_issues_checked_at` stamps every completed attempt so a refusing repo is not hammered.
// A low budget or a limit stops the pass with nothing stamped (rate limits are pre-empted, never
// surfaced).

export const USAGE_WINDOW_DAYS = 90;
export const USAGE_RECHECK_MS = 24 * 60 * 60_000;
/** Repos asked per tick, over every account. */
export const USAGE_PER_TICK = 10;

export const REPO_ISSUES_USAGE_QUERY = /* GraphQL */ `
  query TrackerRepoIssuesUsage($owner: String!, $name: String!, $q: String!) {
    repository(owner: $owner, name: $name) { hasIssuesEnabled }
    search(query: $q, type: ISSUE, first: 1) { issueCount }
    rateLimit { cost remaining resetAt }
  }
`;

interface UsageResponse {
  repository?: { hasIssuesEnabled?: boolean | null } | null;
  search?: { issueCount?: number | null } | null;
  rateLimit?: { remaining?: number | null; resetAt?: string | null } | null;
}

/** The search string for one repo at `nowMs`. */
export function usageSearchQuery(owner: string, name: string, nowMs: number): string {
  const since = new Date(nowMs - USAGE_WINDOW_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
  return `repo:${owner}/${name} is:issue linked:pr updated:>=${since}`;
}

/** A response → true / false, or null when GitHub did not positively answer. */
export function usageOf(data: UsageResponse | null): boolean | null {
  const enabled = data?.repository?.hasIssuesEnabled;
  if (enabled === false) return false;
  if (enabled !== true) return null;
  const count = data?.search?.issueCount;
  return typeof count === 'number' ? count > 0 : null;
}

interface DueRepo {
  id: number;
  accountId: number;
  owner: string;
  name: string;
  usesGithubIssues: boolean | null;
  checkedAt: Date | null;
}

/** Repos in a workspace with NO stored tracker choice, not asked in the last day, oldest first. */
async function dueRepos(ctx: TrackerContext, nowMs: number, limit: number): Promise<DueRepo[]> {
  const r = ctx.schema.repos;
  const wr = ctx.schema.workspaceRepos;
  const t = ctx.schema.workspaceTrackers;
  // A narrow test context may carry no `repos` table, or one without the 0094 columns.
  if (r?.usesGithubIssues == null || wr == null) return [];
  const cutoff = new Date(nowMs - USAGE_RECHECK_MS);
  const rows = (await ctx.db
    .selectDistinct({
      id: r.id,
      accountId: r.accountId,
      owner: r.owner,
      name: r.name,
      usesGithubIssues: r.usesGithubIssues,
      checkedAt: r.githubIssuesCheckedAt,
    })
    .from(wr)
    .innerJoin(r, and(eq(r.id, wr.repoId), eq(r.accountId, wr.accountId)))
    .leftJoin(t, and(eq(t.accountId, wr.accountId), eq(t.workspaceId, wr.workspaceId)))
    .where(and(isNull(t.provider), or(isNull(r.githubIssuesCheckedAt), lt(r.githubIssuesCheckedAt, cutoff))))
    .execute()) as DueRepo[];
  // Never asked first, then the oldest answer (sorted here: NULL ordering differs by dialect).
  // ⚠ A BUDGET-LOW ACCOUNT IS DROPPED BEFORE THE SLICE. Its rows would be refused (429, nothing
  // stamped) and, sorted first for ever, would starve every other account's repos of a check.
  const at = (d: Date | null): number => (d == null ? -1 : new Date(d).getTime());
  return rows
    .filter((x) => !isBudgetLow(x.accountId))
    .sort((a, b) => at(a.checkedAt) - at(b.checkedAt) || a.id - b.id)
    .slice(0, limit);
}

/**
 * Ask GitHub about up to `limit` due repos. Returns the accounts where a repo newly answered TRUE
 * (the caller kicks their ticket pass). Never throws.
 */
export async function refreshGithubIssuesUsage(
  ctx: TrackerContext,
  opts: { now?: () => number; limit?: number } = {},
): Promise<{ asked: number; switchedOn: Set<number> }> {
  const nowMs = (opts.now ?? Date.now)();
  const switchedOn = new Set<number>();
  let asked = 0;
  if (ctx.github == null) return { asked, switchedOn };
  let due: DueRepo[];
  try {
    due = await dueRepos(ctx, nowMs, opts.limit ?? USAGE_PER_TICK);
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err), route: 'tracker-issues-usage' }, 'GitHub Issues usage not checked');
    return { asked, switchedOn };
  }
  const limitedAccounts = new Set<number>();
  for (const repo of due) {
    if (limitedAccounts.has(repo.accountId)) continue;
    const outcome = await askRepo(ctx, repo, nowMs);
    if (outcome === 'limited') {
      limitedAccounts.add(repo.accountId);
      continue;
    }
    if (outcome === 'skipped') continue;
    asked += 1;
    if (outcome === true && repo.usesGithubIssues !== true) switchedOn.add(repo.accountId);
  }
  return { asked, switchedOn };
}

/**
 * Ask GitHub about ONE repo and store the answer. `'limited'` = budget/limit (nothing stamped),
 * `'skipped'` = no GitHub access; otherwise the stored answer (null = GitHub did not positively say).
 */
async function askRepo(ctx: TrackerContext, repo: DueRepo, nowMs: number): Promise<boolean | null | 'limited' | 'skipped'> {
  const gh = githubAccessFor(ctx, repo.accountId);
  if (gh == null) return 'skipped';
  if (isBudgetLow(repo.accountId)) return 'limited';
  let answer: boolean | null = null;
  try {
    const { data } = await githubGraphql<UsageResponse>(gh, REPO_ISSUES_USAGE_QUERY, {
      owner: repo.owner,
      name: repo.name,
      q: usageSearchQuery(repo.owner, repo.name, nowMs),
    });
    noteGithubBudget(repo.accountId, data?.rateLimit);
    answer = usageOf(data);
  } catch (err) {
    const code = err instanceof JiraFetchError ? err.code : 'unknown';
    const status = err instanceof JiraFetchError ? err.status : null;
    // A low budget or a limit: this account waits for a later tick, nothing stamped.
    if (status === 429) return 'limited';
    ctx.log.warn({ accountId: repo.accountId, repoId: repo.id, code, route: 'tracker-issues-usage' }, 'GitHub Issues usage not read (asked again tomorrow)');
  }
  const r = ctx.schema.repos;
  await ctx.db
    .update(r)
    .set(answer == null ? { githubIssuesCheckedAt: new Date(nowMs) } : { usesGithubIssues: answer, githubIssuesCheckedAt: new Date(nowMs) })
    .where(and(eq(r.accountId, repo.accountId), eq(r.id, repo.id)))
    .execute();
  return answer;
}

/**
 * ONCE PER WORKSPACE ADD: ask about these repos NOW, whatever their last answer's age and whatever
 * the target workspace's tracker choice, so a repo joining a workspace switches its automatic
 * default on (or off) at once instead of waiting for the daily tick. Account-scoped; at most
 * `USAGE_PER_TICK` repos per call (the tick picks up any rest). Returns whether a repo newly
 * answered TRUE. Never throws.
 */
export async function checkReposGithubIssuesUsage(
  ctx: TrackerContext,
  accountId: number,
  repoIds: readonly number[],
  opts: { now?: () => number; onlyUnasked?: boolean } = {},
): Promise<{ asked: number; switchedOn: boolean }> {
  const r = ctx.schema.repos;
  let asked = 0;
  let switchedOn = false;
  if (ctx.github == null || r?.usesGithubIssues == null || repoIds.length === 0) return { asked, switchedOn };
  const nowMs = (opts.now ?? Date.now)();
  try {
    const rows = (await ctx.db
      .select({
        id: r.id,
        accountId: r.accountId,
        owner: r.owner,
        name: r.name,
        usesGithubIssues: r.usesGithubIssues,
        checkedAt: r.githubIssuesCheckedAt,
      })
      .from(r)
      .where(
        and(
          eq(r.accountId, accountId),
          inArray(r.id, [...new Set(repoIds)].slice(0, USAGE_PER_TICK)),
          opts.onlyUnasked ? isNull(r.githubIssuesCheckedAt) : undefined,
        ),
      )
      .execute()) as DueRepo[];
    for (const repo of rows) {
      const outcome = await askRepo(ctx, repo, nowMs);
      if (outcome === 'limited' || outcome === 'skipped') break;
      asked += 1;
      if (outcome === true && repo.usesGithubIssues !== true) switchedOn = true;
    }
  } catch (err) {
    ctx.log.warn({ accountId, err: err instanceof Error ? err.message : String(err), route: 'tracker-issues-usage' }, 'GitHub Issues usage not checked on add');
  }
  return { asked, switchedOn };
}
