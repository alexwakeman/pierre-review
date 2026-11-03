// TEAMMATES' POSTED REVIEWS — THE READ SIDE (docs/CLAUDE-REVIEW.md § Teammates' reviews). The import
// is db/teammate-reviews-import.ts. ⚠ This module opens NO database at import (every reader takes an
// executor): review modules and their fake-context tests import it.
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { ClaudeTeammateFinding, ClaudeTeammateReview, TeammateReviewRecord } from '@pierre-review/shared';
import type { Executor } from './client.js';
import * as schema from './schema.sqlite.js';

const { users, reviewComments, commits, pullRequests, repos } = schema;
const cr = schema.claudeReviews;
const crf = schema.claudeReviewFindings;

// Limn's "_Posted automatically by Limn’s … review(s)._" footer closes an auto-posted summary on
// GitHub. In the app it is noise: the review is already labelled as the teammate's.
const AUTO_POST_FOOTER_RE = /\n*_Posted automatically by Limn[’'][^_\n]*_\s*$/;

/** A posted review summary without Limn's auto-post footer. Pure. */
export function withoutAutoPostFooter(summary: string): string {
  return summary.replace(AUTO_POST_FOOTER_RE, '').trimEnd();
}

/** The `claude_reviews.kind` of an imported teammate review. */
export const TEAMMATE_KIND = 'teammate' as const;

/**
 * THE OWN-RUNS FILTER for a `claude_reviews` reader with no `kind IS NULL` filter (one that also
 * wants replies passes): every row but a teammate's imported review. NULL-safe.
 */
export function ownRunsOnly(kind: AnySQLiteColumn): SQL {
  return sql`coalesce(${kind}, '') <> ${TEAMMATE_KIND}`;
}

/** The same rule for a `claude_review_findings` reader: its run is not a teammate's review. */
export function ownFindingsOnly(reviewId: AnySQLiteColumn): SQL {
  return sql`${reviewId} not in (select id from claude_reviews where kind = ${TEAMMATE_KIND})`;
}

/** Every teammate review imported on this PR, newest first, for the AI Review tab. Account-scoped. */
export async function listTeammateReviews(
  exec: Executor,
  accountId: number,
  prId: number,
): Promise<ClaudeTeammateReview[]> {
  const rows = await exec
    .select({
      id: cr.id,
      headSha: cr.headSha,
      summary: cr.summary,
      verdict: cr.verdict,
      postedAt: cr.postedAt,
      createdAt: cr.createdAt,
      teammate: cr.teammate,
      userId: users.id,
      login: users.githubLogin,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
    })
    .from(cr)
    .innerJoin(pullRequests, eq(pullRequests.id, cr.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .innerJoin(users, eq(users.id, cr.sourceUserId))
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(repos.accountId, accountId), eq(cr.kind, TEAMMATE_KIND)))
    .orderBy(desc(cr.postedAt), desc(cr.id))
    .execute();
  if (rows.length === 0) return [];
  const findings = await exec
    .select({
      id: crf.id,
      reviewId: crf.reviewId,
      path: crf.path,
      line: crf.line,
      severity: crf.severity,
      title: crf.title,
      body: crf.body,
      kind: crf.postedCommentKind,
      githubCommentId: crf.githubCommentId,
      nodeId: crf.sourceCommentNodeId,
    })
    .from(crf)
    .where(inArray(crf.reviewId, rows.map((r) => r.id)))
    .orderBy(asc(crf.id))
    .execute();
  const nodeIds = findings.map((f) => f.nodeId).filter((n): n is string => n != null);
  const threadOf = new Map<string, number>();
  if (nodeIds.length > 0) {
    for (const t of await exec
      .select({ nodeId: reviewComments.githubNodeId, threadId: reviewComments.threadId })
      .from(reviewComments)
      .where(and(eq(reviewComments.prId, prId), inArray(reviewComments.githubNodeId, nodeIds)))
      .execute())
      threadOf.set(t.nodeId, t.threadId);
  }
  return rows.map((r) => {
    const rec = (r.teammate ?? null) as TeammateReviewRecord | null;
    const unlabelled = new Set(rec?.unlabelled ?? []);
    const prUrl = `https://github.com/${r.owner}/${r.name}/pull/${r.number}`;
    const mine: ClaudeTeammateFinding[] = findings
      .filter((f) => f.reviewId === r.id)
      .map((f) => {
        const kind = f.kind === 'pr_comment' ? 'pr_comment' : 'inline';
        return {
          id: f.id,
          path: f.path,
          line: f.line,
          severity:
            (f.nodeId != null && unlabelled.has(f.nodeId)) || f.severity === 'praise' ? null : f.severity,
          title: f.title,
          body: f.body,
          kind,
          githubUrl:
            f.githubCommentId == null
              ? null
              : kind === 'inline'
                ? `${prUrl}#discussion_r${f.githubCommentId}`
                : `${prUrl}#issuecomment-${f.githubCommentId}`,
          threadId: kind === 'inline' && f.nodeId != null ? (threadOf.get(f.nodeId) ?? null) : null,
        };
      });
    const at = r.postedAt ?? r.createdAt;
    return {
      reviewId: r.id,
      poster: { userId: r.userId, login: r.login, displayName: r.displayName, avatarUrl: r.avatarUrl },
      headSha: r.headSha,
      headInferred: rec?.headInferred ?? true,
      postedAt: at.toISOString(),
      githubUrl: rec?.githubReviewId ? `${prUrl}#pullrequestreview-${rec.githubReviewId}` : null,
      summary: withoutAutoPostFooter(r.summary ?? ''),
      verdict: r.verdict,
      run: rec?.run ?? null,
      pair: rec?.pair ?? false,
      runs: rec?.runs ?? [],
      limnVersion: rec?.limnVersion ?? null,
      findings: mine,
    };
  });
}

/** A PR's NEWEST teammate review, as the Open PRs column / Pending cards name it. */
export interface NewestTeammateReview {
  reviewId: number;
  poster: ClaudeTeammateReview['poster'];
  verdict: ClaudeTeammateReview['verdict'];
  headSha: string;
  // When it was posted (else imported) — the same time `listTeammateReviews` reads.
  postedAt: Date;
  // The PR's synced head (a PR fact, read in the same query); null = not synced.
  prHeadSha: string | null;
}

/**
 * The NEWEST teammate review of each listed PR, in ONE query for the whole batch (never one per PR):
 * newest by posted time (else import time), ties to the higher id — the review `foldTeamReview`
 * calls `newest`. Account-scoped; a PR with none is absent. DB only.
 */
export async function newestTeammateReviewsForPrs(
  exec: Executor,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, NewestTeammateReview>> {
  const out = new Map<number, NewestTeammateReview>();
  if (prIds.length === 0) return out;
  const rows = await exec
    .select({
      id: cr.id,
      prId: cr.prId,
      headSha: cr.headSha,
      verdict: cr.verdict,
      postedAt: cr.postedAt,
      createdAt: cr.createdAt,
      userId: users.id,
      login: users.githubLogin,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      prHeadSha: pullRequests.headSha,
    })
    .from(cr)
    .innerJoin(pullRequests, eq(pullRequests.id, cr.prId))
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .innerJoin(users, eq(users.id, cr.sourceUserId))
    .where(
      and(inArray(cr.prId, [...prIds]), eq(cr.accountId, accountId), eq(repos.accountId, accountId), eq(cr.kind, TEAMMATE_KIND)),
    )
    .execute();
  for (const r of rows) {
    const at = r.postedAt ?? r.createdAt;
    const cur = out.get(r.prId);
    if (cur != null && (cur.postedAt.getTime() > at.getTime() || (cur.postedAt.getTime() === at.getTime() && cur.reviewId > r.id)))
      continue;
    out.set(r.prId, {
      reviewId: r.id,
      poster: { userId: r.userId, login: r.login, displayName: r.displayName, avatarUrl: r.avatarUrl },
      verdict: r.verdict,
      headSha: r.headSha,
      postedAt: at,
      prHeadSha: r.prHeadSha ?? null,
    });
  }
  return out;
}

/** Where the follow-up chain can anchor: the reader's own full review, or a teammate's posted one. */
export interface FollowUpAnchor {
  reviewId: number;
  origin: 'own' | 'teammate';
  headSha: string;
  // The teammate who posted it (origin 'teammate'); null for the reader's own run.
  sourceUserId: number | null;
}

/**
 * THE LATEST FULL REVIEW AT OR BEFORE `headSha`, THE READER'S OWN OR A TEAMMATE'S POSTED ONE — what a
 * follow-up may anchor on when a teammate's review counts (task A2: the PR author reviewed their own
 * PR). "At or before": the review read `headSha` itself, or a commit of this PR committed no later
 * than `headSha` (by the synced commit times; an unknown head ⇒ any review). A succeeded run that read
 * code (`review_mode` not 'skip'), a replies pass never. `beforeReviewId` keeps it to rows older than
 * a run in progress. Today's own-only reader stays `loadPriorReviewForFollowUp` (persist.ts).
 */
export async function latestFullReviewAtOrBefore(
  accountId: number,
  prId: number,
  headSha: string | null,
  exec: Executor,
  opts: { beforeReviewId?: number } = {},
): Promise<FollowUpAnchor | null> {
  const prCommits = await exec
    .select({ sha: commits.sha, committedAt: commits.committedAt })
    .from(commits)
    .where(eq(commits.prId, prId))
    .execute();
  const at = new Map(prCommits.map((c) => [c.sha, c.committedAt.getTime()]));
  const limit = headSha != null ? at.get(headSha) : undefined;
  const rows = await exec
    .select({ id: cr.id, headSha: cr.headSha, kind: cr.kind, sourceUserId: cr.sourceUserId })
    .from(cr)
    .where(
      and(
        eq(cr.prId, prId),
        eq(cr.accountId, accountId),
        eq(cr.status, 'succeeded'),
        or(isNull(cr.kind), eq(cr.kind, TEAMMATE_KIND)),
        or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
        opts.beforeReviewId != null ? sql`${cr.id} < ${opts.beforeReviewId}` : undefined,
      ),
    )
    // Newest by when the review was done (a teammate's row is inserted when it is imported).
    .orderBy(desc(sql`coalesce(${cr.postedAt}, ${cr.finishedAt}, ${cr.createdAt})`), desc(cr.id))
    .execute();
  for (const r of rows) {
    if (headSha != null && r.headSha !== headSha && limit != null) {
      const t = at.get(r.headSha);
      if (t == null || t > limit) continue;
    }
    return {
      reviewId: r.id,
      origin: r.kind === TEAMMATE_KIND ? 'teammate' : 'own',
      headSha: r.headSha,
      sourceUserId: r.sourceUserId ?? null,
    };
  }
  return null;
}
