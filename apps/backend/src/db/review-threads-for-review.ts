// CLAUDE REVIEW — the OTHER reviewers' open threads on a PR (CORE, DB-only, no GitHub call).
//
// Two readers, ONE predicate:
//   • the review run loads every review thread (resolved ones too) that is NOT rooted on one of Limn's own
//     posted findings (`loadReviewThreadsForReview`) and asks Claude, per thread, whether the
//     comment is right and whether the code has dealt with it (review/claude-review/threads.ts);
//   • the auto-review sweeper re-reviews the SAME head when a newer qualifying comment arrives
//     (`newestReviewCommentAt`, read by `getAutoReviewCandidates`).
//
// ⚠ A QUALIFYING COMMENT is a review-thread comment in an UNRESOLVED thread that Limn did NOT post,
// by a person or a review bot (the `countsAuthor` filter below). Both readers go through `isLimnPostedComment`, so the comment
// the run records as "seen" (`claude_reviews.comments_through`) and the comment the sweeper treats
// as "new" can never disagree; if they did, a review could re-trigger itself forever.
//
// ⚠ HOW WE KNOW LIMN POSTED IT. Limn posts AS THE READER (their own GitHub token), so TWO facts
// must hold together:
//   A. the comment's author is the ACCOUNT'S OWN GitHub login (accounts.github_login, compared
//      case-insensitively) — a marker someone else pasted, or a teammate's own Limn post, is
//      another reviewer's comment; and
//   B. it carries Limn's provenance — any one of:
//      1. the hidden `<!-- pierre:claude-review` marker. Every finding comment carries
//         `<!-- pierre:claude-review-finding v=1 -->` (post-review.ts FINDING_COMMENT_MARKER), review
//         bodies their own spelling of it. It survives an edit on GitHub. ⚠ The retired per-ticket
//         "Post as comment" stamped `<!-- pierre:claude-review-ticket v=1 -->`; nothing produces it
//         now (a story's results post as findings), but comments already on GitHub carry it, so
//         the match stays a PREFIX — never narrow it to the finding spelling;
//      2. LEGACY, for comments posted before that marker existed: the comment's GitHub id is a
//         posted finding's `github_comment_id`, or its text STARTS WITH a posted finding's resolved
//         body (an edit on GitHub defeats this one — hence the marker).
// An unknown author (a deleted account, an unsynced user) is never "own".
//
// ⚠ ONLY REAL REVIEWERS MOVE THE TRIGGER. The comment-time half (`newestReviewCommentAt`, and the
// loader's `newestCommentAt` that becomes `comments_through`) also takes a `countsAuthor` filter —
// built ONCE per workspace by db/queries.ts `reReviewCommentAuthorFilter`: a person, or a bot whose
// role in this workspace is `'review'`. CI, coverage, deploy and dependency bots never re-trigger a
// review. Both readers get the SAME filter, so what a run records as seen and what the sweeper
// calls new still agree. ⚠ The THREADS themselves are not filtered: the review still assesses
// every open thread, whoever wrote it.
import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from './client.js';
import { globalAutomationUserIds } from './automation-ids.js';

const LIMN_MARKER = /<!--\s*pierre:claude-review/i;

export interface OwnPostedComments {
  // Resolved bodies of this PR's posted findings, normalised.
  bodies: string[];
  // GitHub ids stored for findings posted one at a time.
  commentIds: Set<string>;
}

/** Does a comment by this author move the auto re-review trigger? Absent ⇒ every author does. */
export type CountsAuthor = (authorId: number | null) => boolean;

const norm = (s: string): string => s.replace(/\r\n?/g, '\n').trim();

/** The account's own GitHub login — the author half of `isLimnPostedComment`. */
export async function accountGithubLogin(accountId: number): Promise<string | null> {
  const row = (
    await db
      .select({ login: schema.accounts.githubLogin })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1)
      .execute()
  )[0];
  return row?.login ?? null;
}

/** Is this review-thread comment one Limn posted? (The ONE predicate — see the header.) */
export function isLimnPostedComment(
  c: { body: string | null; databaseId: string | null; authorLogin: string | null },
  own: OwnPostedComments | undefined,
  accountLogin: string | null,
): boolean {
  if (!accountLogin || !c.authorLogin) return false;
  if (c.authorLogin.toLowerCase() !== accountLogin.toLowerCase()) return false;
  const body = c.body ?? '';
  if (LIMN_MARKER.test(body)) return true;
  if (!own) return false;
  if (c.databaseId != null && own.commentIds.has(c.databaseId)) return true;
  const text = norm(body);
  if (!text) return false;
  return own.bodies.some((b) => b.length > 0 && text.startsWith(b));
}

/** Every POSTED finding's resolved body + stored comment id, per PR (account-scoped). */
export async function ownPostedCommentsForPrs(
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, OwnPostedComments>> {
  const out = new Map<number, OwnPostedComments>();
  if (prIds.length === 0) return out;
  const { claudeReviews: cr, claudeReviewFindings: crf } = schema;
  const rows = await db
    .select({
      prId: cr.prId,
      body: crf.body,
      editedBody: crf.editedBody,
      githubCommentId: crf.githubCommentId,
    })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .where(and(eq(cr.accountId, accountId), inArray(cr.prId, [...prIds]), isNotNull(crf.postedAt)))
    .execute();
  for (const r of rows) {
    let o = out.get(r.prId);
    if (!o) {
      o = { bodies: [], commentIds: new Set() };
      out.set(r.prId, o);
    }
    const resolved = r.editedBody && r.editedBody.trim() ? r.editedBody : r.body;
    o.bodies.push(norm(resolved));
    if (r.githubCommentId) o.commentIds.add(r.githubCommentId);
  }
  return out;
}

/**
 * The newest QUALIFYING review-thread comment per PR, created strictly after `since` (a lower bound
 * that keeps the scan small; pass the oldest cutoff you care about). PRs with none are absent.
 */
export async function newestReviewCommentAt(
  accountId: number,
  prIds: readonly number[],
  since: Date,
  // TRAILING: only these authors' comments count (see the header). Absent ⇒ every author.
  countsAuthor?: CountsAuthor,
): Promise<Map<number, Date>> {
  const times = await newestReviewCommentTimes(accountId, prIds, since, countsAuthor);
  return new Map([...times].map(([prId, t]) => [prId, t.newest]));
}

/**
 * `newestReviewCommentAt`, plus `newestOwn`: the newest of those comments inside a thread ROOTED on
 * one of Limn's own posted findings (the loader's `newestOwnThreadCommentAt`, same filter) — the
 * sweeper's "a reply on a Limn finding needs a full review" test, read in the same scan.
 */
export async function newestReviewCommentTimes(
  accountId: number,
  prIds: readonly number[],
  since: Date,
  countsAuthor?: CountsAuthor,
): Promise<Map<number, { newest: Date; newestOwn: Date | null }>> {
  const out = new Map<number, { newest: Date; newestOwn: Date | null }>();
  if (prIds.length === 0) return out;
  const { reviewComments: rc, reviewThreads: rt, pullRequests: prs, users } = schema;
  const rows = await db
    .select({
      prId: rc.prId,
      threadId: rc.threadId,
      createdAt: rc.createdAt,
      body: rc.body,
      databaseId: rc.databaseId,
      authorId: rc.authorId,
      authorLogin: users.githubLogin,
    })
    .from(rc)
    .innerJoin(rt, eq(rt.id, rc.threadId))
    .innerJoin(prs, eq(prs.id, rc.prId))
    .leftJoin(users, eq(users.id, rc.authorId))
    .where(
      and(
        eq(prs.accountId, accountId),
        inArray(rc.prId, [...prIds]),
        eq(rt.isResolved, false),
        gt(rc.createdAt, since),
      ),
    )
    .execute();
  if (rows.length === 0) return out;
  const [own, login] = await Promise.all([
    ownPostedCommentsForPrs(accountId, [...new Set(rows.map((r) => r.prId))]),
    accountGithubLogin(accountId),
  ]);
  const kept = rows.filter(
    (r) => !isLimnPostedComment(r, own.get(r.prId), login) && (!countsAuthor || countsAuthor(r.authorId ?? null)),
  );
  if (kept.length === 0) return out;
  // Which of those threads are rooted on Limn's own finding: the root is the thread's FIRST comment
  // (oldest, then lowest id — the loader's order), which may predate `since`.
  const ownRooted = new Set<number>();
  if (login && own.size > 0) {
    const threadIds = [...new Set(kept.filter((r) => own.has(r.prId) && r.threadId != null).map((r) => r.threadId!))];
    if (threadIds.length > 0) {
      const all = await db
        .select({
          id: rc.id,
          prId: rc.prId,
          threadId: rc.threadId,
          createdAt: rc.createdAt,
          body: rc.body,
          databaseId: rc.databaseId,
          authorLogin: users.githubLogin,
        })
        .from(rc)
        .innerJoin(prs, eq(prs.id, rc.prId))
        .leftJoin(users, eq(users.id, rc.authorId))
        .where(and(eq(prs.accountId, accountId), inArray(rc.threadId, threadIds)))
        .execute();
      const roots = new Map<number, (typeof all)[number]>();
      for (const c of all) {
        if (c.threadId == null) continue;
        const r = roots.get(c.threadId);
        if (!r || c.createdAt.getTime() < r.createdAt.getTime() || (c.createdAt.getTime() === r.createdAt.getTime() && c.id < r.id))
          roots.set(c.threadId, c);
      }
      for (const [threadId, root] of roots) {
        if (isLimnPostedComment(root, own.get(root.prId), login)) ownRooted.add(threadId);
      }
    }
  }
  for (const r of kept) {
    const prev = out.get(r.prId);
    const isOwn = r.threadId != null && ownRooted.has(r.threadId);
    if (!prev) {
      out.set(r.prId, { newest: r.createdAt, newestOwn: isOwn ? r.createdAt : null });
      continue;
    }
    if (r.createdAt.getTime() > prev.newest.getTime()) prev.newest = r.createdAt;
    if (isOwn && (!prev.newestOwn || r.createdAt.getTime() > prev.newestOwn.getTime())) prev.newestOwn = r.createdAt;
  }
  return out;
}

export interface ReviewThreadCommentForReview {
  authorLogin: string | null;
  authorIsBot: boolean;
  createdAt: Date;
  body: string;
}

export interface ReviewThreadForReview {
  threadId: number;
  path: string;
  line: number | null;
  isOutdated: boolean;
  // The sync heuristic's state.
  derivedState: string;
  // Marked resolved on GitHub. Resolved threads are loaded too (judged after the open ones, within
  // the same cap): resolving is a click, not evidence that the code dealt with it.
  isResolved: boolean;
  // github.com link to the first comment, when its id is synced.
  url: string | null;
  // Oldest first. Limn's own posted comments are left out.
  comments: ReviewThreadCommentForReview[];
  // The PR's synced commits dated after the thread's first / last comment.
  commitsAfterFirstComment: number;
  commitsAfterLastComment: number;
}

export interface ReviewThreadsForReview {
  threads: ReviewThreadForReview[];
  // The newest QUALIFYING comment across EVERY unresolved thread — including replies inside a
  // thread rooted on Limn's own finding, which the sweeper also treats as new — by an author the
  // `countsAuthor` filter keeps (a person or a review bot). null = none.
  newestCommentAt: Date | null;
  // The same, inside UNRESOLVED threads rooted on Limn's OWN posted findings only — a reply there
  // needs a full review (finding replies, pushback); the auto sweeper routes on it. null = none.
  newestOwnThreadCommentAt: Date | null;
}

/**
 * Every review thread on the PR — resolved or not — that is NOT rooted on one of Limn's own posted
 * findings, with its comments. ⚠ `newestCommentAt` still counts UNRESOLVED threads only: it is the
 * auto re-review trigger, and a reply on a resolved thread must not start a full review (the auto
 * Check threads pass covers it). Account-scoped (a foreign PR reads as no threads). `authorIsBot` is the GLOBAL
 * automation set (`globalAutomationUserIds`) — the ball rule's set, which needs no workspace.
 */
export async function loadReviewThreadsForReview(
  accountId: number,
  prId: number,
  // TRAILING: which authors move `newestCommentAt` (never which threads are sent). Absent ⇒ all.
  countsAuthor?: CountsAuthor,
): Promise<ReviewThreadsForReview> {
  const { reviewComments: rc, reviewThreads: rt, pullRequests: prs, repos, users, commits } = schema;
  const pr = (
    await db
      .select({ number: prs.number, owner: repos.owner, name: repos.name })
      .from(prs)
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!pr) return { threads: [], newestCommentAt: null, newestOwnThreadCommentAt: null };

  const rows = await db
    .select({
      threadId: rt.id,
      path: rt.path,
      line: rt.line,
      isOutdated: rt.isOutdated,
      derivedState: rt.derivedState,
      isResolved: rt.isResolved,
      commentId: rc.id,
      body: rc.body,
      excerpt: rc.excerpt,
      databaseId: rc.databaseId,
      createdAt: rc.createdAt,
      authorId: rc.authorId,
      authorLogin: users.githubLogin,
    })
    .from(rt)
    .innerJoin(rc, eq(rc.threadId, rt.id))
    .leftJoin(users, eq(users.id, rc.authorId))
    .where(eq(rt.prId, prId))
    .execute();
  if (rows.length === 0) return { threads: [], newestCommentAt: null, newestOwnThreadCommentAt: null };

  const [ownMap, bots, commitRows, login] = await Promise.all([
    ownPostedCommentsForPrs(accountId, [prId]),
    globalAutomationUserIds(),
    db.select({ committedAt: commits.committedAt }).from(commits).where(eq(commits.prId, prId)).execute(),
    accountGithubLogin(accountId),
  ]);
  const own = ownMap.get(prId);
  const commitTimes = commitRows.map((c) => c.committedAt.getTime());
  const after = (t: Date): number => commitTimes.filter((c) => c > t.getTime()).length;

  const byThread = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byThread.get(r.threadId) ?? [];
    list.push(r);
    byThread.set(r.threadId, list);
  }

  let newest: Date | null = null;
  let newestOwn: Date | null = null;
  const threads: ReviewThreadForReview[] = [];
  for (const list of byThread.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.commentId - b.commentId);
    const root = list[0]!;
    const rootIsOwn = isLimnPostedComment(root, own, login);
    const kept = list.filter((c) => !isLimnPostedComment(c, own, login));
    for (const c of kept) {
      if (root.isResolved) continue;
      if (countsAuthor && !countsAuthor(c.authorId ?? null)) continue;
      if (!newest || c.createdAt > newest) newest = c.createdAt;
      if (rootIsOwn && (!newestOwn || c.createdAt > newestOwn)) newestOwn = c.createdAt;
    }
    // A thread rooted on Limn's own posted finding belongs to the follow-up, not here.
    if (rootIsOwn || kept.length === 0) continue;
    const first = kept[0]!;
    const last = kept[kept.length - 1]!;
    threads.push({
      threadId: root.threadId,
      path: root.path,
      line: root.line,
      isOutdated: root.isOutdated,
      derivedState: root.derivedState,
      isResolved: root.isResolved === true,
      url: root.databaseId
        ? `https://github.com/${pr.owner}/${pr.name}/pull/${pr.number}#discussion_r${root.databaseId}`
        : null,
      comments: kept.map((c) => ({
        authorLogin: c.authorLogin ?? null,
        authorIsBot: c.authorId != null && bots.has(c.authorId),
        createdAt: c.createdAt,
        body: (c.body ?? c.excerpt ?? '').trim(),
      })),
      commitsAfterFirstComment: after(first.createdAt),
      commitsAfterLastComment: after(last.createdAt),
    });
  }
  threads.sort((a, b) => a.threadId - b.threadId);
  return { threads, newestCommentAt: newest, newestOwnThreadCommentAt: newestOwn };
}
