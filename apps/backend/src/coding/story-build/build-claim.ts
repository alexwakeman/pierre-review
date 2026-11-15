// THE TEAM CLAIM FOR IMPLEMENT AND FILL GAPS (docs/TEAM-REVIEW.md § Implement and Fill gaps; docs/STORY-BUILD.md
// § The team claim). The PURE half: the lines, the fold and the wire mapper. The GitHub adapter is
// build-claim-github.ts, the ledger build-claim-ledger.ts, the lifecycle build-claim-flow.ts and the
// reconciler build-claim-release.ts.
//
// Ensemble runs on each person's machine, with no server. Two teammates could both press Implement on the
// same ticket. So, modelled on the review claims (review/claude-review/team-claim.ts), a build CLAIMS its
// ticket on GitHub when it starts, and every teammate's Ensemble reads the claim before it offers
// Implement or Fill gaps:
//
//     where    the ticket branch (`<KEY>`, the branch Push uses — sandbox/workspace/seed.ts `sessionBranch`) in
//              ONE repository of the workspace, pointing at a PLACEHOLDER commit: the default branch's head
//              plus one empty commit "Ensemble: building <KEY>" (trailer `Ensemble-Claim: build`). The
//              build's own push later replaces it (git-ops.ts `pushNewBranch`, with a lease); the claim then
//              FOLLOWS the branch head this machine pushed.
//     context  ensemble/build                              (one; read through `sameStatusContext`, like every line)
//     pending  "alex is building PAY-142"                  (the claim; renewed every BUILD_CLAIM_RENEW_MS
//                                                          while the build's session runs)
//     success  "alex built PAY-142 · pull request opened"  (done: the ticket has its PR)
//     success  "Cleared by alex: build ended · free to claim"   (discarded, failed, or the session closed)
//     success  "Cleared by alex: robin is building this"   (a lost race: stand down)
//     success  "Cleared by alex: robin's claim expired"    (Clear on a teammate's expired claim)
//     success  "Cleared by alex"                           (Clear on the reader's own claim elsewhere)
//
// ⚠ ONLY A PENDING LINE HOLDS. A success line holds nothing: once the PR is open the ticket has a PR and
//   Implement is not offered anyway (shared `storyBuildOffered`), and a free line is free.
// ⚠ WHO and WHEN come from GitHub (`creator.login`, `created_at`); a description is never parsed beyond the
//   FREE phrases ("Cleared by " / "free to claim").
// ⚠ THE LEASE: a pending line holds BUILD_CLAIM_LEASE_MS after its claimant's NEWEST line. A machine that
//   went away stops renewing, so the claim lapses; it is then shown as "robin stopped building this" with
//   Clear, and a start may take it over (its expired line is released first).
// ⚠ EARLIEST LIVE CLAIM WINS: after posting, the claimant reads every repository's ticket branch again; among
//   the live claims, the one whose current run of pending lines STARTED first (created_at, then the
//   repository's name) holds the ticket. A loser stands down (its line goes free, its placeholder is
//   deleted) and its session closes with one line.
// ⚠ NEVER BLOCKS ON GITHUB: no login, an unreadable branch or a refused write ⇒ the build goes ahead
//   WITHOUT a claim (logged). A person's own work is never blocked: their own claim from another computer
//   can be cleared at once, a teammate's once its lease ran out.
import { ensembleStatusContext, type StoryBuildTeamClaim } from '@pierre-review/shared';
import { sameGithubLogin, type TeamClaimLine } from '../../review/claude-review/team-claim.js';

/** The status context WRITTEN (`ensemble/build`), read through `sameStatusContext` like every Ensemble line. */
export const BUILD_CLAIM_CONTEXT = ensembleStatusContext('build');
/** A pending line holds the ticket this long after its claimant's NEWEST line. */
export const BUILD_CLAIM_LEASE_MS = 30 * 60_000;
/** A running build re-posts its pending line this often (well inside the lease). */
export const BUILD_CLAIM_RENEW_MS = 10 * 60_000;
/** The trailer that marks a placeholder commit (read from the commit message, never from a status). */
export const PLACEHOLDER_TRAILER = 'Ensemble-Claim: build';
/** GitHub caps a status description at 140 characters. */
const DESCRIPTION_MAX = 140;
const CLEARED_PREFIX = 'Cleared by ';
const FREE_PHRASE = 'free to claim';

const clamp = (s: string): string => (s.length <= DESCRIPTION_MAX ? s : `${s.slice(0, DESCRIPTION_MAX - 1)}…`);

// ---- the lines ----

export function buildingLine(login: string, ticketKey: string): string {
  return clamp(`${login} is building ${ticketKey}`);
}
export function builtLine(login: string, ticketKey: string): string {
  return clamp(`${login} built ${ticketKey} · pull request opened`);
}
export function buildReleaseLine(login: string, why: string): string {
  return clamp(`${CLEARED_PREFIX}${login}: ${why} · ${FREE_PHRASE}`);
}
export function buildLostLine(login: string, holder: string): string {
  return clamp(`${CLEARED_PREFIX}${login}: ${holder} is building this`);
}
export function buildExpiredLine(login: string, holder: string): string {
  return clamp(`${CLEARED_PREFIX}${login}: ${holder}'s claim expired`);
}
export function buildClearedLine(login: string): string {
  return clamp(`${CLEARED_PREFIX}${login}`);
}

/** The placeholder commit's message: one subject, one sentence, the trailer. */
export function placeholderMessage(login: string, ticketKey: string): string {
  return `Ensemble: building ${ticketKey}\n\n${login} is building ${ticketKey} in Ensemble. This empty commit holds the branch name; Ensemble replaces it when the work is pushed.\n\n${PLACEHOLDER_TRAILER}\n`;
}

/** Is this commit message a placeholder's (the trailer on a line of its own)? */
export function isPlaceholderMessage(message: string | null | undefined): boolean {
  return (message ?? '').split('\n').some((l) => l.trim() === PLACEHOLDER_TRAILER);
}

/** A line that holds nothing: anything but pending, or a pending/success line in the FREE wording. */
export function isFreeBuildLine(l: Pick<TeamClaimLine, 'state' | 'description'>): boolean {
  if (l.state !== 'pending') return true;
  const d = l.description ?? '';
  return d.startsWith(CLEARED_PREFIX) || d.includes(FREE_PHRASE);
}

// ---- the fold ----

/** One repository's ticket branch head and its `ensemble/build` lines. */
export interface BuildClaimAnchor {
  owner: string;
  name: string;
  /** The branch head the lines were read on. */
  sha: string;
  /** The head is a placeholder commit (the trailer). */
  placeholder: boolean;
  lines: readonly TeamClaimLine[];
}

/** A claim found on one anchor: its newest line is a pending, non-free line. */
export interface BuildClaimFound {
  login: string;
  owner: string;
  name: string;
  sha: string;
  placeholder: boolean;
  /** The first line of the claimant's current run of pending lines (the "earliest wins" key). */
  sinceMs: number;
  newestMs: number;
  leaseEndsAtMs: number;
  live: boolean;
}

const order = (a: TeamClaimLine, b: TeamClaimLine): number => a.createdAtMs - b.createdAtMs || a.id - b.id;
const fullName = (c: { owner: string; name: string }): string => `${c.owner}/${c.name}`.toLowerCase();

/** Every claim the anchors carry (one per anchor at most), live or lapsed. Pure. */
export function claimsOf(anchors: readonly BuildClaimAnchor[], nowMs: number): BuildClaimFound[] {
  const out: BuildClaimFound[] = [];
  for (const a of anchors) {
    if (a.lines.length === 0) continue;
    const sorted = [...a.lines].sort(order);
    const newest = sorted[sorted.length - 1]!;
    if (isFreeBuildLine(newest) || newest.login == null) continue;
    let first = newest;
    for (let i = sorted.length - 2; i >= 0; i -= 1) {
      const l = sorted[i]!;
      if (isFreeBuildLine(l) || !sameGithubLogin(l.login, newest.login)) break;
      first = l;
    }
    const leaseEndsAtMs = newest.createdAtMs + BUILD_CLAIM_LEASE_MS;
    out.push({
      login: newest.login,
      owner: a.owner,
      name: a.name,
      sha: a.sha,
      placeholder: a.placeholder,
      sinceMs: first.createdAtMs,
      newestMs: newest.createdAtMs,
      leaseEndsAtMs,
      live: nowMs < leaseEndsAtMs,
    });
  }
  return out;
}

const earliest = (a: BuildClaimFound, b: BuildClaimFound): number => a.sinceMs - b.sinceMs || fullName(a).localeCompare(fullName(b));

/** THE WINNER among the live claims (own included): the earliest start. null when none is live. Pure. */
export function claimWinner(anchors: readonly BuildClaimAnchor[], nowMs: number): BuildClaimFound | null {
  return claimsOf(anchors, nowMs).filter((c) => c.live).sort(earliest)[0] ?? null;
}

export type BuildClaimDecision =
  | { kind: 'free' }
  /** Someone else's claim (or the reader's own from ANOTHER computer): `live` false ⇒ lapsed, not released. */
  | { kind: 'held'; claim: BuildClaimFound; mine: boolean };

/**
 * THE ONE FOLD (pure): what a teammate's Ensemble shows for a ticket. `own(c)`: the claim is THIS machine's
 * (its ledger holds that head) — left out, the local session speaks for it. The earliest live claim holds;
 * with none live, the newest lapsed one is shown (Clear frees it); else free.
 */
export function decideBuildClaim(
  anchors: readonly BuildClaimAnchor[],
  me: string | null,
  nowMs: number,
  own: (c: BuildClaimFound) => boolean = () => false,
): BuildClaimDecision {
  const claims = claimsOf(anchors, nowMs).filter((c) => !own(c));
  const live = claims.filter((c) => c.live).sort(earliest);
  const pick = live[0] ?? [...claims].sort((a, b) => b.newestMs - a.newestMs || fullName(a).localeCompare(fullName(b)))[0];
  if (pick == null) return { kind: 'free' };
  return { kind: 'held', claim: pick, mine: sameGithubLogin(pick.login, me) };
}

/** The wire shape of a held claim. */
export function toStoryBuildTeamClaim(d: Extract<BuildClaimDecision, { kind: 'held' }>): StoryBuildTeamClaim {
  return {
    login: d.claim.login,
    mine: d.mine,
    live: d.claim.live,
    since: new Date(d.claim.sinceMs).toISOString(),
    leaseEndsAt: new Date(d.claim.leaseEndsAtMs).toISOString(),
    repo: `${d.claim.owner}/${d.claim.name}`,
  };
}

/** The key a set of this machine's own heads uses (`own` above). */
export const anchorKey = (owner: string, name: string, sha: string): string => `${owner}/${name}@${sha}`.toLowerCase();
