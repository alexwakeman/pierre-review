// THE PR AUTHOR'S OWN REVIEW AS THE FOLLOW-UP ANCHOR (docs/CLAUDE-REVIEW.md § Follow-up on the
// previous review → The author's own review).
//
// The author cannot approve their own PR, so their Limn reviewing it never holds a head (team-claim.ts
// `decideTeamClaim`) and the reader's Limn still runs. That run FOLLOWS UP on the author's posted
// review (imported as `claude_reviews.kind = 'teammate'`, db/teammate-reviews-import.ts): its findings
// enter the follow-up exactly as a previous review's would, so the reader's Limn checks each one is
// dealt with, raises anything new, and may still approve under the workspace's auto verdict.
//
// ⚠ ONLY THE PR AUTHOR'S review ANCHORS, and only when it is the LATEST full review at or before this
//   head (`latestFullReviewAtOrBefore`): a newer review of the reader's own anchors the chain as before.
//   A non-author teammate's review joins only while its REQUEST_CHANGES stands (below,
//   `loadStandingBlockAnchors`), as carried findings.
// ⚠ NOTHING DROPS OUT OF THE CHAIN: the reader's own previous review (`loadPriorReviewForFollowUp`,
//   with its carries) is folded in as CARRIED findings.
// ⚠ A run that does not anchor here is UNCHANGED: same loader, same prompt bytes (prompt-golden.json).
// ⚠ NEVER A WRITE ON A TEAMMATE'S THREAD: auto resolve, the pushback and "Post reply" act only on the
//   reader's own findings (finding-replies.ts `loadThreadOwners` with `ownOnly`). The judgements show
//   in the reader's tab; the author's Limn resolves its own threads.
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';
import { TEAMMATE_KIND, latestFullReviewAtOrBefore } from '../../db/teammate-reviews.js';
import { loadTeamStandingsForPrs } from './team-view.js';
import { isSettledWord, wordsAtHead, type JudgingRun } from './teammate-lift.js';
import {
  isFollowUpEligible,
  resolveFindingBody,
  type PriorFindingForFollowUp,
  type PriorReviewForFollowUp,
} from './follow-up.js';
import { trueAuthorId } from '../../db/true-author.js';

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
    .select({ authorId: trueAuthorId(prs) })
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
  const findings = await loadTeammateFindings(ctx, prId, accountId, anchor.reviewId, anchor.headSha);
  return { reviewId: anchor.reviewId, headSha: anchor.headSha, teammate: { userId: anchor.sourceUserId, login }, findings };
}

/** A teammate review's follow-up-eligible findings (re-scoped to this PR + account + a TEAMMATE row). */
async function loadTeammateFindings(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  reviewId: number,
  headSha: string,
): Promise<PriorFindingForFollowUp[]> {
  const { claudeReviewFindings: crf, claudeReviews: cr } = ctx.schema;
  const rows = (await ctx.db
    .select({ finding: crf })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .where(and(eq(crf.reviewId, reviewId), eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.kind, TEAMMATE_KIND)))
    .orderBy(asc(crf.id))
    .execute()) as Array<{ finding: Row }>;
  return rows
    .map((r) => r.finding)
    .filter((f) => isFollowUpEligible(f as Parameters<typeof isFollowUpEligible>[0]))
    .map((f) => ({
      id: f.id,
      headSha,
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
}

// ── A TEAMMATE'S STANDING REQUEST FOR CHANGES (docs/CLAUDE-REVIEW.md § Follow-up on the previous
// review → A teammate's standing block) ────────────────────────────────────────────────────────────
//
// Besides the PR author's review, the reader's run follows up EVERY teammate's Limn review whose
// Request changes is still IN FORCE on GitHub (team-view.ts `teamStandings`: not dismissed, not
// replaced by that teammate's later review). Its findings — a pair's Codex half's too: they are in the
// posted comments — join the follow-up as CARRIED findings (each keeps its head), so the reader's Limn
// checks each one is dealt with and its post carries the judgements (`j=`) back to the teammate.
// ⚠ Never a write on their threads (the writers pass `ownOnly`). ⚠ It does not hold the head: a team
// claim is per commit, so a new head is reviewed as before.

/** A teammate review whose REQUEST_CHANGES stands, with its eligible findings. */
export interface StandingBlockAnchor {
  reviewId: number;
  headSha: string;
  teammate: TeammateAnchorPoster;
  findings: PriorFindingForFollowUp[];
}

/**
 * Every teammate review on the PR whose Request changes is still in force (newest first), each with
 * its eligible findings, then that poster's EARLIER Limn reviews on the PR with theirs. Account-scoped, DB only. `exceptReviewId`: the author anchor, already taken.
 */
export async function loadStandingBlockAnchors(
  ctx: AgentContext,
  prId: number,
  accountId: number,
  exceptReviewId: number | null = null,
  // The head this run reads. A point is left out only when settled AT THIS HEAD (teammate-lift.ts
  // `wordsAtHead`): a fix judged at an older commit may be undone, and a lift must rest on a check
  // made at the commit it lifts. null = any head (callers with no head).
  headSha: string | null = null,
): Promise<StandingBlockAnchor[]> {
  const { claudeReviewFindings: crf, claudeReviews: cr } = ctx.schema;
  if (!cr?.sourceUserId || !crf) return [];
  const standings = (await loadTeamStandingsForPrs(ctx.db, accountId, [prId], new Map())).get(prId);
  if (!standings?.reviewers.some((r) => !r.you && r.inForce?.verdict === 'REQUEST_CHANGES')) return [];
  // A finding the reader's Limn already SETTLED AT THIS HEAD (its newest follow-up word that holds
  // here: addressed, no longer applies, a reply accepted) is not sent again. A code judgement from an
  // older head does not hold: the point is checked again at this one.
  const runs = (await ctx.db
    .select({ id: cr.id, headSha: cr.headSha, followUp: cr.followUp })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), isNull(cr.kind), eq(cr.status, 'succeeded')))
    .orderBy(asc(cr.id))
    .execute()) as JudgingRun[];
  const word = wordsAtHead(runs, headSha);
  const settled = (id: number): boolean => isSettledWord(word.get(id));
  const out: StandingBlockAnchor[] = [];
  for (const r of standings?.reviewers ?? []) {
    const f = r.inForce;
    if (r.you || r.poster == null || f == null || f.verdict !== 'REQUEST_CHANGES' || f.reviewId == null || f.headSha == null) continue;
    if (f.reviewId === exceptReviewId) continue;
    const teammate = { userId: r.poster.userId, login: r.poster.login };
    const findings = (await loadTeammateFindings(ctx, prId, accountId, f.reviewId, f.headSha)).filter((x) => !settled(x.id));
    if (findings.length > 0) out.push({ reviewId: f.reviewId, headSha: f.headSha, teammate, findings });
    // ⚠ THE POSTER'S EARLIER LIMN REVIEWS ON THIS PR join too (2026-11-10): a block can rest on a
    // blocker posted in an earlier review that a re-post left out (deduped as already posted). The
    // away path dismisses only when every one of them is settled (teammate-lift.ts), so each must
    // reach a follow-up to be judged.
    const earlier = (await ctx.db
      .select({ id: cr.id, headSha: cr.headSha })
      .from(cr)
      .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.kind, TEAMMATE_KIND), eq(cr.sourceUserId, r.poster.userId)))
      .orderBy(desc(cr.id))
      .execute()) as Array<{ id: number; headSha: string | null }>;
    for (const e of earlier) {
      if (e.id === f.reviewId || e.id === exceptReviewId || e.headSha == null) continue;
      const more = (await loadTeammateFindings(ctx, prId, accountId, e.id, e.headSha)).filter((x) => !settled(x.id));
      if (more.length > 0) out.push({ reviewId: e.id, headSha: e.headSha, teammate, findings: more });
    }
  }
  return out;
}

/**
 * THE MERGE WITH STANDING BLOCKS (pure): `prior` (the reader's own previous review, or the author
 * anchor already merged) keeps its anchor; each block's findings join as CARRIED, once per id, settled
 * ids left out. With no prior at all, the newest block anchors the follow-up (its `teammate` set).
 */
export function mergeStandingBlocks(
  prior: PriorReviewForFollowUp | null,
  blocks: readonly StandingBlockAnchor[],
  settledIds: ReadonlySet<number> = new Set(),
): PriorReviewForFollowUp | null {
  const open = blocks.map((b) => ({ ...b, findings: b.findings.filter((f) => !settledIds.has(f.id)) })).filter((b) => b.findings.length > 0);
  if (open.length === 0) return prior;
  if (prior == null) {
    const [first, ...rest] = open;
    return mergeStandingBlocks(mergeAuthorAnchor(first!, null, settledIds), rest, settledIds);
  }
  const seen = new Set(prior.findings.map((f) => f.id));
  const findings = [...prior.findings];
  for (const b of open)
    for (const f of b.findings) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      findings.push({ ...f, carried: true });
    }
  return { ...prior, findings };
}
