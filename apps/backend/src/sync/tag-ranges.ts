// TAG RANGES (docs/RELEASES.md § Terms → Range of a version tag) — for each tag on the default
// branch, the PRs merged INTO THE DEFAULT BRANCH between it and the tag before it, stored in
// `repo_tag_ranges`. Runs after the tag sync (sync/repo-tags.ts). STRICTLY NON-FATAL, BUDGET-AWARE.
//
// WHY AN INCREMENT, NOT THE RELEASE RANGE. The release check needs "the PRs after the baseline up to
// this version tag". The baseline moves with every release and depends on the workspace's suffix; the
// INCREMENT (previous tag, this tag] depends on neither. So each increment is computed ONCE per
// (tag sha, base sha) and the check sums increments from the baseline up (a pure fold, on a view, with
// no GitHub call). Tags sharing a commit (a release tag on its version tag's commit) have an EMPTY
// increment — no request is made for them.
//
//   order   tags on the default branch with a known commit date, oldest first: by commit date,
//           then tag date, then name. The base of a tag is the one before it.
//   compute 'compare': REST compare base...tag, ≤ TAG_RANGE_MAX_COMMITS commits (past it the row is
//           `truncated`). Each commit → PR by the stored `merge_commit_oid`, then by the stored PR
//           commits, then (≤ COMMIT_PR_FALLBACK_MAX commits) GraphQL `associatedPullRequests` —
//           only PRs of THIS repo merged into its default branch count. 'history': the OLDEST tag
//           has no base, so its range is every stored PR merged into the default branch no later
//           than its commit — PRs older than the synced history are not checked.
//   bounds  ONLY A RELEASABLE REPO gets ranges (ticked "Released from this workspace" in a workspace
//           with both suffixes set, db/release-repos.ts `releaseRangeViews`); any other repo's stored
//           ranges are dropped. Per such workspace: every tag after its BASELINE (the newer of the
//           newest release tag and the reader's start tag), or the newest TAG_RANGE_WINDOW tags with
//           no baseline (`tagRangeKeepFrom`). At most TAG_RANGES_PER_SYNC are computed per run, newest
//           first; the rest go next run (the settle sweep asks again soon, `needsTagCatchUp`). Skipped
//           while the account's budget is low or limited. A failed compare leaves the old row (if
//           any) and is retried next run.
//   moves   a tag whose sha changed is recomputed and the row keeps `moved_from_sha`.
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import {
  TAG_RANGE_WINDOW as SHARED_TAG_RANGE_WINDOW,
  compareTagOrder as sharedCompareTagOrder,
  tagRangeKeepFrom,
  type ReleaseRangeView,
} from '@pierre-review/shared';
import { db, schema, runTransaction } from '../db/client.js';
import { releaseRangeViews } from '../db/release-repos.js';
import {
  getGraphqlClientFor,
  graphqlTolerant,
  isRateLimitError,
  withGithubRetry,
} from '../github/client.js';
import { isBudgetLow, isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import {
  buildCommitPrsQuery,
  COMMIT_PRS_ALIAS_CAP,
  fetchComparePage,
  type CommitPrsResponse,
  type GqlCommitPrsNode,
  type RestCompareResponse,
} from '../github/tag-queries.js';

const { repos, repoTags, repoTagRanges, pullRequests, commits } = schema;

/** With no baseline, the newest tags on the default branch that get a range (shared, the fold reads it
 *  too). With a baseline, every tag after it (`tagRangeKeepFrom`). */
export const TAG_RANGE_WINDOW = SHARED_TAG_RANGE_WINDOW;
/** Ranges computed per run (a releasable repo is the only one that gets any): the whole window, so a
 *  repo with no baseline catches up in one run when the budget allows. */
export const TAG_RANGES_PER_SYNC = SHARED_TAG_RANGE_WINDOW;
/** Commits read from one compare (10 pages of 100). */
export const TAG_RANGE_MAX_COMMITS = 1000;
const COMPARE_PAGE = 100;
/** Unmatched commits asked about through GraphQL per range: every one read (an unasked commit could
 *  hide a PR, and a range is never recomputed once stored). */
export const COMMIT_PR_FALLBACK_MAX = TAG_RANGE_MAX_COMMITS;

export interface RangeTag {
  name: string;
  sha: string;
  committedAt: Date | null;
  taggedAt: Date | null;
  onDefaultBranch: boolean | null;
}

export interface StoredRange {
  tagName: string;
  sha: string;
  baseTagName: string | null;
  baseSha: string | null;
}

export interface RangeWork {
  tag: RangeTag;
  /** The tag before it on the default branch; null for the oldest. */
  base: RangeTag | null;
  /** The stored row's sha, when the tag has MOVED since it was computed. */
  movedFromSha: string | null;
}

export interface RangePlan {
  work: RangeWork[];
  /** Stored ranges whose tag is gone, off the default branch, or out of the window. */
  deleteTagNames: string[];
}

/** Oldest first — THE ONE tag order, shared with the release check (shared `compareTagOrder`). */
export function compareTagOrder(a: RangeTag, b: RangeTag): number {
  return sharedCompareTagOrder(a, b);
}

/**
 * Which ranges to (re)compute and which stored rows to drop. A range is (re)computed when it is
 * missing, its tag moved, or its base changed (another tag was cut between, or the base moved).
 * Newest first, at most `perSync`. `views` = every workspace releasing this repo (its suffixes and
 * start tag): ranges after each one's baseline, or the window without one; NO view ⇒ no range at all
 * (every stored one dropped). `views` left out ⇒ the window alone (the planner's own tests). Pure.
 */
export function planTagRanges(
  tags: RangeTag[],
  stored: StoredRange[],
  opts: { window?: number; perSync?: number; views?: readonly ReleaseRangeView[] } = {},
): RangePlan {
  const window = opts.window ?? TAG_RANGE_WINDOW;
  const perSync = opts.perSync ?? TAG_RANGES_PER_SYNC;
  const ordered = tags.filter((t) => t.onDefaultBranch === true && t.committedAt != null).sort(compareTagOrder);
  // From just after the OLDEST baseline any releasing workspace gives (the release check sums EVERY
  // increment after its baseline, so none may be left out), or the window for one with none.
  const keepFrom =
    opts.views == null ? Math.max(0, ordered.length - window) : tagRangeKeepFrom(ordered, tags, opts.views, window);
  const inWindow = new Set(ordered.slice(keepFrom).map((t) => t.name));
  const storedByName = new Map(stored.map((s) => [s.tagName, s]));
  const work: RangeWork[] = [];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const tag = ordered[i]!;
    if (!inWindow.has(tag.name)) break;
    const base = i > 0 ? ordered[i - 1]! : null;
    const s = storedByName.get(tag.name);
    const fresh =
      s != null &&
      s.sha === tag.sha &&
      s.baseTagName === (base?.name ?? null) &&
      s.baseSha === (base?.sha ?? null);
    if (fresh) continue;
    work.push({ tag, base, movedFromSha: s != null && s.sha !== tag.sha ? s.sha : null });
  }
  const deleteTagNames = stored.filter((s) => !inWindow.has(s.tagName)).map((s) => s.tagName);
  return { work: work.slice(0, perSync), deleteTagNames };
}

/** One associated PR, as the fallback read it. */
interface AssociatedPr {
  number?: number | null;
  merged?: boolean | null;
  baseRefName?: string | null;
  repository?: { nameWithOwner?: string | null } | null;
}

/**
 * The PR numbers a commit's `associatedPullRequests` gives that count for a range: merged, into the
 * repo's default branch, of THIS repo (a fork's own PR can appear in the network). Pure.
 */
export function rangePrNumbersFromAssociated(
  nodes: Array<AssociatedPr | null> | null | undefined,
  fullName: string,
  defaultBranch: string,
): number[] {
  const out: number[] = [];
  for (const p of nodes ?? []) {
    if (p == null || typeof p.number !== 'number' || p.merged !== true) continue;
    if (p.baseRefName !== defaultBranch) continue;
    const owner = p.repository?.nameWithOwner;
    if (owner != null && owner.toLowerCase() !== fullName.toLowerCase()) continue;
    out.push(p.number);
  }
  return out;
}

export interface ComputedRange {
  method: 'compare' | 'history';
  prNumbers: number[];
  commitCount: number;
  unmatchedCommits: number;
  truncated: boolean;
}

export interface TagRangeDeps {
  compare?: (base: string, head: string, page: number) => Promise<RestCompareResponse>;
  commitPrs?: (shas: string[]) => Promise<CommitPrsResponse>;
  now?: () => number;
  /** The workspaces releasing this repo (default: read from the DB, `releaseRangeViews`). */
  views?: () => ReleaseRangeView[];
}

export interface ComputeTagRangesOptions {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
  deps?: TagRangeDeps;
}

export interface TagRangesResult {
  computed: number;
  deleted: number;
  failed: number;
  pending: number;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message.slice(0, 200) : String(err));
const uniqSorted = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b);

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Stored PRs merged into the default branch whose merge commit is one of `shas`: sha → number. */
async function prsByMergeCommit(
  accountId: number,
  repoId: number,
  defaultBranch: string,
  shas: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const part of chunks(shas, 400)) {
    const rows = await db
      .select({ number: pullRequests.number, oid: pullRequests.mergeCommitOid })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(pullRequests.repoId, repoId),
          eq(pullRequests.state, 'merged'),
          eq(pullRequests.baseRefName, defaultBranch),
          inArray(pullRequests.mergeCommitOid, part),
        ),
      )
      .execute();
    for (const r of rows) if (r.oid != null) out.set(r.oid, r.number);
  }
  return out;
}

/** Stored PR commits (a true merge keeps the branch's commits): sha → numbers. */
async function prsByPrCommit(
  accountId: number,
  repoId: number,
  defaultBranch: string,
  shas: string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const part of chunks(shas, 400)) {
    const rows = await db
      .select({ sha: commits.sha, number: pullRequests.number })
      .from(commits)
      .innerJoin(pullRequests, eq(pullRequests.id, commits.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(pullRequests.repoId, repoId),
          eq(pullRequests.state, 'merged'),
          eq(pullRequests.baseRefName, defaultBranch),
          inArray(commits.sha, part),
        ),
      )
      .execute();
    for (const r of rows) out.set(r.sha, [...(out.get(r.sha) ?? []), r.number]);
  }
  return out;
}

/** The 'history' range: stored PRs merged into the default branch no later than the tag's commit. */
async function historyRange(
  accountId: number,
  repoId: number,
  defaultBranch: string,
  tag: RangeTag,
): Promise<ComputedRange> {
  const rows = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'merged'),
        eq(pullRequests.baseRefName, defaultBranch),
        or(
          eq(pullRequests.mergeCommitOid, tag.sha),
          and(isNotNull(pullRequests.mergedAt), lte(pullRequests.mergedAt, tag.committedAt!)),
        ),
      ),
    )
    .execute();
  return {
    method: 'history',
    prNumbers: uniqSorted(rows.map((r) => r.number)),
    commitCount: 0,
    unmatchedCommits: 0,
    truncated: false,
  };
}

/** The fallback could not ask about every unmatched commit (the budget ran low): not stored, retried
 *  next sync — a stored range is final, so it must not be missing a PR. */
const BUDGET_PAUSED = 'budget' as const;

/** The 'compare' range. 'budget' when the fallback paused (retried next sync). Throws on a rate limit. */
async function compareRange(
  opts: ComputeTagRangesOptions,
  defaultBranch: string,
  base: RangeTag,
  tag: RangeTag,
): Promise<ComputedRange | typeof BUDGET_PAUSED> {
  const { owner, name, accountId, repoId, token } = opts;
  const fullName = `${owner}/${name}`;
  if (base.sha === tag.sha) {
    return { method: 'compare', prNumbers: [], commitCount: 0, unmatchedCommits: 0, truncated: false };
  }
  const shas: string[] = [];
  let total = 0;
  let truncated = false;
  for (let page = 1; ; page += 1) {
    const resp =
      (await opts.deps?.compare?.(base.sha, tag.sha, page)) ??
      (await fetchComparePage(token, { owner, name, base: base.sha, head: tag.sha, perPage: COMPARE_PAGE, page }));
    if (typeof resp.total_commits === 'number') total = resp.total_commits;
    const list = Array.isArray(resp.commits) ? resp.commits : [];
    for (const c of list) if (typeof c.sha === 'string') shas.push(c.sha);
    if (list.length < COMPARE_PAGE || shas.length >= total) break;
    if (shas.length >= TAG_RANGE_MAX_COMMITS) {
      truncated = true;
      break;
    }
  }
  if (total > shas.length) truncated = true;

  const numbers = new Set<number>();
  const byMerge = await prsByMergeCommit(accountId, repoId, defaultBranch, shas);
  let unmatched = shas.filter((s) => {
    const n = byMerge.get(s);
    if (n != null) numbers.add(n);
    return n == null;
  });
  if (unmatched.length > 0) {
    const byCommit = await prsByPrCommit(accountId, repoId, defaultBranch, unmatched);
    unmatched = unmatched.filter((s) => {
      const ns = byCommit.get(s);
      for (const n of ns ?? []) numbers.add(n);
      return ns == null;
    });
  }
  // The GraphQL fallback, newest commits first (compare lists oldest first).
  const ask = unmatched.slice(-COMMIT_PR_FALLBACK_MAX);
  const stillUnmatched = new Set(unmatched);
  for (const part of chunks(ask, COMMIT_PRS_ALIAS_CAP)) {
    if (isLimited(accountId) || isBudgetLow(accountId)) return BUDGET_PAUSED;
    const resp =
      (await opts.deps?.commitPrs?.(part)) ??
      (await withGithubRetry(() =>
        graphqlTolerant<CommitPrsResponse>(
          getGraphqlClientFor(token),
          buildCommitPrsQuery(part.length),
          Object.fromEntries([['owner', owner], ['name', name], ...part.map((s, i) => [`s${i}`, s])]),
          () => opts.log?.warn(`tag ranges ${fullName}: partial GraphQL on commit PRs (continuing)`),
        ),
      ));
    const rate = resp.rateLimit;
    if (rate) {
      const resetAt = rate.resetAt ? new Date(rate.resetAt) : null;
      noteBudget(accountId, {
        remaining: rate.remaining ?? null,
        resetAt: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null,
      });
    }
    part.forEach((sha, i) => {
      const node = resp.repository?.[`c${i}`] as GqlCommitPrsNode | null | undefined;
      const found = rangePrNumbersFromAssociated(node?.associatedPullRequests?.nodes, fullName, defaultBranch);
      for (const n of found) numbers.add(n);
      // Still unmatched = no PR of this repo into its default branch (a direct push).
      if (found.length > 0) stillUnmatched.delete(sha);
    });
  }
  return {
    method: 'compare',
    prNumbers: uniqSorted(numbers),
    commitCount: shas.length,
    unmatchedCommits: stillUnmatched.size,
    truncated,
  };
}

/**
 * Compute the missing / stale ranges for one repo. NEVER THROWS. Needs the repo's default branch
 * name (the tag sync's `defaultBranchName`, else the stored one). A repo no workspace releases gets
 * none (its stored ones are dropped). `pending` = ranges left for the next run.
 */
export async function computeTagRanges(
  opts: ComputeTagRangesOptions & { defaultBranchName?: string | null },
): Promise<TagRangesResult> {
  const { owner, name, accountId, repoId, log } = opts;
  const fullName = `${owner}/${name}`;
  const result: TagRangesResult = { computed: 0, deleted: 0, failed: 0, pending: 0 };
  try {
    let defaultBranch = opts.defaultBranchName ?? null;
    if (defaultBranch == null) {
      const r = (
        await db
          .select({ a: repos.defaultBranchName, b: repos.defaultBranch })
          .from(repos)
          .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
          .execute()
      )[0];
      defaultBranch = r?.a ?? r?.b ?? null;
    }
    if (defaultBranch == null) return result;

    const tags = await db
      .select({
        name: repoTags.name,
        sha: repoTags.sha,
        committedAt: repoTags.committedAt,
        taggedAt: repoTags.taggedAt,
        onDefaultBranch: repoTags.onDefaultBranch,
      })
      .from(repoTags)
      .where(and(eq(repoTags.accountId, accountId), eq(repoTags.repoId, repoId)))
      .execute();
    const stored = await db
      .select({
        tagName: repoTagRanges.tagName,
        sha: repoTagRanges.sha,
        baseTagName: repoTagRanges.baseTagName,
        baseSha: repoTagRanges.baseSha,
      })
      .from(repoTagRanges)
      .where(and(eq(repoTagRanges.accountId, accountId), eq(repoTagRanges.repoId, repoId)))
      .execute();
    const views = opts.deps?.views != null ? opts.deps.views() : await releaseRangeViews(accountId, repoId);
    const full = planTagRanges(tags, stored, { perSync: Number.MAX_SAFE_INTEGER, views });
    const plan = { work: full.work.slice(0, TAG_RANGES_PER_SYNC), deleteTagNames: full.deleteTagNames };
    result.pending = full.work.length - plan.work.length;

    if (plan.deleteTagNames.length > 0) {
      await db
        .delete(repoTagRanges)
        .where(
          and(
            eq(repoTagRanges.accountId, accountId),
            eq(repoTagRanges.repoId, repoId),
            inArray(repoTagRanges.tagName, plan.deleteTagNames),
          ),
        )
        .execute();
      result.deleted = plan.deleteTagNames.length;
    }

    for (const w of plan.work) {
      if (isLimited(accountId) || isBudgetLow(accountId)) {
        result.pending += 1;
        continue;
      }
      let range: ComputedRange | typeof BUDGET_PAUSED;
      try {
        range =
          w.base == null
            ? await historyRange(accountId, repoId, defaultBranch, w.tag)
            : await compareRange(opts, defaultBranch, w.base, w.tag);
      } catch (err) {
        const rl = isRateLimitError(err);
        if (rl.limited) {
          noteLimited(accountId, rl.resumeAt);
          result.pending += 1;
          continue;
        }
        result.failed += 1;
        log?.warn(`tag ranges ${fullName}: ${w.tag.name} not computed (non-fatal): ${errMsg(err)}`);
        continue;
      }
      if (range === BUDGET_PAUSED) {
        result.pending += 1;
        continue;
      }
      const now = new Date(opts.deps?.now?.() ?? Date.now());
      const values = {
        sha: w.tag.sha,
        baseTagName: w.base?.name ?? null,
        baseSha: w.base?.sha ?? null,
        method: range.method,
        prNumbers: range.prNumbers,
        commitCount: range.commitCount,
        unmatchedCommits: range.unmatchedCommits,
        truncated: range.truncated,
        movedFromSha: w.movedFromSha,
        computedAt: now,
      };
      await runTransaction(async (tx) => {
        await tx
          .insert(repoTagRanges)
          .values({ accountId, repoId, tagName: w.tag.name, ...values })
          .onConflictDoUpdate({
            target: [repoTagRanges.accountId, repoTagRanges.repoId, repoTagRanges.tagName],
            set: { ...values },
          })
          .execute();
      });
      result.computed += 1;
      if (w.movedFromSha != null) log?.info(`tag ranges ${fullName}: ${w.tag.name} moved; its range was recomputed`);
      if (range.truncated) log?.info(`tag ranges ${fullName}: ${w.tag.name} has more commits than are read`);
    }
    if (result.pending > 0) log?.info(`tag ranges ${fullName}: ${result.pending} range(s) left for the next sync`);
  } catch (err) {
    log?.warn(`tag ranges ${fullName}: failed (non-fatal): ${errMsg(err)}`);
  }
  return result;
}
