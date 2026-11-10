// LIFTING A TEAMMATE'S LIMN BLOCK (docs/CLAUDE-REVIEW.md § Lifting a teammate's block).
//
// A teammate's Limn posted a review that REQUESTED CHANGES, and that request still stands on GitHub
// (team-view.ts `teamStandings`). The reader's run follows up on its findings (teammate-anchor.ts
// `loadStandingBlockAnchors`). When that run finds EVERY point behind the block settled, the reader's
// Limn may DISMISS the teammate's review and post its own. ALWAYS ON since 2026-11-10 (the two
// workspace opt-ins, `teamLiftConsent` and `liftTeammateBlocks`, are gone), but it still needs
//   (a) THE BLOCKED SIDE'S CONSENT: the teammate's post carries `lift=1` in its hidden marker (every
//       post whose comments hold every blocker behind it; shared limn-review-meta.ts) — an older post
//       without it is lifted only by the away path. Read from the LIVE body.
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
//
// THE AWAY PATH (2026-11-10; docs/TEAM-REVIEW.md § 5 "When the teammate is away"): with no consent on
// the post, the reader's Limn still dismisses the teammate's Limn block when the teammate's Limn is AWAY and the
// reader's review APPROVES. Every condition above holds except (a), and instead:
//   - the reader's review goes out as an APPROVE and lands as one (auto verdict on, its gates clear —
//     a COMMENT or a refused approve never dismisses on this path);
//   - the block came from the teammate's AUTO run (`k=auto` in the marker, imported and LIVE): a review
//     they sent with the Post button (or "Review and post") is their own judgement, never dismissed;
//   - THE POINTS are every counted finding across ALL of the teammate's Limn reviews on the PR
//     (`countedFindings`), not just the block's own: a block can rest on an earlier blocker its re-post
//     left out. Each must be settled at this head (teammate-anchor.ts sends them all to the follow-up);
//   - THE TEAMMATE IS AWAY (`teammateAwayHold`): their Limn has no `limn/review-*` line at this head
//     (read LIVE before the write), no review at this head, no review after the block on GitHub, and
//     wrote nothing Limn has seen for TEAMMATE_AWAY_AFTER_MS (`teammateLastSeenMs`: anything synced
//     they wrote on any PR of the account — by hand or through their Limn — and their claim lines).
// A read that fails holds it. Recorded with `why: 'away'`; the message says why
// (`teammateAwayLiftMessage`), still in the "Limn (alex) checked …" form every Limn already reads as
// Limn's dismissal.
import { and, eq, isNull, lte, max } from 'drizzle-orm';
import {
  hasLimnReviewMarker,
  parseLimnReviewMarker,
  type ApproveLeftovers,
  type ClaudeFindingSeverity,
  type TeammateLiftRecord,
  type TeammateLiftWhy,
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
  return countedFindings(findings, leftovers);
}

/**
 * THE COUNTED FINDINGS of a review, with no fail-safe: every blocker, warning and unlabelled finding,
 * and each nit / question the reader's approve rule does not let stay open. Praise never. The away
 * path reads them across every Limn review the poster sent on the PR.
 */
export function countedFindings(findings: readonly BlockFinding[], leftovers: ApproveLeftovers): BlockFinding[] {
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
  | 'own_pr'
  | 'own_review'
  | 'not_in_force'
  | 'already_tried'
  | 'no_consent'
  | 'not_limn'
  | 'own_blocker'
  | 'no_points'
  | 'points_open'
  | 'head_moved'
  // The away path only:
  | 'not_approving'
  | 'not_auto'
  | 'teammate_active'
  | 'teammate_recent'
  | 'teammate_unknown';

/**
 * A teammate's Limn counts as AWAY after this long with nothing seen from it (no review, no finding,
 * no reply, no claim line). Long enough that an auto review on a live machine (a new head is claimed
 * within minutes, reviewed within the 20-minute settle) has had its chance many times over.
 */
export const TEAMMATE_AWAY_AFTER_MS = 4 * 60 * 60 * 1000;

/** What the reader's Limn knows about whether the teammate's Limn is around. */
export interface TeammateAwayFacts {
  // A `limn/review-*` line by the teammate at the head (live), a review of theirs at the head, or a
  // review of theirs on GitHub after the block. null = it could not be read.
  activeAtHead: boolean | null;
  // The newest thing Limn has seen from their Limn, epoch ms. null = nothing at all.
  lastSeenMs: number | null;
  nowMs: number;
}

/** THE AWAY RULE (pure): null when the teammate's Limn is away, else why not. */
export function teammateAwayHold(f: TeammateAwayFacts): TeammateLiftHold | null {
  if (f.activeAtHead == null) return 'teammate_unknown';
  if (f.activeAtHead) return 'teammate_active';
  if (f.lastSeenMs != null && f.nowMs - f.lastSeenMs < TEAMMATE_AWAY_AFTER_MS) return 'teammate_recent';
  return null;
}

export interface TeammateLiftFacts {
  // 'consent' (the post's `lift=1`) or 'away' (none: the teammate's Limn is away and the reader
  // approves). Absent = 'consent'.
  why?: TeammateLiftWhy;
  // The away path: the reader's review approves.
  approves?: boolean;
  // The away path: the block came from the teammate's AUTO run (marker `k=auto`). A manual Post is
  // their own judgement and is never dismissed.
  auto?: boolean;
  away?: TeammateAwayFacts;
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
  const away = f.why === 'away';
  if (f.authorIsMe) return 'own_pr';
  if (f.posterIsMe) return 'own_review';
  if (!f.inForce) return 'not_in_force';
  if (f.alreadyTried) return 'already_tried';
  if (!f.limn) return 'not_limn';
  if (away) {
    if (f.approves !== true) return 'not_approving';
    if (f.auto !== true) return 'not_auto';
    const h = f.away != null ? teammateAwayHold(f.away) : 'teammate_unknown';
    if (h != null) return h;
  } else if (!f.consent) return 'no_consent';
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

/** How long ago, in words a person reads at a glance: "5 hours", "2 days". */
export function awayFor(ms: number): string {
  const h = Math.max(1, Math.floor(ms / 3_600_000));
  if (h < 48) return h === 1 ? '1 hour' : `${h} hours`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}

/**
 * GitHub's dismissal message on the AWAY path. It keeps the "Limn (alex) checked …" lead, so every Limn
 * (an older one too: shared `isLimnDismissalMessage`) reads it as Limn's dismissal, never the person's.
 * `awayMs` null = their Limn was never seen at all.
 */
export function teammateAwayLiftMessage(login: string, poster: string, points: number, headSha: string, awayMs: number | null): string {
  const checked = teammateLiftMessage(login, points, headSha).replace(/\.$/, '');
  const away = awayMs == null ? `${poster}'s Limn has not reviewed it` : `${poster}'s Limn has not reviewed it and has been away for ${awayFor(awayMs)}`;
  return `${checked}. ${away}.`;
}

// ---- I/O ----

const ms = (v: Date | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = v instanceof Date ? v.getTime() : Number(v) < 1e12 ? Number(v) * 1000 : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * THE NEWEST THING THIS LIMN HAS SEEN FROM A TEAMMATE (DB only, account-scoped), epoch ms: their
 * imported Limn reviews; every review, review comment and PR comment they wrote on any of the
 * account's PRs, by hand (`author_id` = them) or through their Limn (`limn_posted_by_user_id` = them);
 * and their claim lines this Limn stood down for. A person active by hand is not away. null = nothing.
 */
export async function teammateLastSeenMs(
  ctx: AgentContext,
  accountId: number,
  posterUserId: number,
  posterLogin: string,
): Promise<number | null> {
  const t = s(ctx);
  const seen: Array<number | null> = [];
  const one = async (q: Promise<Array<{ at: Date | number | null }>>): Promise<void> => {
    seen.push(ms((await q)[0]?.at));
  };
  const cr = t.claudeReviews;
  if (cr?.sourceUserId && cr?.postedAt) {
    await one(
      ctx.db
        .select({ at: max(cr.postedAt) })
        .from(cr)
        .where(and(eq(cr.accountId, accountId), eq(cr.kind, TEAMMATE_KIND), eq(cr.sourceUserId, posterUserId)))
        .execute(),
    );
  }
  const prs = t.pullRequests;
  for (const [tbl, col] of [
    [t.reviews, t.reviews?.submittedAt],
    [t.reviewComments, t.reviewComments?.createdAt],
    [t.prComments, t.prComments?.createdAt],
  ] as const) {
    if (!col || !prs) continue;
    for (const who of [tbl?.authorId, tbl?.limnPostedByUserId]) {
      if (!who) continue;
      await one(
        ctx.db
          .select({ at: max(col) })
          .from(tbl)
          .innerJoin(prs, eq(prs.id, tbl.prId))
          .where(and(eq(prs.accountId, accountId), eq(who, posterUserId)))
          .execute(),
      );
    }
  }
  const tcs = t.teamClaimSeen;
  if (tcs) {
    await one(
      ctx.db
        .select({ at: max(tcs.lineAt) })
        .from(tcs)
        .where(and(eq(tcs.accountId, accountId), eq(tcs.login, posterLogin)))
        .execute(),
    );
  }
  const all = seen.filter((x): x is number => x != null);
  return all.length > 0 ? Math.max(...all) : null;
}

/** Has the teammate's Limn reviewed `headSha`, or did this Limn see their claim line there? DB only. */
export async function teammateSeenAtHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
  posterUserId: number,
  posterLogin: string,
): Promise<boolean> {
  const t = s(ctx);
  const cr = t.claudeReviews;
  if (cr?.sourceUserId) {
    const r = await ctx.db
      .select({ id: cr.id })
      .from(cr)
      .where(and(eq(cr.accountId, accountId), eq(cr.prId, prId), eq(cr.kind, TEAMMATE_KIND), eq(cr.headSha, headSha), eq(cr.sourceUserId, posterUserId)))
      .limit(1)
      .execute();
    if (r.length > 0) return true;
  }
  const tcs = t.teamClaimSeen;
  if (tcs) {
    const rows = (await ctx.db
      .select({ login: tcs.login })
      .from(tcs)
      .where(and(eq(tcs.accountId, accountId), eq(tcs.prId, prId), eq(tcs.headSha, headSha)))
      .execute()) as Array<{ login: string }>;
    if (rows.some((x) => x.login.toLowerCase() === posterLogin.toLowerCase())) return true;
  }
  return false;
}

/** A teammate block that passed every DB-side condition: the live check and the write remain. */
export interface TeammateLiftCandidate {
  teammateReviewId: number;
  githubReviewId: string;
  posterUserId: number;
  login: string;
  points: number;
  // Which path admitted it. 'away' still needs the live checks: no line at the head, an APPROVE that lands.
  why: TeammateLiftWhy;
  // The away path: when Limn last saw the teammate's Limn (epoch ms; null = never).
  lastSeenMs?: number | null;
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
    // The away path: the reader's run wants an APPROVE (the auto verdict is on and nothing is open).
    awayPath?: boolean;
    nowMs?: number;
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
    const base: TeammateLiftFacts = {
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
    };
    const cand = {
      teammateReviewId: id,
      githubReviewId: String(rec.githubReviewId),
      posterUserId: b.poster!.userId,
      login: b.poster!.login,
      points: points.length,
    };
    if (teammateLiftHold(base) == null) {
      out.push({ ...cand, why: 'consent' });
      continue;
    }
    if (a.awayPath !== true) continue;
    // THE AWAY PATH, as far as the DB can tell (the live line read and the landed APPROVE come later).
    // Its points: the block's own (the fail-safe above still applies), plus every counted finding of
    // the poster's OTHER Limn reviews on this PR — an earlier blocker the block's re-post left out.
    const awayPoints = [...points];
    if (awayPoints.length > 0) {
      const seen = new Set(awayPoints.map((p) => p.id));
      const others = (await ctx.db
        .select({ id: crf.id, severity: crf.severity, nodeId: crf.sourceCommentNodeId, teammate: cr.teammate })
        .from(crf)
        .innerJoin(cr, eq(cr.id, crf.reviewId))
        .where(
          and(eq(cr.prId, a.prId), eq(cr.accountId, a.accountId), eq(cr.kind, TEAMMATE_KIND), eq(cr.sourceUserId, b.poster!.userId)),
        )
        .execute()) as Array<{ id: number; severity: ClaudeFindingSeverity; nodeId: string | null; teammate: TeammateReviewRecord | null }>;
      const counted = countedFindings(
        others.map((f) => ({
          id: f.id,
          severity: f.nodeId != null && (f.teammate?.unlabelled ?? []).includes(f.nodeId) ? null : f.severity,
        })),
        a.leftovers,
      );
      for (const p of counted) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        awayPoints.push(p);
      }
    }
    const lastSeenMs = await teammateLastSeenMs(ctx, a.accountId, b.poster!.userId, b.poster!.login);
    const activeAtHead = await teammateSeenAtHead(ctx, a.accountId, a.prId, a.headSha, b.poster!.userId, b.poster!.login);
    const hold = teammateLiftHold({
      ...base,
      points: awayPoints,
      why: 'away',
      approves: true,
      auto: rec.run === 'auto',
      away: { activeAtHead, lastSeenMs, nowMs: a.nowMs ?? Date.now() },
    });
    if (hold != null) continue;
    out.push({ ...cand, points: awayPoints.length, why: 'away', lastSeenMs });
  }
  return out;
}

/** One review in the LIVE GitHub list, as the live check reads it (oldest first). */
export interface LiftLiveReview {
  id?: string | number | null;
  login: string | null;
  state: string;
  body?: string | null;
  // ISO-8601, when GitHub has it (the away path reads it; absent = unknown, read as recent).
  submittedAt?: string | null;
}

/**
 * THE LIVE CHECK (pure): is the candidate still the poster's STANDING CHANGES_REQUESTED on GitHub
 * (their newest decisive review — a COMMENTED or PENDING one never replaces it), with Limn's summary
 * marker and the consent in its live body? A list without bodies fails safe (no marker read).
 */
export function liveLiftCheck(
  reviews: readonly LiftLiveReview[],
  c: Pick<TeammateLiftCandidate, 'githubReviewId' | 'login'> & { why?: TeammateLiftWhy },
  readerLogin: string | null,
  nowMs: number = Date.now(),
): TeammateLiftHold | null {
  const who = c.login.toLowerCase();
  if (readerLogin != null && readerLogin.toLowerCase() === who) return 'own_review';
  // The away path: a review of theirs on GitHub after the block (a Comment, a thread reply) inside the
  // away window means their Limn, or they, are around: never dismissed as away. No time = recent.
  let later = false;
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const r = reviews[i]!;
    if (r.login == null || r.login.toLowerCase() !== who) continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') {
      const at = r.submittedAt != null ? Date.parse(r.submittedAt) : NaN;
      if (r.state === 'PENDING' || !Number.isFinite(at) || nowMs - at < TEAMMATE_AWAY_AFTER_MS) later = true;
      continue;
    }
    if (r.state !== 'CHANGES_REQUESTED' || r.id == null || String(r.id) !== c.githubReviewId) return 'not_in_force';
    if (!hasLimnReviewMarker(r.body)) return 'not_limn';
    if (c.why === 'away') {
      // Only a block their AUTO run sent: a Post-button review is the person's own judgement.
      if (parseLimnReviewMarker(r.body)?.run !== 'auto') return 'not_auto';
      return later ? 'teammate_active' : null;
    }
    if (parseLimnReviewMarker(r.body)?.liftConsent !== true) return 'no_consent';
    return null;
  }
  return 'not_in_force';
}

/** One `limn/review-*` status line at the head, as the away check reads it. */
export interface AwayLiveLine {
  login: string | null;
}

/** Does the teammate hold any Limn line at the head (live)? null lines = unreadable. Pure. */
export function teammateLineAtHead(lines: readonly AwayLiveLine[] | null, login: string): boolean | null {
  if (lines == null) return null;
  const who = login.toLowerCase();
  return lines.some((l) => l.login != null && l.login.toLowerCase() === who);
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
