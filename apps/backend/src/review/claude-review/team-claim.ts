// TEAM CLAIMS — "Mark auto reviews on GitHub" (docs/CLAUDE-REVIEW.md § Team claims).
//
// Limn runs on each person's machine. When several people on one team switch auto review on for the
// same repos, every install would review every new head. With this switch on (per workspace, ON by
// default since 0159, `workspaces.team_claims_enabled`), an AUTO review marks the PR's head commit with a GitHub
// COMMIT STATUS before it runs, so a teammate's Limn sees the line and skips that head:
//
//     context  limn/review-claude | limn/review-codex   (ONE per provider family, the RUN's provider —
//                                                         a different provider still reviews)
//     pending  "alex is reviewing with Claude"          (the claim; renewed every TEAM_CLAIM_RENEW_MS)
//     success  "alex reviewed · 4 comments"             (target_url = the posted GitHub review, if any)
//     success  "Cleared by alex: review didn't finish · free to claim"   (a failure, a Stop, a dropped
//                                                         run — never red, never pending)
//     success  "Cleared by alex"                        (the reader's Clear; reads as free)
//     success  "Cleared by alex: bob's claim expired"   (a teammate's stale line, released once)
//     success  "Cleared by alex: auto review skipped · AI budget used"   (this Limn did not start an
//                                                         auto review it would otherwise run — the
//                                                         budget, the daily limit, a usage limit, AI
//                                                         not signed in; team-claim-skip.ts. Free.)
//   ⚠ Every FREE success line starts "Cleared by ": a teammate still on an older Limn (whose fold reads
//   any other success by someone else as "already reviewed") reads it as free too. The fold still
//   reads "free to claim" and "Released:" (lines a 2026-10-28 build may have posted) as free.
//
// ⚠ AUTO REVIEWS ONLY (the tick AND the reader's "Run auto reviews now" / Retry). A manual run never
//   claims and never checks claims.
// ⚠ WHO and WHEN come from GitHub, never from the description: the line's `creator.login` and its
//   `created_at` (the lease runs TEAM_CLAIM_LEASE_MS from the claimant's NEWEST line). Descriptions
//   are for people; only the FREE phrases ("free to claim", "Cleared by", "Released:") are read back.
// ⚠ NEVER LEFT PENDING (2026-10-28): every claim is written to the LEDGER (`team_claim_lines`,
//   team-claim-ledger.ts) BEFORE its pending line is posted, and moved on after every write. The
//   reconciler (team-claim-release.ts, at boot and on every auto-review tick) releases any open row
//   whose run is not queued or running in this process — a restart, a dropped run, a failed final write.
// ⚠ THE PR AUTHOR'S OWN LINES ARE LEFT OUT (2026-11-03): the author cannot approve their own PR, so
//   their Limn reviewing it holds nothing and the reader's Limn still reviews (a follow-up on the
//   author's posted review). Only when the reader is not the author.
// ⚠ A HOLDER WHOSE REVIEW IS ALREADY ON GITHUB HAS FINISHED (2026-11-05): a teammate's Limn can post
//   its review and still never write its final "reviewed" line (PR #592: robin-dunn's review landed at
//   12:02, the reader's Limn waited for the lease until 12:27). The teammate's Limn-marked review AT
//   THIS HEAD for this provider, already imported from sync (`claude_reviews.kind = 'teammate'`, the
//   marker's own `h=`, posted at or after their pending line began — `postedTeammateReviewsAtHead`, DB
//   only), counts as their success line (`withPostedReviews`): the reader's Limn stands down at once as
//   "already reviewed by @x", exactly as for a real success line. The PR author's lines still never
//   hold, and a later line (a Clear, another claim) still wins.
// ⚠ ONE PURE FOLD decides (`decideTeamClaim`): the newest line settles it — a success by someone else
//   is "already reviewed" (a Clear is free), a failure/error is free; under a pending line, the
//   claimants since the last settling line race: among those whose newest line is inside the lease,
//   the one whose FIRST line is EARLIEST (created_at, then id) holds the head. After posting its own
//   line, a Limn re-reads; a loser stands down and re-posts the winner's description so GitHub's
//   displayed latest line names the winner.
// ⚠ SKIPPED IS NOT A FAILURE: a skip writes NO run row (no retry count, no failure, no daily-cap use).
//   It is remembered in memory (`skips`, per PR) for the tab and the Open PRs line, and the next check
//   waits until the holder's lease ends ("reviewing") or TEAM_CLAIM_REVIEWED_RECHECK_MS ("reviewed").
//   A restart forgets it and re-reads GitHub once.
// ⚠ NEVER BLOCKS A RUN ON GITHUB: an unreadable history runs WITHOUT a line (logged); a write GitHub
//   refuses (403/404: no write access) runs without a line too — others' lines read in step 1 are
//   still honoured. A claim's write is never retried; only the RELEASE of a line we posted is, by the
//   reconciler (idempotent: the same success line again).
import type {
  AiProviderId,
  ClaudeTeamClaimPending,
  ClaudeTeamClaimRecord,
  ClaudeReviewVerdict,
  ClaudeTeamClaimSkip,
} from '@pierre-review/shared';
import { aiProviderName } from '@pierre-review/shared';
import { isRateLimitError } from '../../github/client.js';
import { noteLimited } from '../../github/rate-budget.js';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';
import type { AutoPostOutcome } from './auto-post.js';
import {
  openClaimLinesAtHead,
  recordClaimIntent,
  releaseClaimLinesAtHead,
  setClaimLine,
} from './team-claim-ledger.js';
import { forgetTeammateLine, recordTeammateLine, teammateLinesAtHead } from './team-claim-seen.js';

/** How long a pending line holds the head after its claimant's NEWEST line. */
export const TEAM_CLAIM_LEASE_MS = 25 * 60 * 1000;
/** A running review re-posts its pending line this often (well inside the lease). */
export const TEAM_CLAIM_RENEW_MS = 8 * 60 * 1000;
/** A head a teammate already reviewed is read again after this long (they may Clear it). */
export const TEAM_CLAIM_REVIEWED_RECHECK_MS = 30 * 60 * 1000;
/** GitHub caps a status description at 140 characters. */
export const TEAM_CLAIM_DESCRIPTION_MAX = 140;

const FREE_PHRASE = 'free to claim';
const CLEARED_PREFIX = 'Cleared by ';
const RELEASED_PREFIX = 'Released: ';

/** The status context for a provider family. */
export function teamClaimContext(provider: AiProviderId): string {
  return provider === 'codex' ? 'limn/review-codex' : 'limn/review-claude';
}

const clamp = (s: string): string =>
  s.length <= TEAM_CLAIM_DESCRIPTION_MAX ? s : `${s.slice(0, TEAM_CLAIM_DESCRIPTION_MAX - 1)}…`;

export function reviewingLine(login: string, provider: AiProviderId): string {
  return clamp(`${login} is reviewing with ${aiProviderName(provider)}`);
}
/**
 * THE "REVIEWED" LINE. `comments`: this model's findings the post put on GitHub (0 = a review went
 * out with none of them: an approval, a reason-only comment, the other half's findings). ⚠ null =
 * the run put NOTHING on GitHub (no review at all): "kept in Limn", which every Limn reads as FREE.
 * Gap 12 (2026-11-05): a review that DID reach GitHub is never "kept in Limn" — it holds the commit.
 * `verdict`: the event GitHub took ("approved" / "changes requested" lead the detail); a COMMENT adds
 * nothing.
 */
export function reviewedLine(login: string, comments: number | null, verdict: ClaudeReviewVerdict | null = null): string {
  if (comments == null) return clamp(`${login} reviewed · kept in Limn`);
  const count = `${comments === 0 ? 'no' : comments} comment${comments === 1 ? '' : 's'}`;
  if (verdict === 'APPROVE') return clamp(`${login} reviewed · approved${comments > 0 ? ` · ${count}` : ''}`);
  if (verdict === 'REQUEST_CHANGES') return clamp(`${login} reviewed · changes requested · ${count}`);
  return clamp(`${login} reviewed · ${count}`);
}
/** The release line for a run of ours that did not finish (a failure, a Stop, a dropped run). */
export function unfinishedLine(login: string): string {
  return clamp(`${CLEARED_PREFIX}${login}: review didn't finish · ${FREE_PHRASE}`);
}
export function clearedLine(login: string): string {
  return clamp(`${CLEARED_PREFIX}${login}`);
}
/**
 * WHAT ONE RUN'S "REVIEWED" LINE SAYS (pure; `reviewedLine`). ⚠ GAP 12 (2026-11-05):
 * "kept in Limn" (comments null, read as FREE) ONLY when the run put NOTHING on GitHub. A review that
 * went out — an approval, a reason-only comment, a pair's one review holding only the other half's
 * findings — is a success that holds the commit: this run's posted findings (0 ⇒ "no comments") and
 * the verdict GitHub took. A run with nothing to say at all also reads "no comments", posted or not.
 */
export function reviewedLineSummary(
  out: AutoPostOutcome | null,
  review: { findings: ReadonlyArray<{ id: number; severity: string }> } | null,
): { comments: number | null; verdict: ClaudeReviewVerdict | null; onGithub: boolean } {
  const rec = out?.kind === 'done' ? out.record : null;
  if (rec != null && rec.githubReviewId != null) {
    const posted = new Set(rec.postedFindingIds);
    const mine = review ? review.findings.filter((f) => posted.has(f.id)).length : 0;
    return { comments: mine, verdict: rec.verdict?.submitted ?? null, onGithub: true };
  }
  if (review && review.findings.filter((f) => f.severity !== 'praise').length === 0) {
    return { comments: 0, verdict: null, onGithub: false };
  }
  return { comments: null, verdict: null, onGithub: false };
}

/** A teammate's expired (or older Limn's pending "free to claim") line, released by `by` (the reader). */
export function releasedLine(login: string, by: string): string {
  return clamp(`${CLEARED_PREFIX}${by}: ${login}'s claim expired`);
}

/** Why this Limn did not start an auto review it would otherwise run (team-claim-skip.ts). */
export type AutoSkipReason = 'budget' | 'daily_cap' | 'usage_limit' | 'not_ready';
/** The phrase every skipped line carries; the fold reads a success with it as FREE. */
export const SKIPPED_PHRASE = ' skipped · ';

/** "HH:MM" on the reader's clock, with the weekday when it is not today. */
function clockTime(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (new Date(nowMs).toDateString() === d.toDateString()) return hm;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`;
}

/**
 * THE SKIPPED LINE: "Cleared by alex: auto review skipped · AI budget used". ⚠ It starts "Cleared by "
 * like every free success line, so a teammate's older Limn reads it as free too (any other success
 * by someone else reads "already reviewed" there). `untilMs`: when a usage limit ends, if known.
 * `notSetUp`: AI is not installed (else not signed in).
 */
export function skippedLine(
  login: string,
  reason: AutoSkipReason,
  provider: AiProviderId,
  opts: { untilMs?: number | null; notSetUp?: boolean; nowMs?: number } = {},
): string {
  const who = aiProviderName(provider);
  const why =
    reason === 'budget'
      ? 'AI budget used'
      : reason === 'daily_cap'
        ? 'daily auto-review limit reached'
        : reason === 'usage_limit'
          ? `${who} over its usage limit${opts.untilMs != null ? ` until ${clockTime(opts.untilMs, opts.nowMs ?? Date.now())}` : ''}`
          : `${who} ${opts.notSetUp ? 'not set up' : 'not signed in'}`;
  return clamp(`${CLEARED_PREFIX}${login}: auto review${SKIPPED_PHRASE}${why}`);
}

/** One status line of ONE context, as GitHub lists it. */
export interface TeamClaimLine {
  id: number;
  state: string; // pending | success | failure | error
  description: string | null;
  createdAtMs: number;
  login: string | null; // the line's creator
}

// A FREE line: a success starting "Cleared by " (a Clear, a release of ours or of a teammate's expired
// line), a success "free to claim" or "Released:" (a 2026-10-28 build's wording), or a pending "free to
// claim" (older Limn versions). A SKIPPED line ("… skipped · …", team-claim-skip.ts) reviewed nothing,
// so it is free whatever its prefix.
// A teammate's review KEPT IN LIMN put nothing on GitHub: the team got nothing from it, so it holds
// nothing (2026-11-03 — robin-dunn's kept-in-Limn Claude reviews held six PRs, the pair fell back to a
// Codex over its usage limit, and nobody got a review).
const KEPT_PHRASE = ' reviewed · kept in Limn';
const isFreeLine = (l: TeamClaimLine): boolean => {
  const d = l.description ?? '';
  if (l.state === 'pending') return d.includes(FREE_PHRASE);
  if (l.state !== 'success') return false;
  return (
    d.includes(FREE_PHRASE) ||
    d.startsWith(CLEARED_PREFIX) ||
    d.startsWith(RELEASED_PREFIX) ||
    d.endsWith(KEPT_PHRASE) ||
    d.includes(SKIPPED_PHRASE)
  );
};
/** Is this line FREE — it holds nothing (a Clear, a release, a kept-in-Limn review, a skipped line)? */
export function isFreeTeamClaimLine(l: TeamClaimLine): boolean {
  return isFreeLine(l);
}
const settles = (l: TeamClaimLine): boolean => l.state !== 'pending' || isFreeLine(l);
const sameLogin = (a: string | null, b: string | null): boolean =>
  a != null && b != null && a.toLowerCase() === b.toLowerCase();
const order = (a: TeamClaimLine, b: TeamClaimLine): number => a.createdAtMs - b.createdAtMs || a.id - b.id;

export type TeamClaimDecision =
  | { kind: 'free' }
  // The reader's own live claim (a restart mid-run, another of their machines): theirs to take.
  | { kind: 'mine' }
  // `description`: their success line as GitHub shows it ("robin-dunn reviewed · no comments").
  | { kind: 'reviewed'; login: string; atMs: number; description: string | null }
  | {
      kind: 'reviewing';
      login: string;
      // The holder's first line in this race (the "earliest wins" key) and its newest (the lease).
      firstAtMs: number;
      leaseEndsAtMs: number;
      // The holder's own description, for a loser's re-post.
      description: string | null;
    };

/** A teammate's Limn review already on GitHub at this head, for this provider (from the sync import). */
export interface PostedTeammateReview {
  login: string;
  postedAtMs: number;
}

/** The description of a success line made from a posted review (never posted; read by the tab). */
export function postedReviewLine(login: string): string {
  return clamp(`${login} reviewed · posted on GitHub`);
}

/**
 * A POSTED REVIEW SETTLES ITS POSTER'S CLAIM (pure). For each teammate (never `me`, never the PR
 * `author`) whose OPEN claim — their pending lines after their own last settling line — began at or
 * before their review was posted at this head, add their success line, placed right after the later
 * of the post and their newest line: their claim is finished, the same as if their Limn had written
 * "reviewed". A claimant with no open claim, or a review posted before the claim began (an earlier
 * review), adds nothing. Lines by others after it still decide as usual (a Clear frees the head).
 */
export function withPostedReviews(
  lines: readonly TeamClaimLine[],
  posted: readonly PostedTeammateReview[],
  me: string | null,
  author: string | null = null,
): TeamClaimLine[] {
  if (posted.length === 0) return [...lines];
  const sorted = [...lines].sort(order);
  const out = [...lines];
  const done = new Set<string>();
  for (const p of posted) {
    const k = p.login.toLowerCase();
    if (done.has(k) || sameLogin(p.login, me) || sameLogin(p.login, author)) continue;
    const theirs = sorted.filter((l) => sameLogin(l.login, p.login));
    let lastSettled = -1;
    for (let i = theirs.length - 1; i >= 0; i -= 1) {
      if (settles(theirs[i]!)) {
        lastSettled = i;
        break;
      }
    }
    const open = theirs.slice(lastSettled + 1);
    if (open.length === 0) continue;
    // Every review of theirs at this head posted since the claim began counts; the first one settles it.
    const claimStart = open[0]!.createdAtMs;
    const settling = posted
      .filter((x) => sameLogin(x.login, p.login) && x.postedAtMs >= claimStart)
      .sort((a, b) => a.postedAtMs - b.postedAtMs)[0];
    if (!settling) continue;
    done.add(k);
    out.push({
      // After every real line at the same millisecond.
      id: Number.MAX_SAFE_INTEGER - out.length,
      state: 'success',
      description: postedReviewLine(open[0]!.login ?? p.login),
      createdAtMs: Math.max(settling.postedAtMs, open[open.length - 1]!.createdAtMs),
      login: open[0]!.login ?? p.login,
    });
  }
  return out;
}

/**
 * THE ONE FOLD over one context's history (any order). Pure. `me` is the reader's GitHub login.
 *
 * `author`: the PR author's GitHub login. ⚠ THE AUTHOR'S OWN REVIEW NEVER HOLDS A HEAD (2026-11-03):
 * the author cannot approve their own PR, so their Limn's lines (pending or done) are left out of the
 * fold and the reader's Limn still reviews — a follow-up on the author's posted review (manager.ts,
 * teammate-anchor.ts). A non-author teammate's lines hold exactly as before. When the READER is the
 * author, nothing is left out (their own lines are the race they are in).
 *
 * `posted`: teammates' Limn reviews already on GitHub at this head for this provider. A claimant's
 * posted review FINISHES their open claim (`withPostedReviews`) — "already reviewed", never a wait for
 * the lease.
 */
export function decideTeamClaim(
  lines: readonly TeamClaimLine[],
  me: string | null,
  nowMs: number,
  author: string | null = null,
  posted: readonly PostedTeammateReview[] = [],
): TeamClaimDecision {
  if (author != null && !sameLogin(author, me)) lines = lines.filter((l) => !sameLogin(l.login, author));
  if (lines.length === 0) return { kind: 'free' };
  if (posted.length > 0) lines = withPostedReviews(lines, posted, me, author);
  const sorted = [...lines].sort(order);
  const last = sorted[sorted.length - 1]!;
  if (last.state === 'success') {
    if (isFreeLine(last) || sameLogin(last.login, me) || last.login == null) return { kind: 'free' };
    return { kind: 'reviewed', login: last.login, atMs: last.createdAtMs, description: last.description };
  }
  if (settles(last)) return { kind: 'free' };
  // Under a pending line: the race since the last settling line.
  let from = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (settles(sorted[i]!)) {
      from = i + 1;
      break;
    }
  }
  const byClaimant = new Map<string, { first: TeamClaimLine; newest: TeamClaimLine }>();
  for (const l of sorted.slice(from)) {
    if (l.login == null) continue;
    const k = l.login.toLowerCase();
    const prev = byClaimant.get(k);
    if (prev) prev.newest = l;
    else byClaimant.set(k, { first: l, newest: l });
  }
  let holder: { first: TeamClaimLine; newest: TeamClaimLine } | null = null;
  for (const c of byClaimant.values()) {
    if (c.newest.createdAtMs + TEAM_CLAIM_LEASE_MS <= nowMs) continue; // lapsed
    if (!holder || order(c.first, holder.first) < 0) holder = c;
  }
  if (!holder) return { kind: 'free' };
  if (sameLogin(holder.first.login, me)) return { kind: 'mine' };
  return {
    kind: 'reviewing',
    login: holder.first.login!,
    firstAtMs: holder.first.createdAtMs,
    leaseEndsAtMs: holder.newest.createdAtMs + TEAM_CLAIM_LEASE_MS,
    description: holder.first.description,
  };
}

/** The newest line of one context's history (any order), or null. */
export function newestLine(lines: readonly TeamClaimLine[]): TeamClaimLine | null {
  return lines.length === 0 ? null : [...lines].sort(order)[lines.length - 1]!;
}

/** Same GitHub login (case-insensitive; null never matches). */
export function sameGithubLogin(a: string | null, b: string | null): boolean {
  return sameLogin(a, b);
}

/**
 * A TEAMMATE'S STALE LINE (pure): the newest line is a teammate's PENDING one that no longer holds the
 * head — past its lease, or an older Limn's pending "free to claim". Its claimant's login, else null
 * (settled, live, or the reader's own).
 */
export function staleTeammateLine(
  lines: readonly TeamClaimLine[],
  me: string | null,
  nowMs: number,
  posted: readonly PostedTeammateReview[] = [],
): { login: string } | null {
  if (lines.length === 0) return null;
  const last = [...lines].sort(order)[lines.length - 1]!;
  if (last.state !== 'pending' || last.login == null || sameLogin(last.login, me)) return null;
  if (isFreeLine(last)) return { login: last.login };
  // A claimant whose review is already on GitHub finished: not stale, never "claim expired".
  return decideTeamClaim(lines, me, nowMs, null, posted).kind === 'free' ? { login: last.login } : null;
}

// ---- GitHub ----

export interface TeamClaimPost {
  state: 'pending' | 'success';
  description: string;
  targetUrl?: string | null;
}

/** The outside world, replaceable in tests. Every method may throw. */
export interface TeamClaimGithub {
  /** Every status line of `context` on `sha` (GitHub lists newest first; any order is fine). */
  listLines(accountId: number, owner: string, name: string, sha: string, context: string): Promise<TeamClaimLine[]>;
  postLine(accountId: number, owner: string, name: string, sha: string, context: string, post: TeamClaimPost): Promise<void>;
  /** The reader's GitHub login. */
  login(accountId: number): Promise<string | null>;
}

const MAX_STATUS_PAGES = 10; // GitHub keeps at most 1,000 statuses per (sha, context)

export const defaultTeamClaimGithub: TeamClaimGithub = {
  async listLines(accountId, owner, name, sha, context) {
    const { getAccessToken } = await import('../../auth/account.js');
    const { ghRestGetFor } = await import('../../github/client.js');
    const token = await getAccessToken(accountId);
    const out: TeamClaimLine[] = [];
    for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
      const rows = await ghRestGetFor<
        Array<{ id: number; state: string; description: string | null; context: string; created_at: string; creator: { login: string } | null }>
      >(token, `/repos/${enc(owner)}/${enc(name)}/commits/${enc(sha)}/statuses?per_page=100&page=${page}`);
      for (const r of rows) {
        if (r.context !== context) continue;
        const at = Date.parse(r.created_at);
        if (!Number.isFinite(at)) continue;
        out.push({ id: r.id, state: r.state, description: r.description, createdAtMs: at, login: r.creator?.login ?? null });
      }
      if (rows.length < 100) break;
    }
    return out;
  },
  async postLine(accountId, owner, name, sha, context, post) {
    const { getAccessToken } = await import('../../auth/account.js');
    const { ghRestPostFor } = await import('../../github/client.js');
    const token = await getAccessToken(accountId);
    await ghRestPostFor(token, `/repos/${enc(owner)}/${enc(name)}/statuses/${enc(sha)}`, {
      state: post.state,
      context,
      description: clamp(post.description),
      ...(post.targetUrl ? { target_url: post.targetUrl } : {}),
    });
  },
  async login(accountId) {
    // ⚠ UNDER TEST the real adapter never reaches GitHub: the switch is ON by default (0159), so every
    // auto run in a test would otherwise read and write real commit statuses. No login ⇒ the run goes
    // ahead without a line. Tests of the claim pass their own fake adapter.
    if (process.env.VITEST) return null;
    const { accountGithubLogin } = await import('../../db/review-threads-for-review.js');
    return accountGithubLogin(accountId);
  },
};

const enc = (s: string): string => encodeURIComponent(s);

/**
 * A write GitHub refused for lack of access (403 / 404): run without a line, never retry.
 * ⚠ A RATE LIMIT is NOT lack of access, though GitHub answers both primary and secondary limits
 * with a 403: `isRateLimitError` is asked first, so a limited call never reads "no write access".
 */
export function isNoAccessError(err: unknown): boolean {
  if (isRateLimitError(err).limited) return false;
  const status = (err as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

/**
 * Why a status call failed, as the run record and the Clear route word it. A rate limit is ALSO
 * told to the account's rate budget (`noteLimited`), so later GitHub calls wait instead of hitting
 * it again.
 */
export function claimErrorKind(err: unknown, accountId: number): 'rate_limited' | 'no_access' | 'error' {
  const rl = isRateLimitError(err);
  if (rl.limited) {
    noteLimited(accountId, rl.resumeAt);
    return 'rate_limited';
  }
  return isNoAccessError(err) ? 'no_access' : 'error';
}

/** The run record's reason for a failed status call (a rate limit is an 'error', not 'no_access'). */
const unmarkedReason = (err: unknown, accountId: number): 'no_access' | 'error' =>
  claimErrorKind(err, accountId) === 'no_access' ? 'no_access' : 'error';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The posted GitHub review's page, or null. Built from our own stored values and validated. */
export function postedReviewUrl(owner: string, name: string, number: number, githubReviewId: string | null): string | null {
  if (!githubReviewId || !/^\d+$/.test(githubReviewId)) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || !Number.isInteger(number) || number <= 0) {
    return null;
  }
  return `https://github.com/${owner}/${name}/pull/${number}#pullrequestreview-${githubReviewId}`;
}

// ---- the skip memory (in process; a restart forgets it) ----

interface SkipEntry {
  skip: ClaudeTeamClaimSkip;
  recheckAtMs: number;
}
// ⚠ PER PROVIDER (2026-11-02): a pair's Claude half skipped for a teammate must stay remembered while
// its Codex half claims and runs (one key per PR forgot it, and the tab showed nothing).
const skips = new Map<string, SkipEntry>(); // `${accountId}:${prId}:${provider}`
const skipKey = (accountId: number, prId: number, provider: AiProviderId): string => `${accountId}:${prId}:${provider}`;
const prPrefix = (accountId: number, prId: number): string => `${accountId}:${prId}:`;

/** Test hook. */
export function _resetTeamClaimsForTest(): void {
  skips.clear();
  finishing.clear();
}

/** The PR's remembered skips (every provider), Claude's first. */
function skipsOfPr(accountId: number, prId: number): SkipEntry[] {
  const pre = prPrefix(accountId, prId);
  return [...skips.entries()]
    .filter(([k]) => k.startsWith(pre))
    .map(([, e]) => e)
    .sort((a, b) => (a.skip.provider === b.skip.provider ? 0 : a.skip.provider === 'claude' ? -1 : 1));
}

/** The remembered skip for this PR at `headSha` (any head when `headSha` is null); Claude's first. */
export function teamClaimSkipFor(accountId: number, prId: number, headSha: string | null): ClaudeTeamClaimSkip | null {
  for (const e of skipsOfPr(accountId, prId)) {
    if (headSha == null || e.skip.headSha === headSha) return e.skip;
  }
  return null;
}

/** Skips for a list of PRs at their current heads (the Open PRs line). */
export function teamClaimSkipsFor(
  accountId: number,
  heads: ReadonlyArray<{ prId: number; headSha: string | null }>,
): Array<ClaudeTeamClaimSkip & { prId: number }> {
  const out: Array<ClaudeTeamClaimSkip & { prId: number }> = [];
  for (const h of heads) {
    const s = h.headSha ? teamClaimSkipFor(accountId, h.prId, h.headSha) : null;
    if (s) out.push({ prId: h.prId, ...s });
  }
  return out;
}

/**
 * The head a remembered skip is still WAITING on (before its recheck time), or null. The sweeper
 * asks this so a held PR does not take a place in the lane (and the daily-cap budget of a tick)
 * every minute only to be dropped again; it compares the head with the synced one.
 */
export function teamClaimHeldHead(accountId: number, prId: number, nowMs: number): string | null {
  const e = skipsOfPr(accountId, prId).find((x) => nowMs < x.recheckAtMs);
  return e ? e.skip.headSha : null;
}

/** Remembered "being reviewed" skips whose holder's lease has ended (the reconciler's teammate pass). */
export function expiredReviewingSkips(nowMs: number): Array<{ accountId: number; prId: number; skip: ClaudeTeamClaimSkip }> {
  const out: Array<{ accountId: number; prId: number; skip: ClaudeTeamClaimSkip }> = [];
  for (const [key, e] of skips) {
    if (e.skip.kind !== 'reviewing' || nowMs < e.recheckAtMs) continue;
    const [a, p] = key.split(':');
    out.push({ accountId: Number(a), prId: Number(p), skip: e.skip });
  }
  return out;
}

/** Forget a remembered skip (the reconciler, once the teammate's line is settled). No provider ⇒ all. */
export function forgetTeamClaimSkip(accountId: number, prId: number, provider?: AiProviderId): void {
  if (provider) {
    forgetSkip(accountId, prId, provider);
    return;
  }
  const pre = prPrefix(accountId, prId);
  for (const k of [...skips.keys()]) if (k.startsWith(pre)) skips.delete(k);
}

function rememberSkip(accountId: number, prId: number, skip: ClaudeTeamClaimSkip, recheckAtMs: number): void {
  skips.set(skipKey(accountId, prId, skip.provider), { skip, recheckAtMs });
}
function forgetSkip(accountId: number, prId: number, provider: AiProviderId): void {
  skips.delete(skipKey(accountId, prId, provider));
}

// ---- the workspace switch ----

/** Is "Mark auto reviews on GitHub" on for the workspace holding this PR's repo? ON unless a stored
 *  false (migration 0159). A repo in no workspace reads OFF. */
export async function teamClaimsOnForPr(ctx: AgentContext, accountId: number, prId: number): Promise<boolean> {
  const { workspaces: w, workspaceRepos: wr, pullRequests: prs } = ctx.schema;
  if (!w?.teamClaimsEnabled) return false;
  const rows = (await ctx.db
    .select({ on: w.teamClaimsEnabled })
    .from(prs)
    .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
    .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ on: boolean | null }>;
  return rows.length > 0 && rows[0]!.on !== false;
}

// ---- the lifecycle ----

export interface TeamClaimTarget {
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  number: number;
  headSha: string;
  provider: AiProviderId;
  // The PR author's GitHub login (their own Limn's lines never hold the head). Absent ⇒ read from
  // the synced PR (`prAuthorLogin`); null ⇒ unknown, nothing is left out.
  authorLogin?: string | null;
}

/** The PR author's GitHub login, from the synced PR (account-scoped). null when unknown. Never throws. */
export async function prAuthorLogin(ctx: AgentContext, accountId: number, prId: number): Promise<string | null> {
  try {
    const { pullRequests: prs, users } = ctx.schema;
    if (!prs?.authorId || !users?.githubLogin) return null;
    const rows = (await ctx.db
      .select({ login: users.githubLogin })
      .from(prs)
      .innerJoin(users, eq(users.id, prs.authorId))
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ login: string | null }>;
    return rows[0]?.login ?? null;
  } catch {
    return null;
  }
}

/**
 * Teammates' Limn reviews ALREADY ON GITHUB at `headSha` for `provider` (DB only — the sync import,
 * db/teammate-reviews-import.ts; `claude_reviews.kind = 'teammate'`): the poster's login and when it
 * was posted. Only a review whose marker named the head (`h=`, never an inferred head) and whose run(s)
 * include the provider (a pair covers both). The import leaves the reader's own out. [] on any error:
 * the fold then decides from the lines alone, as before. Never throws.
 */
export async function postedTeammateReviewsAtHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
  provider: AiProviderId,
): Promise<PostedTeammateReview[]> {
  try {
    const { claudeReviews: cr, users } = ctx.schema;
    if (!cr?.sourceUserId || !users?.githubLogin) return [];
    const rows = (await ctx.db
      .select({ login: users.githubLogin, postedAt: cr.postedAt, teammate: cr.teammate })
      .from(cr)
      .innerJoin(users, eq(users.id, cr.sourceUserId))
      .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.headSha, headSha), eq(cr.kind, 'teammate')))
      .execute()) as Array<{
      login: string | null;
      postedAt: Date | number | null;
      teammate: { headInferred?: boolean; runs?: Array<{ provider: string | null }> } | null;
    }>;
    const out: PostedTeammateReview[] = [];
    for (const r of rows) {
      if (!r.login || r.postedAt == null || r.teammate == null || r.teammate.headInferred !== false) continue;
      if (!(r.teammate.runs ?? []).some((x) => x.provider === provider)) continue;
      const at = r.postedAt instanceof Date ? r.postedAt.getTime() : Number(r.postedAt);
      if (Number.isFinite(at)) out.push({ login: r.login, postedAtMs: at });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Has the holder of a remembered "being reviewed" skip already posted their review at its head (DB
 * only)? Then the skip must not wait out the lease: the claim is read again and folds as "reviewed".
 */
async function holderPosted(ctx: AgentContext, accountId: number, prId: number, skip: ClaudeTeamClaimSkip): Promise<boolean> {
  if (skip.kind !== 'reviewing') return false;
  const since = Date.parse(skip.at);
  const posted = await postedTeammateReviewsAtHead(ctx, accountId, prId, skip.headSha, skip.provider);
  return posted.some((p) => sameLogin(p.login, skip.login) && (!Number.isFinite(since) || p.postedAtMs >= since));
}

/**
 * `teamClaimHeldHead`, unless the holder of a "being reviewed" skip has already posted their review at
 * that head: then null, so the sweeper takes the PR now and the claim folds it as "reviewed" (one
 * GitHub read) instead of waiting for the lease to end. DB + memory. Never throws.
 */
export async function teamClaimHeldHeadNow(ctx: AgentContext, accountId: number, prId: number, nowMs: number): Promise<string | null> {
  const e = skipsOfPr(accountId, prId).find((x) => nowMs < x.recheckAtMs);
  if (!e) return null;
  for (const x of skipsOfPr(accountId, prId)) {
    if (nowMs < x.recheckAtMs && (await holderPosted(ctx, accountId, prId, x.skip).catch(() => false))) return null;
  }
  return e.skip.headSha;
}

/** A claim this run holds (or a run that went ahead without one: `record.state === 'unmarked'`). */
export interface TeamClaimHandle {
  target: TeamClaimTarget;
  login: string;
  record: ClaudeTeamClaimRecord;
  /** Only a 'marked' claim posts more lines. */
  marked: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** The ledger row (`team_claim_lines`) written before the pending line; null when none was. */
  ledgerId?: number | null;
}

// ---- lines being finished in this process (the reconciler leaves them alone) ----

// ledger id → when its run ended (its final line is being written: the auto-post it waits for may take
// a while). Bounded: after FINISHING_MAX_MS the reconciler no longer waits for it.
const finishing = new Map<number, number>();
const FINISHING_MAX_MS = 30 * 60 * 1000;

/** Is this ledger row's final line being written by this process right now? */
export function claimLineFinishing(ledgerId: number, nowMs: number = Date.now()): boolean {
  const since = finishing.get(ledgerId);
  return since != null && nowMs - since < FINISHING_MAX_MS;
}

// ---- releases in flight (a claim at that head waits for them) ----

// `${accountId}:${prId}:${headSha}:${provider}` → the reconciler's release of OUR line there, in flight.
// A claim starting at that head waits for it before reading GitHub, so the release can never land
// AFTER the claim's fresh pending line and free a head that is being reviewed.
const releasesInFlight = new Map<string, Promise<unknown>>();
const releaseKey = (accountId: number, prId: number, headSha: string, provider: AiProviderId): string =>
  `${accountId}:${prId}:${headSha}:${provider}`;

/**
 * Run `release` registered as in flight for this head and provider. ⚠ Registered SYNCHRONOUSLY: the
 * caller's last "is a run busy here?" check and this call must have no `await` between them.
 */
export function trackClaimRelease<T>(
  where: { accountId: number; prId: number; headSha: string; provider: AiProviderId },
  release: () => Promise<T>,
): Promise<T> {
  const key = releaseKey(where.accountId, where.prId, where.headSha, where.provider);
  const p = release();
  releasesInFlight.set(key, p);
  const done = () => {
    if (releasesInFlight.get(key) === p) releasesInFlight.delete(key);
  };
  p.then(done, done);
  return p;
}

/** Wait for a release of our line at this head and provider, if one is in flight (never throws). */
export async function waitForClaimRelease(accountId: number, prId: number, headSha: string, provider: AiProviderId): Promise<void> {
  const p = releasesInFlight.get(releaseKey(accountId, prId, headSha, provider));
  if (p) await p.catch(() => {});
}

export type TeamClaimStart =
  // The switch is off: run as before, no record.
  | { kind: 'off' }
  // Run; `handle` carries the record (marked, or unmarked and why).
  | { kind: 'run'; handle: TeamClaimHandle }
  // A teammate holds the head: do NOT run (no row). Remembered for the tab.
  | { kind: 'skip'; skip: ClaudeTeamClaimSkip };

const nowIso = (ms: number): string => new Date(ms).toISOString();

/**
 * Steps 1-2 (header): read, decide, claim, re-read, arbitrate. Never throws. `pressed`: the reader's
 * press reads GitHub afresh even when a remembered skip says to wait.
 */
export async function claimBeforeAutoRun(
  ctx: AgentContext,
  target: TeamClaimTarget,
  opts: { pressed?: boolean; nowMs?: () => number } = {},
  gh: TeamClaimGithub = defaultTeamClaimGithub,
): Promise<TeamClaimStart> {
  const now = opts.nowMs ?? Date.now;
  const { accountId, prId, owner, name, headSha, provider } = target;
  try {
    if (!(await teamClaimsOnForPr(ctx, accountId, prId))) return { kind: 'off' };
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: switch unreadable: ${errText(err)}`);
    return { kind: 'off' };
  }
  const context = teamClaimContext(provider);
  const unmarked = (login: string, reason: 'no_access' | 'error'): TeamClaimStart => ({
    kind: 'run',
    handle: {
      target,
      login,
      marked: false,
      timer: null,
      record: { context, state: 'unmarked', reason, lastLine: null, at: nowIso(now()) },
    },
  });

  // A remembered skip at this head and provider, still inside its wait: skip without a GitHub read.
  // ⚠ Not when the holder of a "being reviewed" skip has posted their review since: read it again.
  const mem = skips.get(skipKey(accountId, prId, provider));
  if (mem && mem.skip.headSha === headSha && !opts.pressed && now() < mem.recheckAtMs) {
    if (!(await holderPosted(ctx, accountId, prId, mem.skip))) return { kind: 'skip', skip: mem.skip };
  }

  let login: string | null = null;
  try {
    login = await gh.login(accountId);
  } catch {
    login = null;
  }
  if (!login) {
    ctx.log.warn(`team claim pr ${prId}: no GitHub login known; reviewing without a line`);
    return unmarked('unknown', 'error');
  }

  // A release of our own older line at this head is being written: let it land first, so this claim's
  // pending line is the newer one.
  await waitForClaimRelease(accountId, prId, headSha, provider);

  // STEP 1 — read and decide.
  let lines: TeamClaimLine[];
  try {
    lines = await gh.listLines(accountId, owner, name, headSha, context);
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: statuses unreadable (${errText(err)}); reviewing without a line`);
    return unmarked(login, unmarkedReason(err, accountId));
  }
  // The PR author's own lines never hold the head (`decideTeamClaim`).
  const author = target.authorLogin !== undefined ? target.authorLogin : await prAuthorLogin(ctx, accountId, prId);
  // A teammate whose review is already on GitHub here has finished, whatever their line says.
  const posted = await postedTeammateReviewsAtHead(ctx, accountId, prId, headSha, provider);
  const first = decideTeamClaim(lines, login, now(), author, posted);
  const skipOf = (d: Extract<TeamClaimDecision, { kind: 'reviewed' | 'reviewing' }>): TeamClaimStart => {
    const skip: ClaudeTeamClaimSkip = {
      provider,
      kind: d.kind,
      login: d.login,
      headSha,
      at: nowIso(d.kind === 'reviewed' ? d.atMs : d.firstAtMs),
      description: d.description,
    };
    // DURABLE for the tab (team_claim_seen): a reload or a restart still names the teammate.
    void recordTeammateLine(ctx, accountId, prId, skip).catch((err) =>
      ctx.log.warn(`team claim pr ${prId}: teammate line not recorded: ${errText(err)}`),
    );
    rememberSkip(
      accountId,
      prId,
      skip,
      d.kind === 'reviewed' ? now() + TEAM_CLAIM_REVIEWED_RECHECK_MS : d.leaseEndsAtMs + 30_000,
    );
    return { kind: 'skip', skip };
  };
  if (first.kind === 'reviewed' || first.kind === 'reviewing') return skipOf(first);
  forgetSkip(accountId, prId, provider);
  // The head is free (or ours) now: a teammate's line the tab named here is no longer the newest one,
  // so it must not sit beside this machine's own review ("Robin Dunn is reviewing…" forever).
  void forgetTeammateLine(ctx, accountId, prId, headSha, provider).catch(() => {});

  // STEP 2 — claim, then re-read: the earliest live claimant wins.
  // ⚠ THE LEDGER FIRST: the intent is written BEFORE the pending line is posted, so a line that reaches
  // GitHub always has a row the reconciler can release. No row ⇒ no line (the run goes ahead unmarked).
  let ledgerId: number;
  try {
    ledgerId = await recordClaimIntent(ctx, { accountId, prId, headSha, provider, login, owner, name });
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: ledger not written (${errText(err)}); reviewing without a line`);
    return unmarked(login, 'error');
  }
  const description = reviewingLine(login, provider);
  try {
    await gh.postLine(accountId, owner, name, headSha, context, { state: 'pending', description });
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: status not written (${errText(err)}); reviewing without a line`);
    const kind = claimErrorKind(err, accountId);
    // Refused (no access) or rate-limited: GitHub wrote nothing, so there is nothing to release. Any
    // other failure may have landed: the row stays 'claiming' and the reconciler releases it once the
    // run is over.
    await setClaimLine(
      ctx,
      ledgerId,
      kind === 'error' ? { lastError: errText(err) } : { state: 'released', lastError: kind },
    ).catch(() => {});
    const out = unmarked(login, kind === 'no_access' ? 'no_access' : 'error');
    if (out.kind === 'run' && kind === 'error') out.handle.ledgerId = ledgerId;
    return out;
  }
  await setClaimLine(ctx, ledgerId, { state: 'pending' }).catch((err) =>
    ctx.log.warn(`team claim pr ${prId}: ledger not moved on: ${errText(err)}`),
  );
  const marked = (): TeamClaimStart => ({
    kind: 'run',
    handle: {
      target,
      login,
      marked: true,
      timer: null,
      ledgerId,
      record: { context, state: 'marked', reason: null, lastLine: 'reviewing', at: nowIso(now()) },
    },
  });
  let after: TeamClaimLine[];
  try {
    after = await gh.listLines(accountId, owner, name, headSha, context);
  } catch {
    return marked(); // our line is up; nothing says anyone else's is earlier
  }
  const second = decideTeamClaim(after, login, now(), author, posted);
  if (second.kind !== 'reviewing' && second.kind !== 'reviewed') return marked();
  // We lost: stand down. Under a pending race, re-post the winner's line so GitHub's displayed
  // latest line names them (a success that landed after ours is already the latest line). Our row is
  // closed: the line is the winner's to finish now.
  await setClaimLine(ctx, ledgerId, { state: 'released', lastError: 'stood down' }).catch(() => {});
  if (second.kind === 'reviewing') {
    try {
      await gh.postLine(accountId, owner, name, headSha, context, {
        state: 'pending',
        description: second.description ?? reviewingLine(second.login, provider),
      });
    } catch (err) {
      ctx.log.warn(`team claim pr ${prId}: stand-down line not written: ${errText(err)}`);
    }
  }
  return skipOf(second);
}

/** Step 3: renew the pending line while the run goes. The timer is cleared by `finishTeamClaim`. */
export function startTeamClaimRenew(ctx: AgentContext, handle: TeamClaimHandle, gh: TeamClaimGithub = defaultTeamClaimGithub): void {
  if (!handle.marked || handle.timer) return;
  const { accountId, prId, owner, name, headSha, provider } = handle.target;
  handle.timer = setInterval(() => {
    void gh
      .postLine(accountId, owner, name, headSha, teamClaimContext(provider), {
        state: 'pending',
        description: reviewingLine(handle.login, provider),
      })
      .catch((err) => ctx.log.warn(`team claim pr ${prId}: renew not written: ${errText(err)}`));
  }, TEAM_CLAIM_RENEW_MS);
  handle.timer.unref?.();
}

/**
 * Stop the renew timer (every exit path). The run is over: its final line is being written by this
 * process (`finishTeamClaim`, possibly after the auto-post), so the reconciler leaves its row alone
 * until then.
 */
export function stopTeamClaimRenew(handle: TeamClaimHandle): void {
  if (handle.timer) clearInterval(handle.timer);
  handle.timer = null;
  if (handle.ledgerId != null && !finishing.has(handle.ledgerId)) finishing.set(handle.ledgerId, Date.now());
}

export type TeamClaimFinish =
  // `comments`: see `reviewedLine` (null = nothing reached GitHub). `verdict`: the event GitHub took.
  | { kind: 'succeeded'; comments: number | null; reviewUrl: string | null; verdict?: ClaudeReviewVerdict | null }
  | { kind: 'unfinished' };

/**
 * A TEAMMATE HOLDS THE CONTEXT NOW (pure): the fold over the head's lines, as THIS Limn reads them,
 * says a teammate reviewed it (their success is the newest line) or is reviewing it (their claim is the
 * live one). Their login, else null. The PR author's lines never hold (`decideTeamClaim`).
 */
export function teammateHolds(
  lines: readonly TeamClaimLine[],
  me: string | null,
  nowMs: number,
  author: string | null = null,
): string | null {
  const d = decideTeamClaim(lines, me, nowMs, author);
  return d.kind === 'reviewed' || d.kind === 'reviewing' ? d.login : null;
}

/** Read the handle's context and ask `teammateHolds`. null on any read error (post as before). */
async function supersedingTeammate(
  ctx: AgentContext,
  handle: TeamClaimHandle,
  gh: TeamClaimGithub,
  nowMs: number,
): Promise<string | null> {
  const { accountId, prId, owner, name, headSha, provider } = handle.target;
  try {
    const lines = await gh.listLines(accountId, owner, name, headSha, teamClaimContext(provider));
    const author = handle.target.authorLogin !== undefined ? handle.target.authorLogin : await prAuthorLogin(ctx, accountId, prId);
    return teammateHolds(lines, handle.login, nowMs, author);
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: statuses unreadable before the final line (${errText(err)}); posting it`);
    return null;
  }
}

/**
 * Steps 4-5: the final line, and the run row's record. Never throws. A handle that is not marked
 * posts nothing. A finished review ⇒ success "<login> reviewed · …" (ledger 'finished'); anything
 * else (a failure, a Stop, a run that never started) ⇒ the RELEASE line, success "<login>'s review
 * didn't finish · free to claim" (ledger 'released') — never pending, never red. A final line GitHub
 * did not take leaves the ledger row open, and the reconciler (team-claim-release.ts) retries it.
 */
export async function finishTeamClaim(
  ctx: AgentContext,
  handle: TeamClaimHandle,
  reviewId: number | null,
  outcome: TeamClaimFinish,
  gh: TeamClaimGithub = defaultTeamClaimGithub,
  nowMs: () => number = Date.now,
): Promise<void> {
  stopTeamClaimRenew(handle);
  const ledgerId = handle.ledgerId ?? null;
  try {
    if (ledgerId != null && reviewId != null) await setClaimLine(ctx, ledgerId, { reviewId }).catch(() => {});
    if (!handle.marked) {
      // An UNMARKED claim that kept its ledger row: the pending POST failed in a way that may still
      // have landed. Posting nothing here, the reconciler decides from GitHub: no line of ours ⇒
      // nothing to release; our pending line ⇒ THIS outcome's line — the reviewed line for a review
      // that succeeded, never "didn't finish".
      if (ledgerId != null && outcome.kind === 'succeeded') {
        await setClaimLine(ctx, ledgerId, {
          finalDescription: reviewedLine(handle.login, outcome.comments),
          finalTargetUrl: outcome.reviewUrl ?? null,
        }).catch(() => {});
      }
      return;
    }
    const { accountId, prId, owner, name, headSha, provider } = handle.target;
    const post: TeamClaimPost =
      outcome.kind === 'succeeded'
        ? {
            state: 'success',
            description: reviewedLine(handle.login, outcome.comments, outcome.verdict ?? null),
            targetUrl: outcome.reviewUrl,
          }
        : { state: 'success', description: unfinishedLine(handle.login) };
    // ⚠ NEVER BLIND (gap 5, 2026-11-05): a run that slept or crashed may end long after its lease. Read
    // the context first: a teammate's newer success or live claim stands, and nothing is posted (the row
    // is closed as 'superseded'). An unreadable history posts as before — a line left pending is worse.
    const over = await supersedingTeammate(ctx, handle, gh, nowMs());
    if (over != null) {
      ctx.log.info(`team claim pr ${prId}: final line not posted: @${over} has the commit now`);
      handle.record = { ...handle.record, lastLine: 'superseded', at: new Date().toISOString() };
      if (ledgerId != null) {
        await setClaimLine(ctx, ledgerId, {
          state: outcome.kind === 'succeeded' ? 'finished' : 'released',
          lastError: 'superseded',
        }).catch(() => {});
      }
      if (reviewId != null) await saveTeamClaimRecord(ctx, reviewId, handle.record).catch(() => {});
      return;
    }
    try {
      await gh.postLine(accountId, owner, name, headSha, teamClaimContext(provider), post);
      handle.record = {
        ...handle.record,
        lastLine: outcome.kind === 'succeeded' ? 'reviewed' : 'unfinished',
        at: new Date().toISOString(),
      };
      if (ledgerId != null) {
        await setClaimLine(ctx, ledgerId, { state: outcome.kind === 'succeeded' ? 'finished' : 'released', lastError: null }).catch(
          () => {},
        );
      }
    } catch (err) {
      ctx.log.warn(`team claim pr ${prId}: final line not written: ${errText(err)}`);
      if (ledgerId != null) {
        const kind = claimErrorKind(err, accountId);
        await setClaimLine(
          ctx,
          ledgerId,
          kind === 'no_access'
            ? // Our write access went away: nothing more we can post.
              { state: 'released', lastError: 'no_access' }
            : {
                lastError: errText(err),
                // The reconciler posts THIS success line rather than "didn't finish".
                ...(outcome.kind === 'succeeded' ? { finalDescription: post.description, finalTargetUrl: post.targetUrl ?? null } : {}),
              },
        ).catch(() => {});
      }
    }
    if (reviewId != null) await saveTeamClaimRecord(ctx, reviewId, handle.record).catch(() => {});
  } finally {
    if (ledgerId != null) finishing.delete(ledgerId);
  }
}

/**
 * Write a run's record (`claude_reviews.team_claim`), and tie the claim's ledger row to the run when
 * a handle is given.
 */
export async function saveTeamClaimRecord(
  ctx: AgentContext,
  reviewId: number,
  record: ClaudeTeamClaimRecord,
  handle?: Pick<TeamClaimHandle, 'ledgerId'> | null,
): Promise<void> {
  const cr = ctx.schema.claudeReviews;
  await ctx.db.update(cr).set({ teamClaim: record }).where(eq(cr.id, reviewId)).execute();
  if (handle?.ledgerId != null) await setClaimLine(ctx, handle.ledgerId, { reviewId });
}

// ---- the pending line a Clear would replace ----

/**
 * The pending Limn line at the PR's current head that "Clear" would replace (DB + memory only): a
 * teammate's live claim this Limn skipped for (memory, else the stored `team_claim_seen` line), else this machine's own OPEN ledger row at the head
 * (a run that died, or a final line GitHub did not take yet) when no run is going — the reconciler
 * releases it on its own too; Clear just does it now.
 */
export async function teamClaimPendingFor(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string | null,
  running: boolean,
  nowMs: number = Date.now(),
): Promise<ClaudeTeamClaimPending | null> {
  if (!headSha) return null;
  const skip = skipsOfPr(accountId, prId).find((e) => e.skip.headSha === headSha && e.skip.kind === 'reviewing')?.skip;
  if (skip) return { provider: skip.provider, login: skip.login, mine: false };
  // ⚠ GAP 6 (2026-11-05): the memory above is gone after a restart. The STORED teammate line at this
  // head (team_claim_seen, written by every read that found a teammate's live claim) still says who is
  // reviewing, so the Clear button survives a restart. The next read rewrites or forgets it.
  // ⚠ Only while it can still be live: nothing re-reads it until a new run on the PR, so a stored
  // line past TEAM_CLAIM_LEASE_MS (from its first line — the earliest it can lapse) offers no Clear.
  const seen = (await teammateLinesAtHead(ctx, accountId, prId, headSha).catch(() => [])).find(
    (t) => t.kind === 'reviewing' && Date.parse(t.at) + TEAM_CLAIM_LEASE_MS > nowMs,
  );
  if (seen) return { provider: seen.provider, login: seen.login, mine: false };
  if (running) return null;
  const row = (await openClaimLinesAtHead(ctx, accountId, prId, headSha)).find((r) => !claimLineFinishing(r.id));
  if (!row) return null;
  const login = row.login ?? (await defaultTeamClaimGithub.login(accountId).catch(() => null)) ?? 'you';
  return { provider: row.provider === 'codex' ? 'codex' : 'claude', login, mine: true };
}

/**
 * CLEAR: post "Cleared by <login>" (success — free to every Limn) at the PR's current head for one
 * provider. Never retried. Forgets the skip and marks this machine's latest record at the head
 * cleared, so the button goes.
 * ⚠ It READS the commit's lines first and posts ONLY when the newest is still a pending claim: a
 * teammate who finished since the button was drawn ("robin reviewed · 3 comments") must not be
 * overwritten by a free line, or every Limn reviews that commit again. Nothing to clear still forgets
 * the local state (the button goes); an unreadable history posts nothing.
 */
export async function clearTeamClaim(
  ctx: AgentContext,
  target: TeamClaimTarget,
  gh: TeamClaimGithub = defaultTeamClaimGithub,
): Promise<{ ok: true } | { ok: false; error: 'no_access' | 'rate_limited' | 'error'; message: string }> {
  const { accountId, prId, owner, name, headSha, provider } = target;
  const login = (await gh.login(accountId).catch(() => null)) ?? null;
  if (!login) return { ok: false, error: 'error', message: 'Your GitHub login is not known yet.' };
  let stillPending: boolean;
  try {
    const newest = newestLine(await gh.listLines(accountId, owner, name, headSha, teamClaimContext(provider)));
    stillPending = newest != null && !settles(newest);
  } catch (err) {
    const kind = claimErrorKind(err, accountId);
    if (kind === 'rate_limited') {
      return { ok: false, error: 'rate_limited', message: 'GitHub rate limit reached. Try again in a few minutes.' };
    }
    return { ok: false, error: 'error', message: `Could not read the commit's Limn lines: ${errText(err).slice(0, 160)}` };
  }
  if (stillPending) {
    try {
      await gh.postLine(accountId, owner, name, headSha, teamClaimContext(provider), {
        state: 'success',
        description: clearedLine(login),
      });
    } catch (err) {
      const kind = claimErrorKind(err, accountId);
      if (kind === 'rate_limited') {
        return { ok: false, error: 'rate_limited', message: 'GitHub rate limit reached. Try again in a few minutes.' };
      }
      return kind === 'no_access'
        ? { ok: false, error: 'no_access', message: 'GitHub refused: you need write access to this repo.' }
        : { ok: false, error: 'error', message: errText(err).slice(0, 200) };
    }
  }
  forgetSkip(accountId, prId, provider);
  // The teammate's line the tab showed is no longer the newest one.
  await forgetTeammateLine(ctx, accountId, prId, headSha, provider).catch(() => {});
  // The ledger: every open row at this head and provider is settled by the Clear.
  await releaseClaimLinesAtHead(ctx, accountId, prId, headSha, provider, 'cleared').catch((err) =>
    ctx.log.warn(`team claim pr ${prId}: ledger not cleared: ${errText(err)}`),
  );
  const row = (await latestClaimRecordsAtHead(ctx, accountId, prId, headSha)).find(
    (r) => r.teamClaim.context === teamClaimContext(provider),
  );
  if (row && stillPending) {
    await saveTeamClaimRecord(ctx, row.id, { ...row.teamClaim, lastLine: 'cleared', at: new Date().toISOString() });
  }
  return { ok: true };
}

/**
 * This machine's newest team-claim record PER CONTEXT among the auto runs at `headSha`, newest
 * first. Full reviews only: a replies pass (`kind = 'replies'`) never claims.
 */
async function latestClaimRecordsAtHead(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
): Promise<Array<{ id: number; teamClaim: ClaudeTeamClaimRecord }>> {
  const cr = ctx.schema.claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id, teamClaim: cr.teamClaim })
    .from(cr)
    .where(
      and(
        eq(cr.prId, prId),
        eq(cr.accountId, accountId),
        eq(cr.headSha, headSha),
        eq(cr.trigger, 'auto'),
        isNull(cr.kind),
        isNotNull(cr.teamClaim),
      ),
    )
    .orderBy(desc(cr.id))
    .limit(8)
    .execute()) as Array<{ id: number; teamClaim: ClaudeTeamClaimRecord | null }>;
  const seen = new Set<string>();
  const out: Array<{ id: number; teamClaim: ClaudeTeamClaimRecord }> = [];
  for (const r of rows) {
    if (!r.teamClaim || seen.has(r.teamClaim.context)) continue;
    seen.add(r.teamClaim.context);
    out.push({ id: r.id, teamClaim: r.teamClaim });
  }
  return out;
}
