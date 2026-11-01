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
// reminder lead). Sync applies it on every walk (sync/upsert.ts `persistPr`), so a body edited to
// drop the marker goes back to its person; `reconcileLimnFindingAuthors` applies the same rule to
// rows already stored (boot, and the demo seed).
import { and, eq, inArray, isNotNull, like, or, sql, type SQL } from 'drizzle-orm';
import {
  isLimnBotLogin,
  limnBotLabel,
  limnBotLogin,
  limnFindingPost,
  LIMN_BOT_LOGIN_PREFIX,
} from '@pierre-review/shared';
import { db, runTransaction, schema, type Executor } from './client.js';
import { syncLimnFindingLabels } from './limn-finding-labels.js';

const {
  users,
  pullRequests,
  reviewComments,
  prComments,
  reviewThreads,
  events,
  searchIndex,
  workspaceRepos,
  workspaceReviewers,
} = schema;

/** The person who wrote a comment row: the poster of a Limn finding, else its author. */
export function trueAuthorId(t: typeof reviewComments | typeof prComments): SQL<number | null> {
  return sql<number | null>`coalesce(${t.limnPostedByUserId}, ${t.authorId})`;
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
export async function reconcileLimnFindingAuthors(accountId: number): Promise<LimnReconcileResult> {
  const markerLike = '%pierre:claude-review-finding%';
  const poster = sql<number | null>`coalesce(${reviewComments.limnPostedByUserId}, ${reviewComments.authorId})`;
  const rcRows = await db
    .select({
      id: reviewComments.id,
      prId: reviewComments.prId,
      nodeId: reviewComments.githubNodeId,
      threadId: reviewComments.threadId,
      repoId: pullRequests.repoId,
      body: reviewComments.body,
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
        or(like(reviewComments.body, markerLike), isNotNull(reviewComments.limnPostedByUserId)),
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
      authorId: prComments.authorId,
      limnPostedBy: prComments.limnPostedByUserId,
      posterId: pcPoster,
    })
    .from(prComments)
    .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        or(like(prComments.body, markerLike), isNotNull(prComments.limnPostedByUserId)),
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
    const desired = async (r: {
      body: string | null;
      posterId: number | null;
      repoId: number;
    }): Promise<{ authorId: number | null; limnPostedBy: number | null }> => {
      const login = r.posterId != null ? posterLogin.get(r.posterId) : undefined;
      if (r.posterId == null || login == null || isLimnBotLogin(login) || limnFindingPost(r.body) == null) {
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
      const d = await desired(r.isRoot ? r : { ...r, body: null });
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
