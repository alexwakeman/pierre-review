// THE PR AUTHOR'S OWN REVIEW AS THE FOLLOW-UP ANCHOR (docs/CLAUDE-REVIEW.md § Follow-up on the
// previous review → The author's own review).
//
// The author cannot approve their own PR, so their Limn reviewing it never holds a head (team-claim.ts
// `decideTeamClaim`) and the reader's Limn still runs. That run FOLLOWS UP on the author's posted
// review (imported as `claude_reviews.kind = 'teammate'`, db/teammate-reviews-import.ts): its findings
// enter the follow-up exactly as a previous review's would, so the reader's Limn checks each one is
// dealt with, raises anything new, and may still approve under the workspace's auto verdict.
//
// ⚠ ONLY THE PR AUTHOR'S review, and only when it is the LATEST full review at or before this head
//   (`latestFullReviewAtOrBefore`): a newer review of the reader's own anchors the chain as before.
//   A non-author teammate's posted review holds the head (no auto run), so it never anchors.
// ⚠ NOTHING DROPS OUT OF THE CHAIN: the reader's own previous review (`loadPriorReviewForFollowUp`,
//   with its carries) is folded in as CARRIED findings.
// ⚠ A run that does not anchor here is UNCHANGED: same loader, same prompt bytes (prompt-golden.json).
// ⚠ NEVER A WRITE ON A TEAMMATE'S THREAD: auto resolve, the pushback and "Post reply" act only on the
//   reader's own findings (finding-replies.ts `loadThreadOwners` with `ownOnly`). The judgements show
//   in the reader's tab; the author's Limn resolves its own threads.
import { and, asc, eq } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';
import { TEAMMATE_KIND, latestFullReviewAtOrBefore } from '../../db/teammate-reviews.js';
import {
  isFollowUpEligible,
  resolveFindingBody,
  type PriorFindingForFollowUp,
  type PriorReviewForFollowUp,
} from './follow-up.js';

/** The anchor's poster, stored on the follow-up record (`ClaudeReviewFollowUpRecord.teammate`). */
export interface TeammateAnchorPoster {
  userId: number;
  login: string;
}

export type AuthorAnchoredPrior = PriorReviewForFollowUp & { teammate: TeammateAnchorPoster };

/**
 * THE MERGE (pure): the author's findings as the previous review's own, then the reader's own previous
 * review's findings as CARRIED (each keeps the head that raised it), once per id. Settled ids are left
 * out of both. The reader's own `leftOut` stays named.
 */
export function mergeAuthorAnchor(
  anchor: { reviewId: number; headSha: string; teammate: TeammateAnchorPoster; findings: PriorFindingForFollowUp[] },
  own: PriorReviewForFollowUp | null,
  settledIds: ReadonlySet<number> = new Set(),
): AuthorAnchoredPrior {
  const seen = new Set<number>();
  const findings: PriorFindingForFollowUp[] = [];
  for (const f of anchor.findings) {
    if (seen.has(f.id) || settledIds.has(f.id)) continue;
    seen.add(f.id);
    findings.push({ ...f, carried: false });
  }
  for (const f of own?.findings ?? []) {
    if (seen.has(f.id) || settledIds.has(f.id)) continue;
    seen.add(f.id);
    findings.push({ ...f, carried: true });
  }
  return {
    reviewId: anchor.reviewId,
    headSha: anchor.headSha,
    findings,
    ...(own?.leftOut && own.leftOut.length > 0 ? { leftOut: own.leftOut } : {}),
    teammate: anchor.teammate,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The PR author's posted review to anchor this run's follow-up on, with its eligible findings — or
 * null (no such review, a newer review of the reader's own, the poster is not the author, a schema
 * without the columns). Account-scoped. `beforeReviewId`: the run being prepared.
 */
export async function loadAuthorReviewAnchor(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  headSha: string,
  beforeReviewId: number,
): Promise<{ reviewId: number; headSha: string; teammate: TeammateAnchorPoster; findings: PriorFindingForFollowUp[] } | null> {
  const { pullRequests: prs, users, claudeReviewFindings: crf, claudeReviews: cr } = ctx.schema;
  if (!cr?.sourceUserId || !crf || !prs || !users) return null;
  const anchor = await latestFullReviewAtOrBefore(accountId, prId, headSha, ctx.db, { beforeReviewId });
  if (!anchor || anchor.origin !== 'teammate' || anchor.sourceUserId == null) return null;
  const pr = (await ctx.db
    .select({ authorId: prs.authorId })
    .from(prs)
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ authorId: number | null }>;
  if (pr[0]?.authorId == null || pr[0].authorId !== anchor.sourceUserId) return null;
  const who = (await ctx.db
    .select({ login: users.githubLogin })
    .from(users)
    .where(eq(users.id, anchor.sourceUserId))
    .limit(1)
    .execute()) as Array<{ login: string | null }>;
  const login = who[0]?.login;
  if (!login) return null;
  // Re-scoped to this PR + account and to a TEAMMATE row (the anchor's id came from our own read).
  const rows = (await ctx.db
    .select({ finding: crf })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .where(and(eq(crf.reviewId, anchor.reviewId), eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.kind, TEAMMATE_KIND)))
    .orderBy(asc(crf.id))
    .execute()) as Array<{ finding: Row }>;
  const findings: PriorFindingForFollowUp[] = rows
    .map((r) => r.finding)
    .filter((f) => isFollowUpEligible(f as Parameters<typeof isFollowUpEligible>[0]))
    .map((f) => ({
      id: f.id,
      headSha: anchor.headSha,
      path: f.path,
      line: f.line ?? null,
      side: f.side,
      severity: f.severity,
      title: f.title,
      body: resolveFindingBody(f as Parameters<typeof resolveFindingBody>[0]),
      suggestion: f.suggestion ?? null,
      diffHunk: f.diffHunk ?? null,
      anchored: !!f.anchored,
      fileInDiff: !!f.fileInDiff,
      posted: f.postedAt != null,
      carried: false,
    }));
  return { reviewId: anchor.reviewId, headSha: anchor.headSha, teammate: { userId: anchor.sourceUserId, login }, findings };
}
