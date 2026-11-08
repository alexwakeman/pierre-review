// THE LIMN PROVENANCE LEDGER (`limn_actions`; docs/CLAUDE-REVIEW.md § Limn's actions are bots).
//
// ONE row per GitHub write Limn made, or tried, under a person's account. The write functions record
// it themselves (github/write-origin.ts `limnWrite`): CLAIMED before the call, 'done' with GitHub's ids
// after it, 'failed' when it threw or GitHub refused. A 'failed' row is kept: a write that errored may
// still have landed, and the ids it names (when any) are still Limn's.
//
// Readers: sync's attribution (db/limn-bots.ts) — a stored row whose GitHub id or commit sha is in
// the ledger is Limn's, whatever its body says. ⚠ Never inside a `runTransaction` that awaits a fetch:
// these are single statements, run before and after the network call.
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { isLimnAuthoredBody, type LimnActionKind, type LimnActionOrigin } from '@pierre-review/shared';
import { db, schema, type Executor } from './client.js';
import type { LimnWriteOrigin, WriteOrigin } from '../github/write-origin.js';

const { limnActions, pullRequests, accounts, users, reviewThreads, repos } = schema;

/**
 * A Limn write origin for one PR of this account (its repo read from the PR), on behalf of the
 * account's own user. null when the PR is not this account's.
 */
async function limnOriginForPrUnsafe(
  accountId: number,
  prId: number,
  limn: LimnActionOrigin,
  extra: { source?: { table: string; id: number } | null; claimKey?: string; onBehalfUserId?: number | null } = {},
  exec: Executor = db,
): Promise<LimnWriteOrigin | null> {
  const row = (
    await exec
      .select({ repoId: pullRequests.repoId, userId: users.id })
      .from(pullRequests)
      .innerJoin(accounts, eq(accounts.id, pullRequests.accountId))
      // The account's own user row, by login (auth/account.ts `getAccountUserId`'s rule).
      .leftJoin(users, eq(users.githubLogin, accounts.githubLogin))
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!row) return null;
  return {
    limn,
    accountId,
    repoId: row.repoId,
    prId,
    onBehalfUserId: extra.onBehalfUserId !== undefined ? extra.onBehalfUserId : (row.userId ?? null),
    source: extra.source ?? null,
    ...(extra.claimKey ? { claimKey: extra.claimKey } : {}),
  };
}

/** `limnOriginForPr` for the PR a review thread (by its GitHub node id) belongs to. */
async function limnOriginForThreadUnsafe(
  accountId: number,
  threadNodeId: string,
  limn: LimnActionOrigin,
  extra: { source?: { table: string; id: number } | null } = {},
): Promise<LimnWriteOrigin | null> {
  const row = (
    await db
      .select({ prId: reviewThreads.prId })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(and(eq(reviewThreads.githubNodeId, threadNodeId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return row ? limnOriginForPr(accountId, row.prId, limn, extra) : null;
}

/** `limnOriginForPr` for a PR named by `owner/name#number` (within this account). */
async function limnOriginForPrNumberUnsafe(
  accountId: number,
  owner: string,
  name: string,
  number: number,
  limn: LimnActionOrigin,
  extra: { source?: { table: string; id: number } | null } = {},
): Promise<LimnWriteOrigin | null> {
  const row = (
    await db
      .select({ prId: pullRequests.id })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(repos.accountId, accountId),
          sql`lower(${repos.owner}) = ${owner.toLowerCase()}`,
          sql`lower(${repos.name}) = ${name.toLowerCase()}`,
          eq(pullRequests.number, number),
        ),
      )
      .limit(1)
      .execute()
  )[0];
  return row ? limnOriginForPr(accountId, row.prId, limn, extra) : null;
}

/** A Limn origin for a REPOSITORY of this account (no PR yet: a branch Limn pushes and opens a PR
 *  from), on behalf of the account's own user. null when the repo is not this account's. */
async function limnOriginForRepoUnsafe(
  accountId: number,
  owner: string,
  name: string,
  limn: LimnActionOrigin,
  extra: { source?: { table: string; id: number } | null } = {},
): Promise<LimnWriteOrigin | null> {
  const row = (
    await db
      .select({ repoId: repos.id, userId: users.id })
      .from(repos)
      .innerJoin(accounts, eq(accounts.id, repos.accountId))
      .leftJoin(users, eq(users.githubLogin, accounts.githubLogin))
      .where(
        and(
          eq(repos.accountId, accountId),
          sql`lower(${repos.owner}) = ${owner.toLowerCase()}`,
          sql`lower(${repos.name}) = ${name.toLowerCase()}`,
        ),
      )
      .limit(1)
      .execute()
  )[0];
  if (!row) return null;
  return { limn, accountId, repoId: row.repoId, prId: null, onBehalfUserId: row.userId ?? null, source: extra.source ?? null };
}

/** The ref a `Limn-Run:` trailer names for a run row (`ai_fixes/12` → `ai-fix/12`). */
export function limnRunRef(source: { table: string; id: number }): string {
  const short: Record<string, string> = {
    ai_fixes: 'ai-fix',
    story_builds: 'story-build',
    story_build_repos: 'story-build',
    story_build_prs: 'story-build',
    conflict_sessions: 'conflict',
    auto_merge_requests: 'auto-merge',
    dependency_automation_actions: 'deps',
  };
  return `${short[source.table] ?? source.table}/${source.id}`;
}

/** A Limn origin, or 'reader' when the PR / thread could not be placed (nothing is ever blocked). */
export function orReader(o: LimnWriteOrigin | null): WriteOrigin {
  return o ?? 'reader';
}

/**
 * THE CONTENT RULE for a plain write route (a PR comment, an inline comment, a thread reply): a body
 * that carries a Limn marker is Limn's words the reader pressed "post" on ('reader_pressed'); any
 * other body is the reader's own ('reader').
 */
export async function originForPostedBody(accountId: number, prId: number, body: string | null | undefined): Promise<WriteOrigin> {
  if (!isLimnAuthoredBody(body)) return 'reader';
  return (await limnOriginForPr(accountId, prId, 'reader_pressed')) ?? 'reader';
}

export interface LimnActionTarget {
  accountId: number;
  repoId: number;
  prId: number | null;
  prNumber?: number | null;
  kind: LimnActionKind;
  origin: LimnActionOrigin;
  onBehalfUserId: number | null;
  source?: { table: string; id: number } | null;
  /** The writer's idempotency key; a fresh random one when absent. */
  claimKey?: string;
}

/** GitHub's ids for what the write produced. Any may be absent. */
export interface LimnActionIds {
  githubNodeId?: string | null;
  githubDatabaseId?: string | number | null;
  commitSha?: string | null;
  reviewDatabaseId?: string | number | null;
  prNumber?: number | null;
  detail?: string | null;
}

const str = (v: string | number | null | undefined): string | null =>
  v == null || v === '' ? null : String(v);

/** Claim a ledger row BEFORE the write. Returns its id. Re-claiming the same key reuses the row. */
export async function claimLimnAction(t: LimnActionTarget, exec: Executor = db): Promise<number> {
  const now = new Date();
  const claimKey = t.claimKey ?? `${t.kind}:${randomUUID()}`;
  const row = (
    await exec
      .insert(limnActions)
      .values({
        accountId: t.accountId,
        repoId: t.repoId,
        prId: t.prId,
        prNumber: t.prNumber ?? null,
        kind: t.kind,
        claimKey,
        status: 'claimed',
        origin: t.origin,
        onBehalfUserId: t.onBehalfUserId,
        sourceTable: t.source?.table ?? null,
        sourceId: t.source?.id ?? null,
        at: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [limnActions.accountId, limnActions.kind, limnActions.claimKey],
        set: { updatedAt: now },
      })
      .returning({ id: limnActions.id })
      .execute()
  )[0]!;
  return row.id;
}

/** Settle a claimed row: 'done' with GitHub's ids, or 'failed'. Ids already stored are kept when absent. */
export async function settleLimnAction(
  id: number,
  status: 'done' | 'failed',
  ids: LimnActionIds = {},
  exec: Executor = db,
): Promise<void> {
  const set: Partial<typeof limnActions.$inferInsert> = { status, updatedAt: new Date() };
  if (ids.githubNodeId !== undefined) set.githubNodeId = str(ids.githubNodeId);
  if (ids.githubDatabaseId !== undefined) set.githubDatabaseId = str(ids.githubDatabaseId);
  if (ids.commitSha !== undefined) set.commitSha = str(ids.commitSha);
  if (ids.reviewDatabaseId !== undefined) set.reviewDatabaseId = str(ids.reviewDatabaseId);
  if (ids.prNumber !== undefined) set.prNumber = ids.prNumber;
  if (ids.detail !== undefined) set.detail = ids.detail == null ? null : ids.detail.slice(0, 500);
  await exec.update(limnActions).set(set).where(eq(limnActions.id, id)).execute();
}

/** Record a write that already happened (claim + done in one). Returns the row id. */
export async function recordLimnAction(
  t: LimnActionTarget,
  ids: LimnActionIds,
  exec: Executor = db,
): Promise<number> {
  const id = await claimLimnAction(t, exec);
  await settleLimnAction(id, 'done', ids, exec);
  return id;
}

/** Record one 'push' row per commit Limn pushed (claim key = the sha, so a re-push is one row). */
export async function recordLimnPushedCommits(
  t: Omit<LimnActionTarget, 'kind' | 'claimKey'>,
  shas: readonly string[],
  exec: Executor = db,
): Promise<void> {
  for (const sha of new Set(shas.filter((s) => /^[0-9a-f]{7,64}$/i.test(s)))) {
    await recordLimnAction({ ...t, kind: 'push', claimKey: `sha:${sha.toLowerCase()}` }, { commitSha: sha.toLowerCase() }, exec);
  }
}

/** Give a PR's ledger rows their local PR id once the PR is stored (a PR Limn just opened). */
export async function linkLimnActionsToPr(
  exec: Executor,
  a: { accountId: number; repoId: number; prNumber: number; prId: number },
): Promise<void> {
  await exec
    .update(limnActions)
    .set({ prId: a.prId })
    .where(
      and(
        eq(limnActions.accountId, a.accountId),
        eq(limnActions.repoId, a.repoId),
        eq(limnActions.prNumber, a.prNumber),
        sql`${limnActions.prId} is null`,
      ),
    )
    .execute();
}

/** What the ledger says about one PR — the input of sync's attribution (db/limn-bots.ts). */
export interface PrLimnLedger {
  /** Review database ids Limn posted (review, review_wrapper, and the wrapper of every comment/reply). */
  reviewDbIds: Map<string, number | null>;
  /** Comment database ids Limn posted (pr_comment, review_comment, reply). */
  commentDbIds: Map<string, number | null>;
  /** Commit shas Limn pushed. */
  commitShas: Map<string, number | null>;
  /** Limn landed this PR (a 'done' merge or enqueue) — for this person. */
  mergedFor: number | null;
  /** Limn opened this PR — for this person. */
  openedFor: number | null;
  /** 'done' branch updates: when, and for whom (the merge commit GitHub makes has no id in the reply). */
  branchUpdates: { at: Date; onBehalfUserId: number | null }[];
}

export function emptyPrLimnLedger(): PrLimnLedger {
  return {
    reviewDbIds: new Map(),
    commentDbIds: new Map(),
    commitShas: new Map(),
    mergedFor: null,
    openedFor: null,
    branchUpdates: [],
  };
}

/**
 * The ledger for a set of PRs, by local id. A PR Limn opened is matched by its node id or its
 * (repo, number) as well, because its rows were written before the PR was stored. 'claimed' rows are
 * read too (a crash between the write and the settle). DB only.
 */
export async function prLimnLedgers(
  exec: Executor,
  accountId: number,
  prs: readonly { prId: number; repoId: number; number: number; nodeId: string }[],
): Promise<Map<number, PrLimnLedger>> {
  const out = new Map<number, PrLimnLedger>();
  if (prs.length === 0) return out;
  const byId = new Map(prs.map((p) => [p.prId, p] as const));
  const byNode = new Map(prs.map((p) => [p.nodeId, p.prId] as const));
  const byNumber = new Map(prs.map((p) => [`${p.repoId}:${p.number}`, p.prId] as const));
  const rows: (typeof limnActions.$inferSelect)[] = [];
  for (let i = 0; i < prs.length; i += 200) {
    const chunk = prs.slice(i, i + 200);
    rows.push(
      ...(await exec
        .select()
        .from(limnActions)
        .where(
          and(
            eq(limnActions.accountId, accountId),
            or(
              inArray(
                limnActions.prId,
                chunk.map((p) => p.prId),
              ),
              and(
                eq(limnActions.kind, 'open_pr'),
                or(
                  inArray(limnActions.githubNodeId, chunk.map((p) => p.nodeId)),
                  and(
                    inArray(limnActions.repoId, [...new Set(chunk.map((p) => p.repoId))]),
                    isNotNull(limnActions.prNumber),
                  ),
                ),
              ),
            ),
          ),
        )
        .execute()),
    );
  }
  for (const r of rows) {
    const prId =
      (r.prId != null && byId.has(r.prId) ? r.prId : null) ??
      (r.githubNodeId != null ? byNode.get(r.githubNodeId) : undefined) ??
      (r.prNumber != null ? byNumber.get(`${r.repoId}:${r.prNumber}`) : undefined);
    if (prId == null) continue;
    let l = out.get(prId);
    if (!l) {
      l = emptyPrLimnLedger();
      out.set(prId, l);
    }
    const who = r.onBehalfUserId ?? null;
    if (r.reviewDatabaseId) l.reviewDbIds.set(r.reviewDatabaseId, who);
    switch (r.kind) {
      case 'review':
      case 'review_wrapper':
        if (r.githubDatabaseId) l.reviewDbIds.set(r.githubDatabaseId, who);
        break;
      case 'pr_comment':
      case 'review_comment':
      case 'reply':
        if (r.githubDatabaseId) l.commentDbIds.set(r.githubDatabaseId, who);
        break;
      case 'push':
        if (r.commitSha) l.commitShas.set(r.commitSha.toLowerCase(), who);
        break;
      case 'merge':
      case 'enqueue':
        if (r.status === 'done') l.mergedFor = who;
        break;
      case 'open_pr':
        if (r.status !== 'failed' || r.prNumber != null) l.openedFor = who;
        break;
      case 'branch_update':
        if (r.status === 'done') l.branchUpdates.push({ at: r.at, onBehalfUserId: who });
        break;
      default:
        break;
    }
  }
  return out;
}

/** The whole account's ledger as id sets (GitHub ids and shas are global, so one set per kind serves
 *  every PR), plus who Limn merged / opened each PR for. The input of `reattributeLimnRows`. DB only. */
export interface AccountLimnLedger {
  commentIds: Set<string>;
  reviewIds: Set<string>;
  commitShas: Set<string>;
  mergedFor: Map<number, number | null>;
  openedFor: Map<number, number | null>;
}

export async function accountLimnLedger(exec: Executor, accountId: number): Promise<AccountLimnLedger> {
  const out: AccountLimnLedger = {
    commentIds: new Set(),
    reviewIds: new Set(),
    commitShas: new Set(),
    mergedFor: new Map(),
    openedFor: new Map(),
  };
  const rows = await exec
    .select({
      kind: limnActions.kind,
      status: limnActions.status,
      prId: limnActions.prId,
      repoId: limnActions.repoId,
      prNumber: limnActions.prNumber,
      githubNodeId: limnActions.githubNodeId,
      githubDatabaseId: limnActions.githubDatabaseId,
      reviewDatabaseId: limnActions.reviewDatabaseId,
      commitSha: limnActions.commitSha,
      onBehalfUserId: limnActions.onBehalfUserId,
    })
    .from(limnActions)
    .where(eq(limnActions.accountId, accountId))
    .execute();
  // A PR Limn opened whose row is not linked yet: its (repo, number).
  const unlinked = rows.filter((r) => r.kind === 'open_pr' && r.prId == null && r.prNumber != null);
  const prIdByNumber = new Map<string, number>();
  if (unlinked.length > 0) {
    for (const p of await exec
      .select({ id: pullRequests.id, repoId: pullRequests.repoId, number: pullRequests.number })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, [...new Set(unlinked.map((r) => r.repoId))]),
        ),
      )
      .execute())
      prIdByNumber.set(`${p.repoId}:${p.number}`, p.id);
  }
  for (const r of rows) {
    if (r.reviewDatabaseId) out.reviewIds.add(r.reviewDatabaseId);
    switch (r.kind) {
      case 'review':
      case 'review_wrapper':
        if (r.githubDatabaseId) out.reviewIds.add(r.githubDatabaseId);
        break;
      case 'pr_comment':
      case 'review_comment':
      case 'reply':
        if (r.githubDatabaseId) out.commentIds.add(r.githubDatabaseId);
        break;
      case 'push':
        if (r.commitSha) out.commitShas.add(r.commitSha.toLowerCase());
        break;
      case 'merge':
      case 'enqueue':
        if (r.status === 'done' && r.prId != null) out.mergedFor.set(r.prId, r.onBehalfUserId ?? null);
        break;
      case 'open_pr': {
        const prId = r.prId ?? (r.prNumber != null ? prIdByNumber.get(`${r.repoId}:${r.prNumber}`) : undefined);
        if (prId != null && (r.status !== 'failed' || r.prNumber != null)) out.openedFor.set(prId, r.onBehalfUserId ?? null);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ⚠ NEVER THROWS: a ledger lookup that fails (no DB row, a DB error) yields null — the write goes ahead
// as 'reader' (`orReader`) rather than being blocked. Attribution is never worth a refused write.
const safe =
  <A extends unknown[]>(f: (...a: A) => Promise<LimnWriteOrigin | null>) =>
  async (...a: A): Promise<LimnWriteOrigin | null> => {
    try {
      return await f(...a);
    } catch {
      return null;
    }
  };

/** A Limn write origin for one PR of this account, on behalf of the account's own user. null when the
 *  PR is not this account's. Never throws. */
export const limnOriginForPr = safe(limnOriginForPrUnsafe);
/** `limnOriginForPr` for the PR a review thread (by its GitHub node id) belongs to. Never throws. */
export const limnOriginForThread = safe(limnOriginForThreadUnsafe);
/** `limnOriginForPr` for a PR named by `owner/name#number`. Never throws. */
export const limnOriginForPrNumber = safe(limnOriginForPrNumberUnsafe);
/** A Limn origin for a repository (no PR yet). Never throws. */
export const limnOriginForRepo = safe(limnOriginForRepoUnsafe);
