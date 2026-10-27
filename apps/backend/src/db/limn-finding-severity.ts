// THE SEVERITY CHIP ON LIMN'S OWN POSTED FINDINGS — which review thread / PR-level comment of a PR
// is a finding Limn posted, and the severity it was posted with. Read inside getPrDetail (the
// payload the PR details pane already loads), so the chip costs no request of its own.
//
// The link is the thread-owner link the rest of Claude Review uses:
//   - a finding's stored `github_comment_id` is the ROOT comment of the thread it started
//     (`posted_comment_kind = 'inline'`) or the PR-level comment it became ('pr_comment');
//   - its latest REMINDER's comment is the same finding, posted again;
//   - an inline-posted finding with no stored id (its review read-back failed) is matched by the ONE
//     shared matcher, `findFindingThread` (same file, the account's own login, the hidden marker,
//     the finding's text at the start).
// The severity goes through the shared grader seam `severityForPostedFinding`, the same call the
// comment builders make, so the chip always says what GitHub says. Praise is never posted: no chip.
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  severityForPostedFinding,
  type ClaudeFindingReminder,
  type ClaudeFindingSeverity,
  type LimnSeverity,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { findFindingThread, type ThreadComment } from '../review/claude-review/finding-thread.js';
import { accountGithubLogin } from './review-threads-for-review.js';

/** One POSTED finding of the PR, as this fold reads it. */
export interface PostedFindingSeverityRow {
  id: number;
  severity: ClaudeFindingSeverity;
  path: string;
  line: number | null;
  body: string;
  editedBody: string | null;
  githubCommentId: string | null;
  postedCommentKind: 'inline' | 'pr_comment' | null;
  reminder: ClaudeFindingReminder | null;
}

export interface LimnSeverityTargets {
  /** review_threads.id → severity */
  byThreadId: Map<number, LimnSeverity>;
  /** pr_comments.id → severity */
  byPrCommentId: Map<number, LimnSeverity>;
}

/** The pure fold (see the header). `threadComments` are every comment of the PR's threads. */
export function limnSeverityTargets(input: {
  findings: readonly PostedFindingSeverityRow[];
  threads: ReadonlyArray<{ id: number; path: string; line?: number | null }>;
  threadComments: readonly ThreadComment[];
  prComments: ReadonlyArray<{ id: number; databaseId: string | null }>;
  accountLogin: string | null;
}): LimnSeverityTargets {
  const byThreadId = new Map<number, LimnSeverity>();
  const byPrCommentId = new Map<number, LimnSeverity>();
  const inline = new Map<string, LimnSeverity>();
  const prLevel = new Map<string, LimnSeverity>();
  const unlinked: Array<{ f: PostedFindingSeverityRow; sev: LimnSeverity }> = [];
  // Oldest first, so the finding that really posted owns its thread before a later one is tried.
  for (const f of [...input.findings].sort((a, b) => a.id - b.id)) {
    const sev = severityForPostedFinding(f);
    if (sev == null) continue;
    if (f.githubCommentId != null) {
      (f.postedCommentKind === 'pr_comment' ? prLevel : inline).set(f.githubCommentId, sev);
    } else if (f.postedCommentKind !== 'pr_comment') {
      unlinked.push({ f, sev });
    }
    const r = f.reminder;
    if (r?.githubCommentId) (r.postedCommentKind === 'pr_comment' ? prLevel : inline).set(r.githubCommentId, sev);
  }
  if (inline.size + prLevel.size + unlinked.length === 0) return { byThreadId, byPrCommentId };

  // Each thread's ROOT comment (the earliest).
  const roots = new Map<number, ThreadComment>();
  for (const c of input.threadComments) {
    const r = roots.get(c.threadId);
    if (!r || c.createdAt < r.createdAt) roots.set(c.threadId, c);
  }
  for (const [threadId, root] of roots) {
    const sev = root.databaseId != null ? inline.get(root.databaseId) : undefined;
    if (sev != null) byThreadId.set(threadId, sev);
  }
  const taken = new Set<number>(byThreadId.keys());
  for (const { f, sev } of unlinked) {
    const t = findFindingThread(f, input.threads, input.threadComments, input.accountLogin, taken);
    if (t) {
      byThreadId.set(t.id, sev);
      taken.add(t.id);
    }
  }
  for (const c of input.prComments) {
    const sev = c.databaseId != null ? prLevel.get(c.databaseId) : undefined;
    if (sev != null) byPrCommentId.set(c.id, sev);
  }
  return { byThreadId, byPrCommentId };
}

/**
 * Load this PR's posted findings and fold them over the thread / comment rows getPrDetail already
 * read. One indexed query when nothing of Limn's is posted; the account login and the comment
 * authors are read only when a posted inline finding has no stored comment id.
 */
export async function loadLimnSeverityTargets(
  accountId: number,
  prId: number,
  rows: {
    threads: ReadonlyArray<{ id: number; path: string; line: number | null }>;
    threadComments: ReadonlyArray<{
      threadId: number;
      databaseId: string | null;
      body: string | null;
      authorId: number | null;
      createdAt: Date;
    }>;
    prComments: ReadonlyArray<{ id: number; databaseId: string | null }>;
  },
): Promise<LimnSeverityTargets> {
  const { claudeReviews: cr, claudeReviewFindings: crf } = schema;
  const findings = (await db
    .select({
      id: crf.id,
      severity: crf.severity,
      path: crf.path,
      line: crf.line,
      body: crf.body,
      editedBody: crf.editedBody,
      githubCommentId: crf.githubCommentId,
      postedCommentKind: crf.postedCommentKind,
      reminder: crf.reminder,
    })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), isNotNull(crf.postedAt)))
    .execute()) as PostedFindingSeverityRow[];
  if (findings.length === 0) return { byThreadId: new Map(), byPrCommentId: new Map() };

  const needsMatcher = findings.some((f) => f.githubCommentId == null && f.postedCommentKind !== 'pr_comment');
  let accountLogin: string | null = null;
  const loginById = new Map<number, string>();
  if (needsMatcher) {
    accountLogin = await accountGithubLogin(accountId);
    const authorIds = [...new Set(rows.threadComments.map((c) => c.authorId).filter((x): x is number => x != null))];
    if (authorIds.length > 0) {
      const us = await db
        .select({ id: schema.users.id, login: schema.users.githubLogin })
        .from(schema.users)
        .where(inArray(schema.users.id, authorIds))
        .execute();
      for (const u of us) if (u.login) loginById.set(u.id, u.login);
    }
  }
  return limnSeverityTargets({
    findings,
    threads: rows.threads,
    threadComments: rows.threadComments.map((c) => ({
      threadId: c.threadId,
      databaseId: c.databaseId,
      body: c.body,
      authorLogin: c.authorId != null ? (loginById.get(c.authorId) ?? null) : null,
      createdAt: c.createdAt.getTime(),
    })),
    prComments: rows.prComments,
    accountLogin,
  });
}
