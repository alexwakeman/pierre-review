// TEAMMATES' POSTED REVIEWS — THE IMPORT (docs/CLAUDE-REVIEW.md § Teammates' reviews). The read side
// (listing, the own-runs filter, the follow-up anchor) is db/teammate-reviews.ts, which opens no
// database at import.
//
// The reader and a teammate both run Limn on the same repos. When the TEAMMATE'S Limn posts a review
// to GitHub — a review whose body ends in the hidden summary marker (shared `parseLimnReviewMarker`),
// plus that teammate's Limn finding comments — the reader's Limn imports it as a READ-ONLY run:
//
//   claude_reviews          kind 'teammate', status 'succeeded', trigger 'manual' (never 'auto': it
//                           is nobody's auto run here), cost/tokens NULL, posted_review_id NULL
//                           (the provenance readers key on it and this is not the reader's post),
//                           posted_at = when GitHub got it, source_user_id = the teammate,
//                           source_review_node_id = the GitHub review (the import's key),
//                           teammate = what the marker said (TeammateReviewRecord).
//   claude_review_findings  one per finding comment, keyed on the comment's node id, included false,
//                           posted_at / github_comment_id / posted_comment_kind from the comment.
//
// ONLY WHAT REACHED GITHUB: a review a teammate kept in their own Limn is never seen. The reader's own
// posts are never imported (the TRUE poster is compared with the account's own login). A replies-pass
// outcome (`k=replies`) is not a review and is skipped.
//
// ⚠ EVERY READER THAT MEANS "THE READER'S OWN RUNS" EXCLUDES THESE ROWS — `kind IS NULL` already
// does; a reader with no kind filter uses `ownRunsOnly` below. The full list of decisions is in
// docs/CLAUDE-REVIEW.md § Teammates' reviews.
//
// WHICH COMMENTS BELONG TO WHICH REVIEW. A synced comment does not record its GitHub review, so a
// finding comment is given to the teammate's Limn review submitted at or just before it (GitHub
// stamps a review's inline comments with the review's own time; PR-level comments follow within
// seconds). A finding that teammate posted later on its own joins their latest review before it.
//
// THE HEAD. The marker's `h=`; on a legacy post (no metadata) the PR's newest synced commit at the
// post time, flagged `headInferred`.
//
// DB-only. Idempotent: a second run over the same rows writes the same values.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  isLimnBotLogin,
  limnFindingPost,
  parseLimnReviewMarker,
  parsePostedLimnFinding,
  stripLimnReviewMarker,
  type AiProviderId,
  type ClaudeReviewVerdict,
  type TeammateReviewRecord,
} from '@pierre-review/shared';
import { db, runTransaction, schema } from './client.js';
import { TEAMMATE_KIND } from './teammate-reviews.js';

const { accounts, users, reviews, reviewComments, reviewThreads, prComments, commits, pullRequests } = schema;
const cr = schema.claudeReviews;
const crf = schema.claudeReviewFindings;

// A comment is given to a review submitted no later than this after it (clock jitter between a
// review and its inline comments).
const GRACE_MS = 60_000;

const STATE_VERDICT: Record<string, ClaudeReviewVerdict> = {
  approved: 'APPROVE',
  changes_requested: 'REQUEST_CHANGES',
  commented: 'COMMENT',
};

/** A pair's finding comments → who raised each, from the lead's tag ("Codex", "Claude + Codex"). */
function pairProviders(parsed: ReadonlyArray<{ c: { nodeId: string }; p: { tag: string | null } }>): Pick<TeammateReviewRecord, 'findingProviders'> {
  const out: Record<string, AiProviderId[]> = {};
  for (const { c, p } of parsed) {
    const t = (p.tag ?? '').toLowerCase();
    const who: AiProviderId[] = [];
    if (/\bclaude\b/.test(t)) who.push('claude');
    if (/\bcodex\b/.test(t)) who.push('codex');
    if (who.length > 0) out[c.nodeId] = who;
  }
  return Object.keys(out).length > 0 ? { findingProviders: out } : {};
}

export interface TeammateImportResult {
  reviews: number;
  findings: number;
  removedFindings: number;
}

interface FindingCandidate {
  nodeId: string;
  databaseId: string | null;
  posterId: number;
  createdAt: Date;
  body: string;
  kind: 'inline' | 'pr_comment';
  path: string | null;
  line: number | null;
}

/**
 * Import every review a teammate's Limn posted on this PR (see the header). Returns what it wrote.
 * Safe to call after every walk of the PR; one transaction.
 */
export async function importTeammateReviews(accountId: number, prId: number): Promise<TeammateImportResult> {
  const none: TeammateImportResult = { reviews: 0, findings: 0, removedFindings: 0 };
  const pr = (
    await db
      .select({ id: pullRequests.id, headSha: pullRequests.headSha })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, prId), eq(pullRequests.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!pr) return none;
  const readerLogin = (
    await db.select({ login: accounts.githubLogin }).from(accounts).where(eq(accounts.id, accountId)).limit(1).execute()
  )[0]?.login?.toLowerCase();
  if (!readerLogin) return none;

  // Limn review summaries on this PR, by anyone but the reader.
  const posted = (
    await db
      .select({
        nodeId: reviews.githubNodeId,
        databaseId: reviews.databaseId,
        authorId: reviews.authorId,
        login: users.githubLogin,
        state: reviews.state,
        body: reviews.body,
        submittedAt: reviews.submittedAt,
      })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.authorId))
      .where(and(eq(reviews.prId, prId), sql`${reviews.body} like '%pierre:claude-review%'`))
      .orderBy(asc(reviews.submittedAt), asc(reviews.id))
      .execute()
  )
    .map((r) => ({ ...r, meta: parseLimnReviewMarker(r.body) }))
    .filter(
      (r) =>
        r.meta != null &&
        r.meta.run !== 'replies' &&
        r.state !== 'pending' &&
        r.authorId != null &&
        !isLimnBotLogin(r.login) &&
        r.login.toLowerCase() !== readerLogin,
    );
  if (posted.length === 0) return none;
  const posterIds = [...new Set(posted.map((r) => r.authorId as number))];

  // Those posters' Limn FINDING comments on this PR (sync re-attributed them to their bot and kept
  // the poster in `limn_posted_by_user_id`). Inline: thread roots only.
  const inline = (await db
    .select({
      nodeId: reviewComments.githubNodeId,
      databaseId: reviewComments.databaseId,
      posterId: reviewComments.limnPostedByUserId,
      createdAt: reviewComments.createdAt,
      body: reviewComments.body,
      path: reviewThreads.path,
      line: reviewThreads.line,
      isRoot: sql<number>`not exists (select 1 from review_comments rc2 where rc2.thread_id = ${reviewComments.threadId} and (rc2.created_at < ${reviewComments.createdAt} or (rc2.created_at = ${reviewComments.createdAt} and rc2.id < ${reviewComments.id})))`,
    })
    .from(reviewComments)
    .innerJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
    .where(and(eq(reviewComments.prId, prId), inArray(reviewComments.limnPostedByUserId, posterIds)))
    .execute()) as Array<{
    nodeId: string;
    databaseId: string | null;
    posterId: number;
    createdAt: Date;
    body: string | null;
    path: string;
    line: number | null;
    isRoot: number;
  }>;
  const prLevel = (await db
    .select({
      nodeId: prComments.githubNodeId,
      databaseId: prComments.databaseId,
      posterId: prComments.limnPostedByUserId,
      createdAt: prComments.createdAt,
      body: prComments.body,
    })
    .from(prComments)
    .where(and(eq(prComments.prId, prId), inArray(prComments.limnPostedByUserId, posterIds)))
    .execute()) as Array<{ nodeId: string; databaseId: string | null; posterId: number; createdAt: Date; body: string | null }>;

  const candidates: FindingCandidate[] = [];
  for (const c of inline) {
    if (!c.isRoot) continue;
    const post = limnFindingPost(c.body, { threadRoot: true });
    if (post == null || post.reminder) continue;
    candidates.push({ ...c, body: c.body ?? '', kind: 'inline' });
  }
  for (const c of prLevel) {
    const post = limnFindingPost(c.body);
    if (post == null || post.reminder) continue;
    candidates.push({ ...c, body: c.body ?? '', kind: 'pr_comment', path: null, line: null });
  }

  // Each comment → the poster's review submitted at or just before it.
  const byPoster = new Map<number, typeof posted>();
  for (const r of posted) {
    const list = byPoster.get(r.authorId as number) ?? [];
    list.push(r);
    byPoster.set(r.authorId as number, list);
  }
  const findingsOf = new Map<string, FindingCandidate[]>();
  for (const c of candidates) {
    const list = byPoster.get(c.posterId) ?? [];
    let owner: (typeof posted)[number] | null = null;
    for (const r of list) if (r.submittedAt.getTime() <= c.createdAt.getTime() + GRACE_MS) owner = r;
    if (owner == null) continue;
    const got = findingsOf.get(owner.nodeId) ?? [];
    got.push(c);
    findingsOf.set(owner.nodeId, got);
  }

  // A legacy post's head: the newest synced commit at or before it.
  const prCommits = await db
    .select({ sha: commits.sha, committedAt: commits.committedAt })
    .from(commits)
    .where(eq(commits.prId, prId))
    .orderBy(desc(commits.committedAt))
    .execute();
  const inferHead = (at: Date): string | null =>
    prCommits.find((c) => c.committedAt.getTime() <= at.getTime())?.sha ?? pr.headSha ?? null;

  return runTransaction(async (tx) => {
    const out: TeammateImportResult = { reviews: 0, findings: 0, removedFindings: 0 };
    for (const r of posted) {
      const meta = r.meta!;
      const head = meta.headSha ?? inferHead(r.submittedAt);
      if (head == null) continue;
      const found = (findingsOf.get(r.nodeId) ?? []).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.nodeId.localeCompare(b.nodeId),
      );
      const summary = stripLimnReviewMarker(r.body);
      // A legacy post with no text and no finding is nothing to show (an old replies-pass outcome).
      if (meta.legacy && summary === '' && found.length === 0) continue;
      const parsed = found.map((f) => ({ c: f, p: parsePostedLimnFinding(f.body) }));
      const record: TeammateReviewRecord = {
        githubReviewId: r.databaseId ?? null,
        run: meta.run === 'auto' || meta.run === 'manual' ? meta.run : null,
        pair: meta.pair,
        runs: meta.runs,
        limnVersion: meta.limnVersion,
        headInferred: meta.headSha == null,
        ...(parsed.some((x) => x.p.severity == null)
          ? { unlabelled: parsed.filter((x) => x.p.severity == null).map((x) => x.c.nodeId) }
          : {}),
        ...(meta.judged != null && meta.judged.length > 0 ? { judged: meta.judged } : {}),
        ...(meta.liftConsent === true ? { liftConsent: true } : {}),
        ...(meta.pair ? pairProviders(parsed) : {}),
      };
      const first = meta.runs[0];
      const values = {
        headSha: head,
        status: 'succeeded' as const,
        model: first?.model ?? '',
        provider: first?.provider ?? null,
        effort: first?.effort ?? null,
        summary,
        verdict: meta.verdict ?? STATE_VERDICT[r.state] ?? null,
        postedAt: r.submittedAt,
        finishedAt: r.submittedAt,
        sourceUserId: r.authorId,
        teammate: record,
      };
      const existing = (
        await tx
          .select({ id: cr.id })
          .from(cr)
          .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), eq(cr.sourceReviewNodeId, r.nodeId)))
          .limit(1)
          .execute()
      )[0];
      let reviewId: number;
      if (existing) {
        reviewId = existing.id;
        await tx.update(cr).set(values).where(eq(cr.id, reviewId)).execute();
      } else {
        reviewId = (
          await tx
            .insert(cr)
            .values({
              ...values,
              accountId,
              prId,
              kind: TEAMMATE_KIND,
              trigger: 'manual',
              sourceReviewNodeId: r.nodeId,
              createdAt: r.submittedAt,
            })
            .returning({ id: cr.id })
            .execute()
        )[0]!.id;
      }
      out.reviews += 1;

      const have = await tx
        .select({ id: crf.id, nodeId: crf.sourceCommentNodeId })
        .from(crf)
        .where(eq(crf.reviewId, reviewId))
        .execute();
      const haveByNode = new Map(have.map((h) => [h.nodeId, h.id]));
      const keep = new Set<number>();
      for (const { c, p } of parsed) {
        const fields = {
          path: c.kind === 'inline' ? (c.path ?? '') : (p.refPath ?? ''),
          line: c.kind === 'inline' ? c.line : p.refLine,
          side: 'RIGHT' as const,
          // The severity column is NOT NULL: an unlabelled finding stores 'warning', named in
          // `teammate.unlabelled` and read back as null.
          severity: p.severity ?? ('warning' as const),
          title: p.title || '(no text)',
          body: p.body,
          anchored: c.kind === 'inline',
          fileInDiff: c.kind === 'inline',
          included: false,
          postedAt: c.createdAt,
          githubCommentId: c.databaseId,
          postedCommentKind: c.kind,
        };
        const id = haveByNode.get(c.nodeId);
        if (id != null) {
          keep.add(id);
          await tx.update(crf).set(fields).where(eq(crf.id, id)).execute();
        } else {
          const ins = await tx
            .insert(crf)
            .values({ ...fields, reviewId, sourceCommentNodeId: c.nodeId, createdAt: c.createdAt })
            .returning({ id: crf.id })
            .execute();
          keep.add(ins[0]!.id);
        }
        out.findings += 1;
      }
      // A comment no longer there (deleted on GitHub, or now another review's) leaves the review.
      const gone = have.filter((h) => !keep.has(h.id)).map((h) => h.id);
      if (gone.length > 0) {
        await tx.delete(schema.claudeReviewChatMessages).where(inArray(schema.claudeReviewChatMessages.findingId, gone)).execute();
        await tx.delete(crf).where(inArray(crf.id, gone)).execute();
        out.removedFindings += gone.length;
      }
    }
    return out;
  });
}

