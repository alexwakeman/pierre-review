// LIMN FINDINGS ARE BOTS (docs/CLAUDE-REVIEW.md § Limn findings are bots).
//
// Limn posts a review finding as the READER (their own GitHub account). Such a comment is the
// review's words, not the person's, so it is stored under a per-poster BOT user:
//
//   users                 login `limn:<poster>` ("Limn · alice"), is_bot = 1 and pinned
//                         (is_bot_overridden = 1), no node id. ':' never occurs in a GitHub login,
//                         so the row never collides with a real account. ⚠ Never send it to GitHub.
//   review_comments /     author_id = the bot; limn_posted_by_user_id = the person who posted it.
//   pr_comments
//   workspace_reviewers   one row per workspace the bot appears in: automated, role 'review',
//                         kind 'pierre', label "Limn · alice" (an 'auto' row the classifier's
//                         step 0 re-derives identically; a reader's rename pins it as usual).
//
// ⚠ "IS THIS MY OWN POST" READS THE TRUE POSTER — `trueAuthorId(table)`, never `author_id`.
//
// Which comment is a finding is ONE predicate, shared `limnFindingPost` (marker + a severity or
// reminder lead); which thread REPLY is Limn's is another, shared `isLimnThreadReply` (any Limn
// marker: a pushback, an acknowledgement / resolve reply, a "Still open:" reply, a "Post reply" —
// stored under the same bot, so it is never read as the person's own answer). Sync applies both on every walk (sync/upsert.ts `persistPr`), so a body edited to
// drop the marker goes back to its person; `reconcileLimnFindingAuthors` applies the same rule to
// rows already stored (boot, and the demo seed).
import { and, eq, inArray, isNotNull, like, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  hasLimnRunTrailer,
  isLimnAuthoredBody,
  isLimnBotLogin,
  isLimnThreadReply,
  limnBotLabel,
  limnBotLogin,
  limnFindingPost,
  LIMN_BOT_LOGIN_PREFIX,
} from '@pierre-review/shared';
import { db, runTransaction, schema, type Executor } from './client.js';
import { syncLimnFindingLabels } from './limn-finding-labels.js';
import { accountLimnLedger } from './limn-actions.js';
import { config } from '../config.js';
import { trueAuthorId, trueMergerId } from './true-author.js';

const {
  users,
  pullRequests,
  reviewComments,
  prComments,
  reviewThreads,
  reviews,
  commits,
  events,
  searchIndex,
  workspaceRepos,
  workspaceReviewers,
} = schema;

// The person behind a row: `trueAuthorId` / `trueMergerId` (db/true-author.ts, DB-free), re-exported.
export { trueAuthorId, trueMergerId } from './true-author.js';

// ── THE ONE RESOLVER: is this row Limn's? (pure; sync's `persistPr` and `reattributeLimnRows`) ──────
//
// A row is Limn's when ANY of these holds:
//   (a) its GitHub id / commit sha is in the provenance ledger (`limn_actions`, this install's writes);
//   (b) its body carries a Limn hidden marker outside quoted lines (`isLimnAuthoredBody`; a teammate's
//       Limn too);
//   (c) it is an EMPTY COMMENTED review whose every inline comment is Limn's (the wrapper GitHub makes
//       around a reply or a standalone comment; `review_comments.review_database_id`);
//   (d) it is a commit whose message carries a `Limn-Run:` trailer.
// `wide` false is the narrower rule of the finding era (a finding, a marked reply): sync applies it
// while `config.limnAttributeAll` is off, so nothing moves until the history moves with it.

export type LimnCommentRule = 'thread_root' | 'thread_reply' | 'pr_comment';

export interface LimnLedgerIds {
  commentIds?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  reviewIds?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  commitShas?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}

const hasId = (set: ReadonlySet<string> | ReadonlyMap<string, unknown> | undefined, id: string | number | null | undefined): boolean =>
  id != null && set != null && set.has(String(id));

/** Is this comment Limn's? A thread ROOT or a PR comment by the finding rule, a REPLY by the reply rule;
 *  `wide` adds any marker and the ledger. Pure. */
export function commentIsLimn(
  c: { body: string | null | undefined; databaseId?: string | number | null },
  rule: LimnCommentRule,
  o: { wide: boolean; ledger?: LimnLedgerIds },
): boolean {
  if (rule === 'thread_reply' ? isLimnThreadReply(c.body) : limnFindingPost(c.body, { threadRoot: rule === 'thread_root' }) != null) {
    return true;
  }
  if (!o.wide) return false;
  return isLimnAuthoredBody(c.body) || hasId(o.ledger?.commentIds, c.databaseId);
}

/** Is this review Limn's? (a), (b) or (c). `commentsLimn`: per review database id, whether each of
 *  its inline comments is Limn's. Pure. */
export function reviewIsLimn(
  r: { databaseId: string | number | null | undefined; body: string | null | undefined; state: string },
  o: { ledger?: LimnLedgerIds; commentsLimn?: ReadonlyMap<string, readonly boolean[]> },
): boolean {
  if (hasId(o.ledger?.reviewIds, r.databaseId)) return true;
  if (isLimnAuthoredBody(r.body)) return true;
  if ((r.body ?? '').trim() === '' && r.state === 'commented' && r.databaseId != null) {
    const cs = o.commentsLimn?.get(String(r.databaseId));
    if (cs != null && cs.length > 0 && cs.every(Boolean)) return true;
  }
  return false;
}

/** Is this commit Limn's? (a) or (d). Pure. */
export function commitIsLimn(c: { sha: string; message: string | null | undefined }, o: { ledger?: LimnLedgerIds }): boolean {
  return hasId(o.ledger?.commitShas, c.sha.toLowerCase()) || hasLimnRunTrailer(c.message);
}

/** Who Limn merged or opened a PR for, from the ledger: the merger / author moves to the bot only
 *  when GitHub names that same person (a queue landing named after a bot stays as GitHub says). Pure. */
export function prLimnRoles(
  pr: { authorId: number | null; mergedById: number | null },
  ledger: { mergedFor: number | null; openedFor: number | null },
): { openedFor: number | null; mergedFor: number | null } {
  return {
    openedFor: ledger.openedFor != null && pr.authorId === ledger.openedFor ? ledger.openedFor : null,
    mergedFor: ledger.mergedFor != null && pr.mergedById === ledger.mergedFor ? ledger.mergedFor : null,
  };
}

/** Per-repo access to the posters' `limn:` bots: created on first use, with the bot's reviewer row in
 *  the repo's workspace. `botFor(login)` is null for a missing login or one that is already a bot. */
export interface LimnAttributor {
  botFor(posterLogin: string | null | undefined): Promise<number | null>;
}

export async function limnAttributor(exec: Executor, accountId: number, repoId: number): Promise<LimnAttributor> {
  const workspaceId = (
    await exec
      .select({ workspaceId: workspaceRepos.workspaceId })
      .from(workspaceRepos)
      .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.repoId, repoId)))
      .limit(1)
      .execute()
  )[0]?.workspaceId;
  const cache = new Map<string, number>();
  return {
    async botFor(login) {
      if (!login || isLimnBotLogin(login)) return null;
      let id = cache.get(login);
      if (id === undefined) {
        id = await ensureLimnBotUser(exec, login);
        cache.set(login, id);
        if (workspaceId != null) await ensureLimnReviewerRow(exec, accountId, workspaceId, id, login);
      }
      return id;
    },
  };
}

/** The SQL LIKE pattern every `limn:` login matches. */
const LIMN_LOGIN_LIKE = `${LIMN_BOT_LOGIN_PREFIX}%`;

/** The per-poster Limn bot user for `posterLogin`: created on first use, always is_bot. */
export async function ensureLimnBotUser(exec: Executor, posterLogin: string): Promise<number> {
  const row = (
    await exec
      .insert(users)
      .values({
        githubLogin: limnBotLogin(posterLogin),
        githubNodeId: null,
        displayName: limnBotLabel(posterLogin),
        avatarUrl: null,
        githubType: null,
        isBot: true,
        isBotOverridden: true,
      })
      .onConflictDoUpdate({
        target: users.githubLogin,
        set: { isBot: true, isBotOverridden: true, displayName: limnBotLabel(posterLogin) },
      })
      .returning({ id: users.id })
      .execute()
  )[0]!;
  return row.id;
}

/**
 * The bot's row in one workspace — written once, never overwritten here (`DO NOTHING`), so a
 * reader's rename or judgement stands. Names no price or trust column. The values are exactly what
 * `classifyReviewer`'s step 0 derives, so a later classification pass changes nothing.
 */
export async function ensureLimnReviewerRow(
  exec: Executor,
  accountId: number,
  workspaceId: number,
  botUserId: number,
  posterLogin: string,
): Promise<void> {
  await exec
    .insert(workspaceReviewers)
    .values({
      accountId,
      workspaceId,
      authorUserId: botUserId,
      automated: true,
      role: 'review',
      confidence: 'high',
      source: 'fingerprint',
      reasonsJson: [LIMN_BOT_REASON],
      kind: 'pierre',
      label: limnBotLabel(posterLogin),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        workspaceReviewers.accountId,
        workspaceReviewers.workspaceId,
        workspaceReviewers.authorUserId,
      ],
    })
    .execute();
}

export const LIMN_BOT_REASON = 'posts Limn review findings';

/** Every `limn:` bot user id (global, like `users`). */
export async function limnBotUserIds(exec: Executor = db): Promise<number[]> {
  const rows = await exec
    .select({ id: users.id })
    .from(users)
    .where(like(users.githubLogin, LIMN_LOGIN_LIKE))
    .execute();
  return rows.map((r) => r.id);
}

/** The reader's own Limn bot (`limn:<their login>`), or null while they have posted no finding. */
export async function limnBotUserIdFor(posterLogin: string, exec: Executor = db): Promise<number | null> {
  const row = (
    await exec
      .select({ id: users.id })
      .from(users)
      .where(eq(users.githubLogin, limnBotLogin(posterLogin)))
      .limit(1)
      .execute()
  )[0];
  return row?.id ?? null;
}

/** The Limn bot of the person `userId` (by their login), or null when they have none. */
export async function limnBotUserIdForUser(userId: number, exec: Executor = db): Promise<number | null> {
  const row = (
    await exec
      .select({ login: users.githubLogin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute()
  )[0];
  if (!row?.login || isLimnBotLogin(row.login)) return null;
  return limnBotUserIdFor(row.login, exec);
}

/**
 * The attribution sync would give a freshly-posted review-thread REPLY (the instant local row a
 * "Post reply" writes before the next walk): a Limn-marked reply (`isLimnThreadReply`) goes under the
 * poster's `limn:` bot with the poster kept beside it; anything else stays its author's. DB only.
 */
export async function limnReplyAttribution(
  exec: Executor,
  a: { accountId: number; prId: number; posterUserId: number | null; body: string | null },
): Promise<{ authorId: number | null; limnPostedByUserId: number | null }> {
  const plain = { authorId: a.posterUserId, limnPostedByUserId: null };
  if (a.posterUserId == null || !isLimnThreadReply(a.body)) return plain;
  const poster = (
    await exec.select({ login: users.githubLogin }).from(users).where(eq(users.id, a.posterUserId)).limit(1).execute()
  )[0];
  if (!poster?.login || isLimnBotLogin(poster.login)) return plain;
  const botId = await ensureLimnBotUser(exec, poster.login);
  const ws = (
    await exec
      .select({ workspaceId: workspaceRepos.workspaceId })
      .from(pullRequests)
      .innerJoin(
        workspaceRepos,
        and(eq(workspaceRepos.repoId, pullRequests.repoId), eq(workspaceRepos.accountId, a.accountId)),
      )
      .where(and(eq(pullRequests.id, a.prId), eq(pullRequests.accountId, a.accountId)))
      .limit(1)
      .execute()
  )[0];
  if (ws) await ensureLimnReviewerRow(exec, a.accountId, ws.workspaceId, botId, poster.login);
  return { authorId: botId, limnPostedByUserId: a.posterUserId };
}

export interface LimnReconcileResult {
  /** Comment rows whose author changed (either direction). */
  comments: number;
  /** Threads whose root author changed. */
  threads: number;
  /** Wrongly-classed human rows removed (kind 'pierre' on a person). */
  repairedReviewerRows: number;
}

/**
 * Apply the sync's rule to every stored comment that is, or was, a Limn finding: re-attribute it to
 * the poster's bot, or give it back to its person. Fixes the comment's event actor, its search-index
 * author and its thread's root author with it, and ensures the bot's reviewer rows. Idempotent: a
 * second run writes no comment, event, search or thread row. DB only, one transaction.
 */
export async function reconcileLimnFindingAuthors(
  accountId: number,
  opts: { wide?: boolean; ledger?: LimnLedgerIds; prIds?: readonly number[] } = {},
): Promise<LimnReconcileResult> {
  // `wide` (config.limnAttributeAll, or `reattributeLimnRows`): any Limn marker on any comment, and the
  // ledger's comment ids (`commentIsLimn`). Off: the finding rule and the reply rule only.
  const wide = opts.wide ?? config.limnAttributeAll;
  const ledger: LimnLedgerIds | undefined = wide ? (opts.ledger ?? (await accountLimnLedger(db, accountId))) : undefined;
  const inPrs = (col: typeof reviewComments.prId | typeof prComments.prId) =>
    opts.prIds != null ? inArray(col, opts.prIds.length > 0 ? [...opts.prIds] : [-1]) : undefined;
  // A wide pass also reads every comment on a PR the ledger names (an unmarked Limn comment).
  const onLedgerPr = (col: typeof reviewComments.prId | typeof prComments.prId) =>
    wide ? sql`${col} in (select la.pr_id from limn_actions la where la.account_id = ${accountId} and la.pr_id is not null)` : undefined;
  // Thread replies wear any Limn marker (the pushback's too); PR-level comments follow the finding rule.
  const markerLike = '%pierre:claude-review%';
  const poster = sql<number | null>`coalesce(${reviewComments.limnPostedByUserId}, ${reviewComments.authorId})`;
  const rcRows = await db
    .select({
      id: reviewComments.id,
      prId: reviewComments.prId,
      nodeId: reviewComments.githubNodeId,
      threadId: reviewComments.threadId,
      repoId: pullRequests.repoId,
      body: reviewComments.body,
      databaseId: reviewComments.databaseId,
      authorId: reviewComments.authorId,
      limnPostedBy: reviewComments.limnPostedByUserId,
      posterId: poster,
      // A finding is always its thread's ROOT (the earliest comment); a reply never is one.
      isRoot: sql<number>`not exists (select 1 from review_comments rc2 where rc2.thread_id = ${reviewComments.threadId} and (rc2.created_at < ${reviewComments.createdAt} or (rc2.created_at = ${reviewComments.createdAt} and rc2.id < ${reviewComments.id})))`,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inPrs(reviewComments.prId),
        or(like(reviewComments.body, markerLike), isNotNull(reviewComments.limnPostedByUserId), onLedgerPr(reviewComments.prId)),
      ),
    )
    .execute();
  const pcPoster = sql<number | null>`coalesce(${prComments.limnPostedByUserId}, ${prComments.authorId})`;
  const pcRows = await db
    .select({
      id: prComments.id,
      prId: prComments.prId,
      nodeId: prComments.githubNodeId,
      repoId: pullRequests.repoId,
      body: prComments.body,
      databaseId: prComments.databaseId,
      authorId: prComments.authorId,
      limnPostedBy: prComments.limnPostedByUserId,
      posterId: pcPoster,
    })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inPrs(prComments.prId),
        or(like(prComments.body, markerLike), isNotNull(prComments.limnPostedByUserId), onLedgerPr(prComments.prId)),
      ),
    )
    .execute();

  const posterIds = [
    ...new Set([...rcRows, ...pcRows].map((r) => r.posterId).filter((id): id is number => id != null)),
  ];
  const posterLogin = new Map<number, string>();
  if (posterIds.length > 0) {
    for (const u of await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.id, posterIds))
      .execute())
      posterLogin.set(u.id, u.login);
  }
  const workspaceOfRepo = new Map<number, number>();
  for (const m of await db
    .select({ repoId: workspaceRepos.repoId, workspaceId: workspaceRepos.workspaceId })
    .from(workspaceRepos)
    .where(eq(workspaceRepos.accountId, accountId))
    .execute())
    workspaceOfRepo.set(m.repoId, m.workspaceId);

  return runTransaction(async (tx) => {
    const botIdByLogin = new Map<string, number>();
    const botFor = async (login: string): Promise<number> => {
      let id = botIdByLogin.get(login);
      if (id === undefined) {
        id = await ensureLimnBotUser(tx, login);
        botIdByLogin.set(login, id);
      }
      return id;
    };
    // The rule, per row: { authorId, limnPostedBy } as sync would write it now.
    // `reply`: a review-thread comment that is not its thread's root (the reply rule, as sync's).
    const desired = async (r: {
      body: string | null;
      databaseId: string | null;
      posterId: number | null;
      repoId: number;
    }, threadRoot = false, reply = false): Promise<{ authorId: number | null; limnPostedBy: number | null }> => {
      const login = r.posterId != null ? posterLogin.get(r.posterId) : undefined;
      const rule: LimnCommentRule = reply ? 'thread_reply' : threadRoot ? 'thread_root' : 'pr_comment';
      const isLimn = commentIsLimn({ body: r.body, databaseId: r.databaseId }, rule, { wide, ...(ledger ? { ledger } : {}) });
      if (r.posterId == null || login == null || isLimnBotLogin(login) || !isLimn) {
        return { authorId: r.posterId, limnPostedBy: null };
      }
      const botId = await botFor(login);
      const ws = workspaceOfRepo.get(r.repoId);
      if (ws != null) await ensureLimnReviewerRow(tx, accountId, ws, botId, login);
      return { authorId: botId, limnPostedBy: r.posterId };
    };

    let comments = 0;
    const touchedThreads = new Set<number>();
    for (const r of rcRows) {
      const d = await desired(r, Boolean(r.isRoot), !r.isRoot);
      if (d.authorId === r.authorId && d.limnPostedBy === r.limnPostedBy) continue;
      comments++;
      touchedThreads.add(r.threadId);
      await tx
        .update(reviewComments)
        .set({ authorId: d.authorId, limnPostedByUserId: d.limnPostedBy })
        .where(eq(reviewComments.id, r.id))
        .execute();
      await retagActor(tx, accountId, 'review_comment', r.prId, r.id, r.nodeId, d.authorId);
    }
    for (const r of pcRows) {
      const d = await desired(r);
      if (d.authorId === r.authorId && d.limnPostedBy === r.limnPostedBy) continue;
      comments++;
      await tx
        .update(prComments)
        .set({ authorId: d.authorId, limnPostedByUserId: d.limnPostedBy })
        .where(eq(prComments.id, r.id))
        .execute();
      await retagActor(tx, accountId, 'pr_comment', r.prId, r.id, r.nodeId, d.authorId);
    }

    // A thread's root author follows its first comment (sync takes GitHub's first; the earliest
    // stored comment is the same one).
    let threads = 0;
    for (const threadId of touchedThreads) {
      const root = (
        await tx
          .select({ authorId: reviewComments.authorId })
          .from(reviewComments)
          .where(eq(reviewComments.threadId, threadId))
          .orderBy(reviewComments.createdAt, reviewComments.id)
          .limit(1)
          .execute()
      )[0];
      if (!root) continue;
      threads += (
        await tx
          .update(reviewThreads)
          .set({ originalCommenterId: root.authorId })
          .where(
            and(
              eq(reviewThreads.id, threadId),
              sql`${reviewThreads.originalCommenterId} is not ${root.authorId}`,
            ),
          )
          .returning({ id: reviewThreads.id })
          .execute()
      ).length;
    }

    // REPAIR: an older classifier could class a PERSON as Limn (kind 'pierre') from the marker on
    // their posts. Only the `limn:` bots are Limn. Rows nobody touched by hand (auto judgement,
    // auto identity, no price, no trust) are deleted; the next Bots read re-derives them.
    const repaired = await tx
      .delete(workspaceReviewers)
      .where(
        and(
          eq(workspaceReviewers.accountId, accountId),
          eq(workspaceReviewers.kind, 'pierre'),
          eq(workspaceReviewers.source, 'fingerprint'),
          eq(workspaceReviewers.identitySource, 'auto'),
          sql`${workspaceReviewers.monthlyCents} is null`,
          sql`${workspaceReviewers.dependencyTrusted} is null`,
          sql`${workspaceReviewers.authorUserId} not in (select ${users.id} from ${users} where ${users.githubLogin} like ${LIMN_LOGIN_LIKE})`,
        ),
      )
      .returning({ id: workspaceReviewers.id })
      .execute();

    // The severity badges follow the attribution (db/limn-finding-labels.ts).
    await syncLimnFindingLabels(tx, accountId);

    return { comments, threads, repairedReviewerRows: repaired.length };
  });
}

// A comment's event actor and search-index author follow its author.
async function retagActor(
  tx: Executor,
  accountId: number,
  kind: 'review_comment' | 'pr_comment',
  prId: number,
  rowId: number,
  nodeId: string,
  authorId: number | null,
): Promise<void> {
  await tx
    .update(events)
    .set({ actorId: authorId })
    .where(and(eq(events.accountId, accountId), eq(events.dedupeKey, `${kind}:${nodeId}`)))
    .execute();
  await tx
    .update(searchIndex)
    .set({ authorId })
    .where(
      // `pr_id` first: it is what the index covers (search_pr_idx).
      and(
        eq(searchIndex.prId, prId),
        eq(searchIndex.accountId, accountId),
        eq(searchIndex.kind, kind),
        eq(searchIndex.refId, rowId),
      ),
    )
    .execute();
}

// ── THE RE-ATTRIBUTION OF STORED ROWS (the history backfill's ONE entry point) ─────────────────────
//
// `reattributeLimnRows` applies the WIDE rule (the resolver above + the account's ledger) to rows
// already stored: comments (via `reconcileLimnFindingAuthors`), reviews (with the reply-wrapper rule
// over `review_comments.review_database_id`), commits, and the PR's own author / merger. Each row's
// author becomes the poster's `limn:` bot with the person in its `limn_*_by` column — or goes back to
// the person when the rule no longer holds. Events (`actor_id`) and the search index follow. Idempotent:
// a second run writes nothing. DB only; reads outside, writes in ONE transaction.
//
// ⚠ NOT WIRED INTO BOOT. Run it deliberately (the backfill), against a COPY first. Rows a heuristic
// would guess (past AI Fix commits without a sha) are never touched: only the four rules above.

export interface LimnReattributeResult extends LimnReconcileResult {
  reviews: number;
  commits: number;
  prs: number;
}

export async function reattributeLimnRows(
  accountId: number,
  opts: { prIds?: readonly number[] } = {},
): Promise<LimnReattributeResult> {
  const ledger = await accountLimnLedger(db, accountId);
  const ledgerIds: LimnLedgerIds = { commentIds: ledger.commentIds, reviewIds: ledger.reviewIds, commitShas: ledger.commitShas };
  // Comments first: the wrapper rule below reads the comment rule, not the stored author.
  const commentsResult = await reconcileLimnFindingAuthors(accountId, { wide: true, ledger: ledgerIds, ...(opts.prIds ? { prIds: opts.prIds } : {}) });
  const prScope = (col: typeof pullRequests.id) =>
    opts.prIds != null ? inArray(col, opts.prIds.length > 0 ? [...opts.prIds] : [-1]) : undefined;

  // (c) the wrapper rule's input: per review database id, whether each of its comments is Limn's.
  const rcRows = await db
    .select({
      reviewDbId: reviewComments.reviewDatabaseId,
      body: reviewComments.body,
      databaseId: reviewComments.databaseId,
      isRoot: sql<number>`not exists (select 1 from review_comments rc2 where rc2.thread_id = ${reviewComments.threadId} and (rc2.created_at < ${reviewComments.createdAt} or (rc2.created_at = ${reviewComments.createdAt} and rc2.id < ${reviewComments.id})))`,
    })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(and(eq(pullRequests.accountId, accountId), prScope(pullRequests.id), isNotNull(reviewComments.reviewDatabaseId)))
    .execute();
  const commentsLimn = new Map<string, boolean[]>();
  for (const c of rcRows) {
    const list = commentsLimn.get(c.reviewDbId!) ?? [];
    list.push(commentIsLimn({ body: c.body, databaseId: c.databaseId }, c.isRoot ? 'thread_root' : 'thread_reply', { wide: true, ledger: ledgerIds }));
    commentsLimn.set(c.reviewDbId!, list);
  }

  const person = alias(users, 'limn_person');
  const reviewRows = await db
    .select({
      id: reviews.id,
      prId: reviews.prId,
      repoId: pullRequests.repoId,
      nodeId: reviews.githubNodeId,
      databaseId: reviews.databaseId,
      body: reviews.body,
      state: reviews.state,
      authorId: reviews.authorId,
      limnPostedBy: reviews.limnPostedByUserId,
      personId: trueAuthorId(reviews),
      personLogin: person.githubLogin,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .leftJoin(person, eq(person.id, trueAuthorId(reviews)))
    .where(and(eq(pullRequests.accountId, accountId), prScope(pullRequests.id)))
    .execute();

  const commitRows = await db
    .select({
      id: commits.id,
      prId: commits.prId,
      repoId: pullRequests.repoId,
      prNodeId: pullRequests.githubNodeId,
      sha: commits.sha,
      message: commits.message,
      authorId: commits.authorId,
      limnPushedBy: commits.limnPushedByUserId,
      personId: trueAuthorId(commits),
      personLogin: person.githubLogin,
    })
    .from(commits)
    .innerJoin(pullRequests, eq(pullRequests.id, commits.prId))
    .leftJoin(person, eq(person.id, trueAuthorId(commits)))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        prScope(pullRequests.id),
        or(
          isNotNull(commits.limnPushedByUserId),
          like(commits.message, '%Limn-Run:%'),
          sql`lower(${commits.sha}) in (select lower(la.commit_sha) from limn_actions la where la.account_id = ${accountId} and la.commit_sha is not null)`,
        ),
      ),
    )
    .execute();

  const merger = alias(users, 'limn_merger');
  const prRows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      authorId: pullRequests.authorId,
      mergedById: pullRequests.mergedById,
      openedFor: pullRequests.limnOpenedForUserId,
      mergedFor: pullRequests.limnMergedForUserId,
      personId: trueAuthorId(pullRequests),
      personLogin: person.githubLogin,
      mergerId: trueMergerId(pullRequests),
      mergerLogin: merger.githubLogin,
    })
    .from(pullRequests)
    .leftJoin(person, eq(person.id, trueAuthorId(pullRequests)))
    .leftJoin(merger, eq(merger.id, trueMergerId(pullRequests)))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        prScope(pullRequests.id),
        or(
          isNotNull(pullRequests.limnOpenedForUserId),
          isNotNull(pullRequests.limnMergedForUserId),
          sql`${pullRequests.id} in (select la.pr_id from limn_actions la where la.account_id = ${accountId} and la.pr_id is not null and la.kind in ('merge', 'enqueue', 'open_pr'))`,
        ),
      ),
    )
    .execute();

  const counts = await runTransaction(async (tx) => {
    const attributors = new Map<number, LimnAttributor>();
    const botFor = async (repoId: number, login: string | null): Promise<number | null> => {
      let a = attributors.get(repoId);
      if (!a) {
        a = await limnAttributor(tx, accountId, repoId);
        attributors.set(repoId, a);
      }
      return a.botFor(login);
    };

    let reviewsChanged = 0;
    for (const r of reviewRows) {
      if (r.personId == null) continue;
      const isLimn = reviewIsLimn({ databaseId: r.databaseId, body: r.body, state: r.state }, { ledger: ledgerIds, commentsLimn });
      const bot = isLimn ? await botFor(r.repoId, r.personLogin) : null;
      const want = { authorId: bot ?? r.personId, limnPostedBy: bot != null ? r.personId : null };
      if (want.authorId === r.authorId && want.limnPostedBy === r.limnPostedBy) continue;
      reviewsChanged++;
      await tx.update(reviews).set({ authorId: want.authorId, limnPostedByUserId: want.limnPostedBy }).where(eq(reviews.id, r.id)).execute();
      await tx
        .update(events)
        .set({ actorId: want.authorId })
        .where(and(eq(events.accountId, accountId), eq(events.dedupeKey, `review_submitted:${r.nodeId}`)))
        .execute();
      await tx
        .update(searchIndex)
        .set({ authorId: want.authorId })
        .where(and(eq(searchIndex.prId, r.prId), eq(searchIndex.accountId, accountId), eq(searchIndex.kind, 'review'), eq(searchIndex.refId, r.id)))
        .execute();
    }

    let commitsChanged = 0;
    for (const c of commitRows) {
      if (c.personId == null) continue;
      const bot = commitIsLimn({ sha: c.sha, message: c.message }, { ledger: ledgerIds }) ? await botFor(c.repoId, c.personLogin) : null;
      const want = { authorId: bot ?? c.personId, limnPushedBy: bot != null ? c.personId : null };
      if (want.authorId === c.authorId && want.limnPushedBy === c.limnPushedBy) continue;
      commitsChanged++;
      await tx.update(commits).set({ authorId: want.authorId, limnPushedByUserId: want.limnPushedBy }).where(eq(commits.id, c.id)).execute();
      await tx
        .update(events)
        .set({ actorId: want.authorId })
        .where(and(eq(events.accountId, accountId), eq(events.dedupeKey, `commit_pushed:${c.prNodeId}:${c.sha}`)))
        .execute();
    }

    let prsChanged = 0;
    for (const p of prRows) {
      const roles = prLimnRoles(
        { authorId: p.personId, mergedById: p.mergerId },
        { mergedFor: ledger.mergedFor.get(p.id) ?? null, openedFor: ledger.openedFor.get(p.id) ?? null },
      );
      const openedBot = roles.openedFor != null ? await botFor(p.repoId, p.personLogin) : null;
      const mergedBot = roles.mergedFor != null ? await botFor(p.repoId, p.mergerLogin) : null;
      const want = {
        authorId: openedBot ?? p.personId,
        openedFor: openedBot != null ? roles.openedFor : null,
        mergedById: mergedBot ?? p.mergerId,
        mergedFor: mergedBot != null ? roles.mergedFor : null,
      };
      if (
        want.authorId === p.authorId &&
        want.openedFor === p.openedFor &&
        want.mergedById === p.mergedById &&
        want.mergedFor === p.mergedFor
      )
        continue;
      prsChanged++;
      await tx
        .update(pullRequests)
        .set({
          authorId: want.authorId,
          limnOpenedForUserId: want.openedFor,
          mergedById: want.mergedById,
          limnMergedForUserId: want.mergedFor,
        })
        .where(eq(pullRequests.id, p.id))
        .execute();
      if (want.authorId !== p.authorId) {
        // The PR's lifecycle events name its author (sync/upsert.ts), and so does its search row.
        await tx
          .update(events)
          .set({ actorId: want.authorId })
          .where(and(eq(events.accountId, accountId), eq(events.prId, p.id), eq(events.refTable, 'pull_requests'), eq(events.refId, p.id)))
          .execute();
        await tx
          .update(searchIndex)
          .set({ authorId: want.authorId })
          .where(and(eq(searchIndex.prId, p.id), eq(searchIndex.accountId, accountId), eq(searchIndex.kind, 'pr'), eq(searchIndex.refId, p.id)))
          .execute();
      }
    }
    return { reviews: reviewsChanged, commits: commitsChanged, prs: prsChanged };
  });
  return { ...commentsResult, ...counts };
}
