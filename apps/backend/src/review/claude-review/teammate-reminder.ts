// A REMINDER OF A TEAMMATE'S FINDING (docs/CLAUDE-REVIEW.md § Teammates' reviews → A reminder of a
// teammate's finding). "Post reminder" on a teammate's open point posts the point again AS THE READER:
// a new comment of the reader's own Limn (the finding marker, so `isLimnPostedComment` holds), led by
// the same reminder line as the reader's own reminders (`reminderLead`), linking the teammate's
// original comment. It never edits, replies to or resolves the teammate's comment or thread.
//
// ⚠ ONE RULE decides what may be reminded: `teamPointRemindable` (team-view.ts) on the SAME fold the
// tab shows (`loadTeamReviewView`) — a teammate's point, still OPEN, with its comment on GitHub. A
// foreign, unknown, closed or own finding answers not_found / conflict and nothing is written.
// ⚠ Recorded like the reader's own reminder (`markFindingReminder` on the teammate's finding row:
// display + dedupe only — posted-state.ts counts its comment as claimed). The import never touches
// the column, so it survives every later walk.
import { and, eq } from 'drizzle-orm';
import { splitTrailingSuggestion } from '@pierre-review/shared';
import type { ClaudeFindingSeverity, PostCommentResult } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { TEAMMATE_KIND, listTeammateReviews } from '../../db/teammate-reviews.js';
import { getLatestClaudeReview, markFindingReminder } from './persist.js';
import { findingCommentUrl, reminderLead } from './posted-state.js';
import { loadTeamReviewView, teammatePointRemindable } from './team-view.js';
import { tabThreadView } from './thread-judgements.js';

export type TeammateReminderOutcome =
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: 'NotOpen' | 'NotOnGithub' | 'HeadMoved'; message: string }
  | { kind: 'github_error'; message: string }
  | { kind: 'posted'; result: PostCommentResult };

/** Is this finding id a TEAMMATE's imported finding of this account? (null = no: the caller 404s.) */
export async function teammateFindingPr(
  ctx: AgentContext,
  accountId: number,
  findingId: number,
): Promise<{ prId: number } | null> {
  const { claudeReviews: cr, claudeReviewFindings: crf } = ctx.schema as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const row = (
    (await ctx.db
      .select({ prId: cr.prId })
      .from(crf)
      .innerJoin(cr, eq(cr.id, crf.reviewId))
      .where(and(eq(crf.id, findingId), eq(cr.accountId, accountId), eq(cr.kind, TEAMMATE_KIND)))
      .limit(1)
      .execute()) as Array<{ prId: number }>
  )[0];
  return row ?? null;
}

/**
 * Post a reminder of a teammate's finding as the reader. DB reads first (the fold), then ONE GitHub
 * write through the same seam the reader's own reminders use (`ctx.review.postFinding`).
 */
export async function postTeammateReminder(
  ctx: AgentContext,
  accountId: number,
  findingId: number,
): Promise<TeammateReminderOutcome> {
  const owner = await teammateFindingPr(ctx, accountId, findingId);
  if (owner == null) return { kind: 'not_found' };
  const prId = owner.prId;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { claudeReviewFindings: crf, reviewComments: rc, reviewThreads: rt, pullRequests: prs, repos } = ctx.schema as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // THE SAME FOLD THE TAB SHOWS: the point must be this teammate finding's, and still open.
  const [latest, threads, mates] = await Promise.all([
    getLatestClaudeReview(ctx, prId, accountId),
    tabThreadView(ctx, accountId, prId),
    listTeammateReviews(ctx.db, accountId, prId),
  ]);
  const view = await loadTeamReviewView(ctx.db, accountId, prId, latest, mates, threads.team);
  const point = (view.allFindings ?? []).find((p) => p.findingId === findingId);
  if (point == null) {
    // Folded under another entry (the reader's own re-raise, or another teammate's): that entry's
    // card carries the action, never this one.
    return { kind: 'conflict', code: 'NotOpen', message: 'This point is shown under another finding. Post the reminder from there.' };
  }
  if (point.githubCommentId == null) {
    return { kind: 'conflict', code: 'NotOnGithub', message: 'The original comment is not synced yet. Try again in a moment.' };
  }
  if (!teammatePointRemindable(point)) {
    return { kind: 'conflict', code: 'NotOpen', message: 'This point is resolved or addressed.' };
  }

  // What to post: the teammate's stored text (lead, notes and marker already stripped at import).
  const f = (
    (await ctx.db
      .select({ path: crf.path, line: crf.line, side: crf.side, body: crf.body, nodeId: crf.sourceCommentNodeId, kind: crf.postedCommentKind, postedAt: crf.postedAt })
      .from(crf)
      .where(eq(crf.id, findingId))
      .limit(1)
      .execute()) as Array<{ path: string; line: number | null; side: 'LEFT' | 'RIGHT'; body: string; nodeId: string | null; kind: 'inline' | 'pr_comment' | null; postedAt: Date | null }>
  )[0];
  const pr = (
    (await ctx.db
      .select({ owner: repos.owner, name: repos.name, number: prs.number, headSha: prs.headSha })
      .from(prs)
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(and(eq(prs.id, prId), eq(repos.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ owner: string; name: string; number: number; headSha: string | null }>
  )[0];
  if (f == null || pr == null) return { kind: 'not_found' };
  if (pr.headSha == null) {
    return { kind: 'conflict', code: 'HeadMoved', message: 'The PR is not synced yet. Try again in a moment.' };
  }

  // WHERE: inline on the line the teammate's thread sits on NOW (GitHub's current line at the synced
  // head), else a PR-level comment naming the file. The teammate's review head may be older than the
  // PR's: their line is not reused unless GitHub still shows the thread on the current diff.
  const thread =
    f.kind === 'inline' && f.nodeId != null
      ? (
          (await ctx.db
            .select({ line: rt.line, isOutdated: rt.isOutdated })
            .from(rc)
            .innerJoin(rt, eq(rt.id, rc.threadId))
            .where(and(eq(rc.prId, prId), eq(rc.githubNodeId, f.nodeId)))
            .limit(1)
            .execute()) as Array<{ line: number | null; isOutdated: boolean }>
        )[0] ?? null
      : null;
  const inlineLine = thread != null && !thread.isOutdated && thread.line != null ? thread.line : null;
  const { text, suggestion } = splitTrailingSuggestion(f.body);
  const lead = reminderLead({
    url: findingCommentUrl({ owner: pr.owner, name: pr.name, prNumber: pr.number }, {
      githubCommentId: point.githubCommentId,
      postedCommentKind: point.postedCommentKind ?? (f.kind === 'pr_comment' ? 'pr_comment' : 'inline'),
    }),
    postedAt: point.postedAt ?? (f.postedAt != null ? f.postedAt.toISOString() : null),
  });
  const severity: ClaudeFindingSeverity | null = point.severity;
  try {
    const outcome = await ctx.review.postFinding({
      owner: pr.owner,
      name: pr.name,
      prNumber: pr.number,
      // The reader pressed "Remind": Limn's words, on their behalf.
      limn: { accountId, prId, origin: 'reader_pressed' },
      // The synced head: the seam refuses when the live head moved past it (`headMoved`).
      reviewHeadSha: pr.headSha,
      finding: {
        id: findingId,
        path: f.path,
        line: inlineLine ?? f.line,
        side: f.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        anchored: inlineLine != null,
        fileInDiff: inlineLine != null,
        body: text,
        suggestion,
        severity,
        storyLead: lead,
      },
      ...(inlineLine == null ? { prLevel: true } : {}),
    });
    if (outcome.headMoved) {
      return { kind: 'conflict', code: 'HeadMoved', message: 'The PR has new commits that are not synced yet. Try again in a moment.' };
    }
    const r = await markFindingReminder(ctx, findingId, outcome.commentId, outcome.postedCommentKind);
    return { kind: 'posted', result: { githubCommentId: outcome.commentId, postedAt: r.postedAt, reminder: true } };
  } catch (err) {
    return { kind: 'github_error', message: err instanceof Error ? err.message : String(err) };
  }
}
