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
//   compute 'compare': REST compare base...tag with FULL commit pagination, ≤ TAG_RANGE_MAX_COMMITS
//           commits (past it the row is `truncated`, which HOLDS the tag — an honest refusal). Each
//           commit → PR by the stored `merge_commit_oid`, then by the stored PR commits, then GraphQL
//           `associatedPullRequests` for every commit still unmatched — only PRs of THIS repo merged
//           into its default branch count. 'history': the OLDEST tag has no base, so its range is every
//           PR merged into the default branch no later than its commit — read FROM GITHUB (the closed
//           PRs into the default branch, oldest created first, stopped at the tag's date; ≤
//           HISTORY_MAX_PRS listed, past it `truncated`) together with the stored ones.
//   bounds  ONLY A RELEASABLE REPO gets ranges (ticked "Released from this workspace" in a workspace
//           with both suffixes set, db/release-repos.ts `releaseRangeViews`); any other repo's stored
//           ranges are dropped. Per such workspace: every tag after its BASELINE (the newest release
//           tag on the default branch), or EVERY tag with no baseline (`tagRangeKeepFrom`). OLDEST
//           FIRST, so the candidate is known as early as possible; no count cap — a run stops at its
//           `deadline` or when the account's budget is low or limited, and the rest go next run (the
//           tags step runs again soon). A failed compare leaves the old row (if any) and is retried.
//   moves   a tag whose sha changed is recomputed and the row keeps `moved_from_sha`.
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import {
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
  CLOSED_PRS_PAGE,
  COMMIT_PRS_ALIAS_CAP,
  fetchClosedPrsPage,
  fetchComparePage,
  type CommitPrsResponse,
  type RestPullListItem,
  type GqlCommitPrsNode,
  type RestCompareResponse,
} from '../github/tag-queries.js';

const { repos, repoTags, repoTagRanges, pullRequests, commits } = schema;

/** Commits read from one compare (100 pages of 100). Past it the range is `truncated` and holds. */
export const TAG_RANGE_MAX_COMMITS = 10_000;
/** Closed PRs listed for the oldest tag's 'history' range. Past it the range is `truncated`. */
export const HISTORY_MAX_PRS = 10_000;
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
  /** Its place (1-based) among the ranges the check needs, oldest first. */
  position: number;
}

export interface RangePlan {
  work: RangeWork[];
  /** Stored ranges whose tag is gone, off the default branch, or before every baseline. */
  deleteTagNames: string[];
  /** Ranges the check needs in all (computed or not). */
  needed: number;
}

/** Oldest first — THE ONE tag order, shared with the release check (shared `compareTagOrder`). */
export function compareTagOrder(a: RangeTag, b: RangeTag): number {
  return sharedCompareTagOrder(a, b);
}

/**
 * Which ranges to (re)compute and which stored rows to drop. A range is (re)computed when it is
 * missing, its tag moved, or its base changed (another tag was cut between, or the base moved).
 * OLDEST FIRST (the release check walks oldest first, so the candidate is proven early), at most
 * `perSync`. `views` = every workspace releasing this repo (its suffixes): ranges after each one's
 * baseline, or every tag without one; NO view ⇒ no range at all (every stored one dropped). `views`
 * left out ⇒ every tag (the planner's own tests). Pure.
 */
export function planTagRanges(
  tags: RangeTag[],
  stored: StoredRange[],
  opts: { perSync?: number; views?: readonly ReleaseRangeView[] } = {},
): RangePlan {
  const perSync = opts.perSync ?? Number.MAX_SAFE_INTEGER;
  const ordered = tags.filter((t) => t.onDefaultBranch === true && t.committedAt != null).sort(compareTagOrder);
  // From just after the OLDEST baseline any releasing workspace gives (the release check sums EVERY
  // increment after its baseline, so none may be left out), or the whole history for one with none.
  const keepFrom = opts.views == null ? 0 : tagRangeKeepFrom(ordered, opts.views);
  const inWindow = new Set(ordered.slice(keepFrom).map((t) => t.name));
  const storedByName = new Map(stored.map((s) => [s.tagName, s]));
  const work: RangeWork[] = [];
  for (let i = keepFrom; i < ordered.length; i += 1) {
    const tag = ordered[i]!;
    const base = i > 0 ? ordered[i - 1]! : null;
    const s = storedByName.get(tag.name);
    const fresh =
      s != null &&
      s.sha === tag.sha &&
      s.baseTagName === (base?.name ?? null) &&
      s.baseSha === (base?.sha ?? null);
    if (fresh) continue;
    work.push({ tag, base, movedFromSha: s != null && s.sha !== tag.sha ? s.sha : null, position: i - keepFrom + 1 });
  }
  const deleteTagNames = stored.filter((s) => !inWindow.has(s.tagName)).map((s) => s.tagName);
  return { work: work.slice(0, perSync), deleteTagNames, needed: inWindow.size };
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
  /** One page of the closed PRs into the default branch, oldest created first (the 'history' range). */
  closedPrs?: (page: number) => Promise<RestPullListItem[]>;
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
  /** Stop starting new ranges after this time (ms since the epoch); the rest go next run. */
  deadline?: number;
  /** Told before each range is read (the scan's progress, sync/release-scan.ts). */
  onProgress?: (p: { tagName: string; position: number; done: number; total: number; paused: boolean }) => void;
}

export interface TagRangesResult {
  computed: number;
  deleted: number;
  failed: number;
  /** Ranges left for a later run (deadline, budget, a rate limit). */
  pending: number;
  /** Ranges the check needs in all, and how many of them are stored and fresh after this run. */
  needed: number;
  ready: number;
  /** The run stopped on the rate budget. */
  paused: boolean;
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

/** A closed PR from the REST list that is in the oldest tag's history: merged into the default branch,
 *  by the tag's own commit or no later than its commit's date. Pure. */
export function historyPrNumber(p: RestPullListItem, tag: { sha: string; committedAt: Date }, defaultBranch: string): number | null {
  if (typeof p.number !== 'number' || typeof p.merged_at !== 'string') return null;
  if (p.base?.ref != null && p.base.ref !== defaultBranch) return null;
  if (p.merge_commit_sha === tag.sha) return p.number;
  const at = Date.parse(p.merged_at);
  return Number.isFinite(at) && at <= tag.committedAt.getTime() ? p.number : null;
}

/**
 * The 'history' range: PRs merged into the default branch no later than the tag's commit — from
 * GitHub (the closed PRs into the default branch, oldest created first; a PR created after the tag's
 * commit cannot be in it, so the list stops there) and the stored ones. 'budget' when the budget ran
 * low part way (retried next run). Throws on a rate limit.
 */
async function historyRange(
  opts: ComputeTagRangesOptions,
  defaultBranch: string,
  tag: RangeTag,
): Promise<ComputedRange | typeof BUDGET_PAUSED> {
  const { accountId, repoId, owner, name, token } = opts;
  const committedAt = tag.committedAt!;
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
          and(isNotNull(pullRequests.mergedAt), lte(pullRequests.mergedAt, committedAt)),
        ),
      ),
    )
    .execute();
  const numbers = new Set(rows.map((r) => r.number));
  let listed = 0;
  let truncated = false;
  for (let page = 1; ; page += 1) {
    if (listed >= HISTORY_MAX_PRS) {
      truncated = true;
      break;
    }
    if (isLimited(accountId) || isBudgetLow(accountId)) return BUDGET_PAUSED;
    const list =
      (await opts.deps?.closedPrs?.(page)) ?? (await fetchClosedPrsPage(token, { owner, name, base: defaultBranch, page }));
    listed += list.length;
    let past = list.length > 0;
    for (const p of list) {
      const n = historyPrNumber(p, { sha: tag.sha, committedAt }, defaultBranch);
      if (n != null) numbers.add(n);
      const created = typeof p.created_at === 'string' ? Date.parse(p.created_at) : NaN;
      if (!(Number.isFinite(created) && created > committedAt.getTime())) past = false;
    }
    // A short page is the end; a page created wholly after the tag's commit is past it.
    if (list.length < CLOSED_PRS_PAGE || past) break;
  }
  return {
    method: 'history',
    prNumbers: uniqSorted(numbers),
    commitCount: 0,
    unmatchedCommits: 0,
    truncated,
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
    if (page > 1 && (isLimited(accountId) || isBudgetLow(accountId))) return BUDGET_PAUSED;
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
  const result: TagRangesResult = { computed: 0, deleted: 0, failed: 0, pending: 0, needed: 0, ready: 0, paused: false };
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
    const plan = planTagRanges(tags, stored, { views });
    result.needed = plan.needed;
    result.ready = plan.needed - plan.work.length;

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

    for (let k = 0; k < plan.work.length; k += 1) {
      const w = plan.work[k]!;
      const paused = isLimited(accountId) || isBudgetLow(accountId);
      const late = opts.deadline != null && Date.now() >= opts.deadline;
      if (paused || late) {
        if (paused) {
          result.paused = true;
          opts.onProgress?.({ tagName: w.tag.name, position: w.position, done: result.ready, total: result.needed, paused });
        }
        result.pending += plan.work.length - k;
        break;
      }
      opts.onProgress?.({ tagName: w.tag.name, position: w.position, done: result.ready, total: result.needed, paused: false });
      let range: ComputedRange | typeof BUDGET_PAUSED;
      try {
        range =
          w.base == null
            ? await historyRange(opts, defaultBranch, w.tag)
            : await compareRange(opts, defaultBranch, w.base, w.tag);
      } catch (err) {
        const rl = isRateLimitError(err);
        if (rl.limited) {
          noteLimited(accountId, rl.resumeAt);
          result.paused = true;
          result.pending += 1;
          continue;
        }
        result.failed += 1;
        log?.warn(`tag ranges ${fullName}: ${w.tag.name} not computed (non-fatal): ${errMsg(err)}`);
        continue;
      }
      if (range === BUDGET_PAUSED) {
        result.paused = true;
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
      result.ready += 1;
      if (w.movedFromSha != null) log?.info(`tag ranges ${fullName}: ${w.tag.name} moved; its range was recomputed`);
      if (range.truncated) log?.info(`tag ranges ${fullName}: ${w.tag.name} has more commits than are read`);
    }
    if (result.pending > 0) log?.info(`tag ranges ${fullName}: ${result.pending} range(s) left for the next run`);
  } catch (err) {
    log?.warn(`tag ranges ${fullName}: failed (non-fatal): ${errMsg(err)}`);
  }
  return result;
}
