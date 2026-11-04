// LIFTING A TEAMMATE'S LIMN BLOCK (docs/CLAUDE-REVIEW.md § Lifting a teammate's block).
//
// A teammate's Limn posted a review that REQUESTED CHANGES, and that request still stands on GitHub
// (team-view.ts `teamStandings`). The reader's run follows up on its findings (teammate-anchor.ts
// `loadStandingBlockAnchors`). When that run finds EVERY point behind the block settled, the reader's
// Limn may DISMISS the teammate's review and post its own — but only with BOTH opt-ins on:
//   (a) THE BLOCKED SIDE'S CONSENT: the teammate's post carries `lift=1` in its hidden marker (their
//       workspace setting `teamLiftConsent`; shared limn-review-meta.ts). Read from the LIVE body;
//   (b) THE LIFTING SIDE'S SETTING: the reader's workspace `liftTeammateBlocks`.
// And ALL of (`teammateLiftHold`, pure — the first that fails decides):
//   - the PR is not the reader's own (an author never lifts a block on their own work);
//   - the block is a TEAMMATE'S, never the reader's own (that is auto-post.ts's own-lift path);
//   - the run is at the PR's CURRENT head (auto-post.ts reads the live head; a moved head fails the post);
//   - the reader's own run has NO blocker, and no earlier blocker of its own left unjudged;
//   - THE POINTS BEHIND THE BLOCK (`pointsBehindBlock`): every finding of the blocking review that the
//     verdict counts — every blocker, warning and unlabelled finding, plus each nit / question the
//     reader's approve rule (`approveLeftovers`) does not let stay open; a pair's Codex-half comments
//     are in the posted review like any other. ⚠ A review whose own comments hold no blocker, warning
//     or unlabelled finding is NEVER lifted: its block rests on something its comments do not show
//     (the poster's side also withholds `lift=1` then — auto-post.ts `blockersAllInPost`);
//   - EACH point's NEWEST judgement by the reader's Limn AT THE HEAD BEING LIFTED (`wordsAtHead`: a
//     code judgement made at an older head never counts — a push can undo the fix; a reply it accepted
//     holds across heads; a 'not_checked' never counts) is addressed, no longer applies, or a reply it
//     accepted. teammate-anchor.ts sends every point not settled AT THIS HEAD to the run's follow-up,
//     so the judgement is this run's (or an earlier run's at the same commit);
//   - the LIVE review is still the poster's standing CHANGES_REQUESTED, carries LIMN'S SUMMARY MARKER
//     (never a person's typed review) and the consent.
// Then, inside auto-post.ts's claim: the reader's review goes out (APPROVE when the auto verdict and its
// gate allow it, else COMMENT — it carries the judgements in `j=`), and after it lands the dismissal:
// ⚠ CLAIM BEFORE WRITE — `claude_reviews.teammate_lift` on the teammate's row is set NULL → 'dismissing'
//   by a compare-and-set, so one teammate review is dismissed at most once, ever, by any run;
// ⚠ NEVER RETRIED — a refusal (403: no write access, dismissal restricted by branch protection) is
//   recorded in GitHub's words ('failed') and shown in the AI Review tab; nothing tries again.
// Then the cascade (`settlePrAfterWrite`) with the post.
import { and, eq, isNull, lte } from 'drizzle-orm';
import {
  hasLimnReviewMarker,
  parseLimnReviewMarker,
  type ApproveLeftovers,
  type ClaudeFindingSeverity,
  type TeammateLiftRecord,
  type TeammateReviewRecord,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { leftoverAllowed } from './auto-verdict.js';
import { loadTeamStandingsForPrs } from './team-view.js';
import { TEAMMATE_KIND } from '../../db/teammate-reviews.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- pure rules ----

/** One finding of the blocking review. `severity: null` = posted with no severity lead. */
export interface BlockFinding {
  id: number;
  severity: ClaudeFindingSeverity | null;
}

/**
 * THE POINTS BEHIND A BLOCK: the blocking review's findings the verdict counts — every blocker,
 * warning and unlabelled finding, and each nit / question the reader's approve rule does not let stay
 * open. Praise never. None of those ⇒ every non-praise finding (the poster blocked on them).
 */
export function pointsBehindBlock(findings: readonly BlockFinding[], leftovers: ApproveLeftovers): BlockFinding[] {
  // ⚠ FAIL SAFE: a REQUEST_CHANGES whose own comments hold no blocker, warning or unlabelled finding
  // rests on something else (a blocker posted in an EARLIER review, which a re-post leaves out). Its
  // comments cannot explain the block, so there is nothing this check can settle: never lifted.
  if (!findings.some((f) => f.severity == null || f.severity === 'blocker' || f.severity === 'warning')) return [];
  return findings.filter((f) => f.severity !== 'praise' && (f.severity == null || !leftoverAllowed(f.severity, leftovers)));
}

// The follow-up words that SETTLE a point (the same set the own-lift path reads).
const SETTLED = new Set(['addressed', 'no_longer_applies', 'reply_accepted']);

/** One reader run as the judgement fold reads it. */
export interface JudgingRun {
  headSha?: string | null;
  followUp?: { items?: ReadonlyArray<{ priorFindingId: number; status: string }> } | null;
}

/**
 * Each finding's NEWEST judgement across the reader's runs (oldest run first; 'not_checked' skipped)
 * that still holds AT `headSha`. ⚠ A code judgement (addressed, no longer applies, not addressed)
 * holds only at the commit it read: a later push can undo a fix. So a run at another head contributes
 * only a 'reply_accepted' (a settled discussion, not a reading of the code), and any other word of its
 * clears what came before. `headSha` null = every run counts (no head to hold to).
 */
export function wordsAtHead(runs: ReadonlyArray<JudgingRun>, headSha: string | null): Map<number, string> {
  const word = new Map<number, string>();
  for (const r of runs)
    for (const it of r.followUp?.items ?? []) {
      if (it.status === 'not_checked') continue;
      if (headSha == null || r.headSha === headSha || it.status === 'reply_accepted') word.set(it.priorFindingId, it.status);
      else word.delete(it.priorFindingId);
    }
  return word;
}

/** Does this word settle a point? */
export const isSettledWord = (w: string | undefined): boolean => w != null && SETTLED.has(w);

/** Why a teammate's block is NOT lifted. null = every condition holds. */
export type TeammateLiftHold =
  | 'setting_off'
  | 'own_pr'
  | 'own_review'
  | 'not_in_force'
  | 'already_tried'
  | 'no_consent'
  | 'not_limn'
  | 'own_blocker'
  | 'no_points'
  | 'points_open'
  | 'head_moved';

export interface TeammateLiftFacts {
  // (b) the reader's workspace setting.
  settingOn: boolean;
  authorIsMe: boolean;
  // The block's poster is the reader.
  posterIsMe: boolean;
  // The poster's standing review (DB, then live) is this CHANGES_REQUESTED.
  inForce: boolean;
  // `claude_reviews.teammate_lift` is already set: tried once, never again.
  alreadyTried: boolean;
  // (a) the post carries `lift=1`.
  consent: boolean;
  // The review body carries Limn's summary marker.
  limn: boolean;
  // The reader's run has a blocker of its own, or an earlier blocker of its own left unjudged.
  ownBlocker: boolean;
  // The run read the PR's current head.
  atCurrentHead: boolean;
  points: readonly BlockFinding[];
  words: ReadonlyMap<number, string>;
}

/** THE RULE (pure): the first condition that fails, or null when the block may be lifted. */
export function teammateLiftHold(f: TeammateLiftFacts): TeammateLiftHold | null {
  if (!f.settingOn) return 'setting_off';
  if (f.authorIsMe) return 'own_pr';
  if (f.posterIsMe) return 'own_review';
  if (!f.inForce) return 'not_in_force';
  if (f.alreadyTried) return 'already_tried';
  if (!f.limn) return 'not_limn';
  if (!f.consent) return 'no_consent';
  if (f.ownBlocker) return 'own_blocker';
  if (!f.atCurrentHead) return 'head_moved';
  if (f.points.length === 0) return 'no_points';
  if (f.points.some((p) => !isSettledWord(f.words.get(p.id)))) return 'points_open';
  return null;
}

/** GitHub's dismissal message: who checked, how many points, at which commit. */
export function teammateLiftMessage(login: string, points: number, headSha: string): string {
  const sha = headSha.slice(0, 7);
  return points === 1
    ? `Limn (${login}) checked the 1 point is addressed at ${sha}.`
    : `Limn (${login}) checked all ${points} points are addressed at ${sha}.`;
}

// ---- I/O ----

/** A teammate block that passed every DB-side condition: the live check and the write remain. */
export interface TeammateLiftCandidate {
  teammateReviewId: number;
  githubReviewId: string;
  posterUserId: number;
  login: string;
  points: number;
}

/**
 * THE DB PRE-CHECK: every teammate block on the PR that passes every condition the DB can answer
 * (in force as synced, not tried, consent imported, every point settled). Account-scoped. Cheap when
 * there is nothing to lift: one standings read. `runIds`: the run (a pair: both halves) — its own
 * follow-up is read from the DB like every earlier run's.
 */
export async function loadTeammateLiftCandidates(
  ctx: AgentContext,
  a: {
    accountId: number;
    prId: number;
    reviewId: number;
    // The head the run read (and the lift would be at): only judgements that hold here count.
    headSha: string;
    leftovers: ApproveLeftovers;
    readerLogin: string | null;
  },
): Promise<TeammateLiftCandidate[]> {
  const t = s(ctx);
  const cr = t.claudeReviews;
  const crf = t.claudeReviewFindings;
  if (!cr?.teammateLift || !crf) return [];
  const standings = (await loadTeamStandingsForPrs(ctx.db, a.accountId, [a.prId], new Map())).get(a.prId);
  const blocks = (standings?.reviewers ?? []).filter(
    (r) => !r.you && r.poster != null && r.inForce?.verdict === 'REQUEST_CHANGES' && r.inForce.reviewId != null,
  );
  if (blocks.length === 0) return [];
  // The reader's judgements: every reviewing run of theirs up to this one (a pair's halves included).
  const runs = (await ctx.db
    .select({ id: cr.id, headSha: cr.headSha, followUp: cr.followUp })
    .from(cr)
    .where(and(eq(cr.prId, a.prId), eq(cr.accountId, a.accountId), isNull(cr.kind), eq(cr.status, 'succeeded'), lte(cr.id, a.reviewId)))
    .orderBy(cr.id)
    .execute()) as JudgingRun[];
  const words = wordsAtHead(runs, a.headSha);
  const me = a.readerLogin?.toLowerCase() ?? null;
  const out: TeammateLiftCandidate[] = [];
  for (const b of blocks) {
    const id = b.inForce!.reviewId!;
    const row = (
      (await ctx.db
        .select({ teammate: cr.teammate, lift: cr.teammateLift })
        .from(cr)
        .where(and(eq(cr.id, id), eq(cr.prId, a.prId), eq(cr.accountId, a.accountId), eq(cr.kind, TEAMMATE_KIND)))
        .limit(1)
        .execute()) as Array<{ teammate: TeammateReviewRecord | null; lift: TeammateLiftRecord | null }>
    )[0];
    const rec = row?.teammate ?? null;
    if (row == null || rec?.githubReviewId == null) continue;
    const found = (await ctx.db
      .select({ id: crf.id, severity: crf.severity, nodeId: crf.sourceCommentNodeId })
      .from(crf)
      .where(eq(crf.reviewId, id))
      .execute()) as Array<{ id: number; severity: ClaudeFindingSeverity; nodeId: string | null }>;
    const unlabelled = new Set(rec.unlabelled ?? []);
    const points = pointsBehindBlock(
      found.map((f) => ({ id: f.id, severity: f.nodeId != null && unlabelled.has(f.nodeId) ? null : f.severity })),
      a.leftovers,
    );
    const hold = teammateLiftHold({
      settingOn: true,
      authorIsMe: false,
      posterIsMe: me != null && b.poster!.login.toLowerCase() === me,
      inForce: true,
      alreadyTried: row.lift != null,
      // The marker as imported; the live body is checked again before any write.
      limn: true,
      consent: rec.liftConsent === true,
      ownBlocker: false,
      atCurrentHead: true,
      points,
      words,
    });
    if (hold != null) continue;
    out.push({
      teammateReviewId: id,
      githubReviewId: String(rec.githubReviewId),
      posterUserId: b.poster!.userId,
      login: b.poster!.login,
      points: points.length,
    });
  }
  return out;
}

/** One review in the LIVE GitHub list, as the live check reads it (oldest first). */
export interface LiftLiveReview {
  id?: string | number | null;
  login: string | null;
  state: string;
  body?: string | null;
}

/**
 * THE LIVE CHECK (pure): is the candidate still the poster's STANDING CHANGES_REQUESTED on GitHub
 * (their newest decisive review — a COMMENTED or PENDING one never replaces it), with Limn's summary
 * marker and the consent in its live body? A list without bodies fails safe (no marker read).
 */
export function liveLiftCheck(
  reviews: readonly LiftLiveReview[],
  c: Pick<TeammateLiftCandidate, 'githubReviewId' | 'login'>,
  readerLogin: string | null,
): TeammateLiftHold | null {
  const who = c.login.toLowerCase();
  if (readerLogin != null && readerLogin.toLowerCase() === who) return 'own_review';
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const r = reviews[i]!;
    if (r.login == null || r.login.toLowerCase() !== who) continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    if (r.state !== 'CHANGES_REQUESTED' || r.id == null || String(r.id) !== c.githubReviewId) return 'not_in_force';
    if (!hasLimnReviewMarker(r.body)) return 'not_limn';
    if (parseLimnReviewMarker(r.body)?.liftConsent !== true) return 'no_consent';
    return null;
  }
  return 'not_in_force';
}

const nowIso = (): string => new Date().toISOString();

/**
 * THE CLAIM (compare-and-set NULL → 'dismissing') on the teammate's row, BEFORE the GitHub write.
 * false = some run already tried this block: never again.
 */
export async function claimTeammateLift(
  ctx: AgentContext,
  accountId: number,
  teammateReviewId: number,
  rec: Omit<TeammateLiftRecord, 'status' | 'at' | 'error'>,
): Promise<boolean> {
  const cr = s(ctx).claudeReviews;
  const rows = (await ctx.db
    .update(cr)
    .set({ teammateLift: { ...rec, status: 'dismissing', at: nowIso(), error: null } satisfies TeammateLiftRecord })
    .where(and(eq(cr.id, teammateReviewId), eq(cr.accountId, accountId), eq(cr.kind, TEAMMATE_KIND), isNull(cr.teammateLift)))
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** Settle a claimed lift: 'dismissed', or 'failed' with GitHub's words. */
export async function settleTeammateLift(
  ctx: AgentContext,
  accountId: number,
  teammateReviewId: number,
  rec: TeammateLiftRecord,
): Promise<void> {
  const cr = s(ctx).claudeReviews;
  await ctx.db
    .update(cr)
    .set({ teammateLift: rec })
    .where(and(eq(cr.id, teammateReviewId), eq(cr.accountId, accountId), eq(cr.kind, TEAMMATE_KIND)))
    .execute();
}
