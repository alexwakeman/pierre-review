// TAG SYNC (docs/RELEASES.md § Invariants) — the repo's git tags into `repo_tags`, part of the
// default-branch snapshot step. STRICTLY NON-FATAL: `syncRepoTagsSafe` never throws, and a failed
// read changes nothing stored.
//
//   1. ONE GraphQL read (github/tag-queries.ts, 1 point): the newest REPO_TAGS_READ_CAP tags by the
//      tagged commit's date, and the default branch head. Tags past the cap are DROPPED and the
//      count is logged — never silently.
//   2. ONE transaction writes the fold: new tags inserted, a tag whose commit changed is MOVED
//      (`previous_sha`, `moved_at`; its ancestry forgotten), a tag GitHub no longer lists deleted —
//      every absent tag when the read was complete, else only absent tags inside the read window
//      (no older than the oldest tag read). `repos.tags_signature` records what was read, so the
//      settle sweep can tell a tag push from nothing (sync/settle-sweep.ts).
//   3. ANCESTRY, bounded (ANCESTRY_CHECKS_PER_SYNC, newest first): is the tagged commit on the
//      default branch? One REST compare `tag...head` (per_page=1) per tag: 'ahead' / 'identical'
//      means the tag is an ancestor of the head. `true` is final for that sha; `false` is asked
//      again when the head moves (a branch can be merged later). Skipped while the account's
//      budget is low or limited — rate limits are pre-empted, never errors.
//
// The tag ranges (sync/tag-ranges.ts) run after this, from what it stored.
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema, runTransaction } from '../db/client.js';
import {
  getGraphqlClientFor,
  graphqlTolerant,
  isRateLimitError,
  withGithubRetry,
} from '../github/client.js';
import { isBudgetLow, isLimited, noteBudget, noteLimited } from '../github/rate-budget.js';
import {
  fetchComparePage,
  REPO_TAGS_QUERY,
  REPO_TAGS_READ_CAP,
  type GqlTagRefs,
  type RepoTagsResponse,
  type RestCompareResponse,
} from '../github/tag-queries.js';

const { repos, repoTags } = schema;

/** Ancestry compares per sync. The rest wait for the next sync. */
export const ANCESTRY_CHECKS_PER_SYNC = 20;

export interface TagSyncLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

/** One tag as GitHub described it, peeled to its commit. */
export interface ObservedTag {
  name: string;
  /** The tagged COMMIT. */
  sha: string;
  /** The annotated tag object's oid; null for a lightweight tag. */
  tagObjectOid: string | null;
  committedAt: Date | null;
  taggedAt: Date | null;
}

export interface TagRead {
  tags: ObservedTag[];
  /** GitHub's total tag count, when it arrived. */
  totalCount: number | undefined;
  /** Every tag was read (the list is a positive statement of what exists). */
  complete: boolean;
  /** Tags past the read cap. */
  dropped: number;
  /** Tags that do not point at a commit (a tree, a blob, a tag of a tag): not stored. */
  skipped: string[];
  /** The settle sweep's comparison key for this read. */
  signature: string;
}

const dateOf = (s: string | null | undefined): Date | null => {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The settle sweep's comparison key: the tag count plus the NEWEST tag's name and ref target (the
 * tag object for an annotated tag). A new tag, a deleted tag or a re-pushed newest tag changes it.
 * Both the sweep's `refs(first: 1)` and the sync's `refs(first: 100)` order the same way, so they
 * build the same key from the same repo. Pure.
 */
export function tagSignature(
  totalCount: number | null | undefined,
  newest: { name?: string | null; target?: { oid?: string | null } | null } | null | undefined,
): string {
  return `${totalCount ?? '?'}|${newest?.name ?? ''}|${newest?.target?.oid ?? ''}`;
}

/**
 * Fold the `refs` connection into peeled tags. Null when the selection did not arrive (a nulled
 * partial) — nothing is known, nothing may be written. Pure.
 */
export function foldTagRefs(refs: GqlTagRefs | null | undefined, cap = REPO_TAGS_READ_CAP): TagRead | null {
  if (refs == null || !Array.isArray(refs.nodes)) return null;
  const tags: ObservedTag[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const node of refs.nodes) {
    const name = node?.name;
    const target = node?.target;
    if (typeof name !== 'string' || name.length === 0 || target == null || seen.has(name)) continue;
    seen.add(name);
    if (target.__typename === 'Commit' && typeof target.oid === 'string') {
      tags.push({ name, sha: target.oid, tagObjectOid: null, committedAt: dateOf(target.committedDate), taggedAt: null });
    } else if (
      target.__typename === 'Tag' &&
      typeof target.oid === 'string' &&
      target.target?.__typename === 'Commit' &&
      typeof target.target.oid === 'string'
    ) {
      tags.push({
        name,
        sha: target.target.oid,
        tagObjectOid: target.oid,
        committedAt: dateOf(target.target.committedDate),
        taggedAt: dateOf(target.tagger?.date),
      });
    } else {
      skipped.push(name);
    }
  }
  const totalCount = typeof refs.totalCount === 'number' ? refs.totalCount : undefined;
  const read = refs.nodes.length;
  const complete = totalCount !== undefined && totalCount <= read && read <= cap;
  const dropped = totalCount !== undefined ? Math.max(0, totalCount - read) : 0;
  return {
    tags,
    totalCount,
    complete,
    dropped,
    skipped,
    signature: tagSignature(totalCount, refs.nodes[0] ?? null),
  };
}

/** A stored `repo_tags` row, as the planner needs it. */
export interface StoredTag {
  id: number;
  name: string;
  sha: string;
  tagObjectOid: string | null;
  committedAt: Date | null;
  taggedAt: Date | null;
  onDefaultBranch: boolean | null;
  ancestryHeadSha: string | null;
}

export interface TagWritePlan {
  inserts: ObservedTag[];
  /** Same commit; the tag object or the dates may have changed. */
  refreshes: Array<{ id: number; tag: ObservedTag }>;
  /** The tag now points at another commit. */
  moves: Array<{ id: number; tag: ObservedTag; previousSha: string }>;
  deletes: number[];
}

/**
 * What one read does to the stored tags. Absent tags are deleted only on a positive statement:
 * every absent tag when the read was COMPLETE; otherwise only absent tags whose commit is no older
 * than the oldest tag read (they would have been in the window had they existed). Pure.
 */
export function planTagWrites(stored: StoredTag[], read: TagRead): TagWritePlan {
  const byName = new Map(stored.map((s) => [s.name, s]));
  const plan: TagWritePlan = { inserts: [], refreshes: [], moves: [], deletes: [] };
  const observedNames = new Set<string>();
  for (const tag of read.tags) {
    observedNames.add(tag.name);
    const s = byName.get(tag.name);
    if (!s) plan.inserts.push(tag);
    else if (s.sha !== tag.sha) plan.moves.push({ id: s.id, tag, previousSha: s.sha });
    else plan.refreshes.push({ id: s.id, tag });
  }
  // Skipped names were LISTED — they exist; they are just not commits. Not deleted, not stored.
  for (const n of read.skipped) observedNames.add(n);
  const dated = read.tags.map((t) => t.committedAt?.getTime()).filter((t): t is number => t != null);
  const oldestRead = dated.length > 0 ? Math.min(...dated) : null;
  for (const s of stored) {
    if (observedNames.has(s.name)) continue;
    if (read.complete) plan.deletes.push(s.id);
    else if (oldestRead != null && s.committedAt != null && s.committedAt.getTime() >= oldestRead) {
      plan.deletes.push(s.id);
    }
  }
  return plan;
}

/**
 * The tags whose ancestry to ask about now, at most `cap`: NEVER ASKED first, then those asked and
 * found OFF the default branch against a head that has since moved — newest commit first within each.
 * A `true` stands. A never-asked tag on the commit of a tag already known ON the branch is not asked
 * (`inheritedAncestry` answers it), and one commit is asked about once. Pure.
 */
export function ancestryTargets(
  tags: Array<Pick<StoredTag, 'name' | 'sha' | 'committedAt' | 'onDefaultBranch' | 'ancestryHeadSha'>>,
  headSha: string,
  cap = ANCESTRY_CHECKS_PER_SYNC,
): Array<{ name: string; sha: string }> {
  const onBranch = new Set(tags.filter((t) => t.onDefaultBranch === true).map((t) => t.sha));
  const newest = (a: { committedAt: Date | null }, b: { committedAt: Date | null }): number =>
    (b.committedAt?.getTime() ?? 0) - (a.committedAt?.getTime() ?? 0);
  const never = tags.filter((t) => t.onDefaultBranch == null && !onBranch.has(t.sha)).sort(newest);
  const again = tags.filter((t) => t.onDefaultBranch === false && t.ancestryHeadSha !== headSha).sort(newest);
  const seen = new Set<string>();
  const out: Array<{ name: string; sha: string }> = [];
  for (const t of [...never, ...again]) {
    if (out.length >= cap) break;
    if (seen.has(t.sha)) continue;
    seen.add(t.sha);
    out.push({ name: t.name, sha: t.sha });
  }
  return out;
}

/**
 * Never-asked tags on the SAME commit as a tag known ON the default branch: on it too (a release tag
 * on its version tag's commit is on the branch exactly when the version tag is), no request. Pure.
 */
export function inheritedAncestry(
  tags: Array<Pick<StoredTag, 'name' | 'sha' | 'onDefaultBranch'>>,
): Array<{ name: string; sha: string }> {
  const onBranch = new Set(tags.filter((t) => t.onDefaultBranch === true).map((t) => t.sha));
  return tags.filter((t) => t.onDefaultBranch == null && onBranch.has(t.sha)).map((t) => ({ name: t.name, sha: t.sha }));
}

/**
 * What a REST compare `tag...head` says about the tag: on the default branch when the head is
 * AHEAD of (or identical to) the tagged commit; off it when behind or diverged; unknown otherwise.
 * Pure.
 */
export function ancestryFromCompareStatus(status: unknown): boolean | undefined {
  if (status === 'ahead' || status === 'identical') return true;
  if (status === 'behind' || status === 'diverged') return false;
  return undefined;
}

export interface SyncRepoTagsOptions {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  log?: TagSyncLogger;
  /** Test seams; production reads GitHub. */
  deps?: {
    readTags?: () => Promise<RepoTagsResponse>;
    compare?: (base: string, head: string) => Promise<RestCompareResponse>;
    now?: () => number;
  };
}

export interface RepoTagSyncResult {
  read: boolean;
  tags: number;
  inserted: number;
  moved: number;
  deleted: number;
  dropped: number;
  ancestryChecked: number;
  defaultBranchName: string | null;
  headSha: string | null;
  cost: number;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message.slice(0, 200) : String(err));

/** Read and store one repo's tags. Throws only on the GraphQL read failing (the Safe wrapper catches). */
export async function syncRepoTags(opts: SyncRepoTagsOptions): Promise<RepoTagSyncResult> {
  const { owner, name, repoId, accountId, token, log } = opts;
  const fullName = `${owner}/${name}`;
  const now = new Date(opts.deps?.now?.() ?? Date.now());
  const result: RepoTagSyncResult = {
    read: false,
    tags: 0,
    inserted: 0,
    moved: 0,
    deleted: 0,
    dropped: 0,
    ancestryChecked: 0,
    defaultBranchName: null,
    headSha: null,
    cost: 0,
  };

  const resp =
    (await opts.deps?.readTags?.()) ??
    (await withGithubRetry(() =>
      graphqlTolerant<RepoTagsResponse>(
        getGraphqlClientFor(token),
        REPO_TAGS_QUERY,
        { owner, name, first: REPO_TAGS_READ_CAP },
        (errors) => log?.warn(`tags ${fullName}: partial GraphQL — keeping stored tags where unread`, errors),
      ),
    ));
  const rate = resp.rateLimit;
  if (rate) {
    result.cost += rate.cost ?? 0;
    const resetAt = rate.resetAt ? new Date(rate.resetAt) : null;
    noteBudget(accountId, {
      remaining: rate.remaining ?? null,
      resetAt: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null,
    });
  }
  result.defaultBranchName = resp.repository?.defaultBranchRef?.name ?? null;
  result.headSha = resp.repository?.defaultBranchRef?.target?.oid ?? null;

  const read = foldTagRefs(resp.repository?.refs);
  if (read == null) {
    log?.warn(`tags ${fullName}: the tag list did not arrive — nothing changed`);
    return result;
  }
  result.read = true;
  result.dropped = read.dropped;
  if (read.dropped > 0) {
    log?.info(`tags ${fullName}: read the newest ${read.tags.length + read.skipped.length} tag(s); ${read.dropped} older tag(s) not read`);
  }
  if (read.skipped.length > 0) {
    log?.info(`tags ${fullName}: ${read.skipped.length} tag(s) do not point at a commit and are not stored`);
  }

  await runTransaction(async (tx) => {
    const stored = await tx
      .select({
        id: repoTags.id,
        name: repoTags.name,
        sha: repoTags.sha,
        tagObjectOid: repoTags.tagObjectOid,
        committedAt: repoTags.committedAt,
        taggedAt: repoTags.taggedAt,
        onDefaultBranch: repoTags.onDefaultBranch,
        ancestryHeadSha: repoTags.ancestryHeadSha,
      })
      .from(repoTags)
      .where(and(eq(repoTags.accountId, accountId), eq(repoTags.repoId, repoId)))
      .execute();
    const plan = planTagWrites(stored, read);
    for (const tag of plan.inserts) {
      await tx
        .insert(repoTags)
        .values({
          accountId,
          repoId,
          name: tag.name,
          sha: tag.sha,
          tagObjectOid: tag.tagObjectOid,
          committedAt: tag.committedAt,
          taggedAt: tag.taggedAt,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing({ target: [repoTags.accountId, repoTags.repoId, repoTags.name] })
        .execute();
    }
    for (const { id, tag } of plan.refreshes) {
      await tx
        .update(repoTags)
        .set({ tagObjectOid: tag.tagObjectOid, committedAt: tag.committedAt, taggedAt: tag.taggedAt, lastSeenAt: now })
        .where(and(eq(repoTags.id, id), eq(repoTags.accountId, accountId)))
        .execute();
    }
    for (const { id, tag, previousSha } of plan.moves) {
      await tx
        .update(repoTags)
        .set({
          sha: tag.sha,
          tagObjectOid: tag.tagObjectOid,
          committedAt: tag.committedAt,
          taggedAt: tag.taggedAt,
          previousSha,
          movedAt: now,
          // The ancestry was true of the OLD commit.
          onDefaultBranch: null,
          ancestryHeadSha: null,
          lastSeenAt: now,
        })
        .where(and(eq(repoTags.id, id), eq(repoTags.accountId, accountId)))
        .execute();
    }
    if (plan.deletes.length > 0) {
      await tx
        .delete(repoTags)
        .where(and(eq(repoTags.accountId, accountId), inArray(repoTags.id, plan.deletes)))
        .execute();
    }
    await tx
      .update(repos)
      .set({ tagsSignature: read.signature, tagsSyncedAt: now })
      .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
      .execute();
    result.inserted = plan.inserts.length;
    result.moved = plan.moves.length;
    result.deleted = plan.deletes.length;
    result.tags = stored.length + plan.inserts.length - plan.deletes.length;
  });

  if (result.moved > 0) log?.info(`tags ${fullName}: ${result.moved} tag(s) moved to another commit`);

  // ANCESTRY — after the write, outside the transaction (a network call never holds the lock).
  if (result.headSha != null) {
    result.ancestryChecked = await checkAncestry(opts, result.headSha, now);
  }
  return result;
}

async function checkAncestry(opts: SyncRepoTagsOptions, headSha: string, now: Date): Promise<number> {
  const { owner, name, repoId, accountId, token, log } = opts;
  const rows = await db
    .select({
      name: repoTags.name,
      sha: repoTags.sha,
      committedAt: repoTags.committedAt,
      onDefaultBranch: repoTags.onDefaultBranch,
      ancestryHeadSha: repoTags.ancestryHeadSha,
    })
    .from(repoTags)
    .where(and(eq(repoTags.accountId, accountId), eq(repoTags.repoId, repoId)))
    .execute();
  const write = async (t: { name: string; sha: string }, onBranch: boolean): Promise<void> => {
    await db
      .update(repoTags)
      .set({ onDefaultBranch: onBranch, ancestryHeadSha: headSha, lastSeenAt: now })
      // The sha in the predicate: a tag moved since the read is not given the old commit's answer.
      .where(
        and(
          eq(repoTags.accountId, accountId),
          eq(repoTags.repoId, repoId),
          eq(repoTags.name, t.name),
          eq(repoTags.sha, t.sha),
        ),
      )
      .execute();
  };
  for (const t of inheritedAncestry(rows)) await write(t, true);
  const targets = ancestryTargets(rows, headSha);
  // Every tag on an asked commit takes the answer (one request per commit).
  const sameCommit = (sha: string): Array<{ name: string; sha: string }> =>
    rows
      .filter((r) => r.sha === sha && (r.onDefaultBranch == null || (r.onDefaultBranch === false && r.ancestryHeadSha !== headSha)))
      .map((r) => ({ name: r.name, sha: r.sha }));
  let checked = 0;
  for (const t of targets) {
    if (isLimited(accountId) || isBudgetLow(accountId)) break;
    let onBranch: boolean | undefined;
    if (t.sha === headSha) onBranch = true;
    else {
      try {
        const cmp =
          (await opts.deps?.compare?.(t.sha, headSha)) ??
          (await fetchComparePage(token, { owner, name, base: t.sha, head: headSha, perPage: 1, page: 1 }));
        onBranch = ancestryFromCompareStatus(cmp.status);
      } catch (err) {
        const rl = isRateLimitError(err);
        if (rl.limited) {
          noteLimited(accountId, rl.resumeAt);
          break;
        }
        log?.warn(`tags ${owner}/${name}: ancestry of ${t.name} unknown (non-fatal): ${errMsg(err)}`);
        continue;
      }
    }
    if (onBranch === undefined) continue;
    checked += 1;
    for (const same of sameCommit(t.sha)) await write(same, onBranch);
  }
  return checked;
}

/** `syncRepoTags` that NEVER THROWS: a failure is a warn line and changes nothing stored. */
export async function syncRepoTagsSafe(opts: SyncRepoTagsOptions): Promise<RepoTagSyncResult | null> {
  try {
    return await syncRepoTags(opts);
  } catch (err) {
    const rl = isRateLimitError(err);
    if (rl.limited) noteLimited(opts.accountId, rl.resumeAt);
    else opts.log?.warn(`tags ${opts.owner}/${opts.name}: tag sync failed (non-fatal): ${errMsg(err)}`);
    return null;
  }
}
