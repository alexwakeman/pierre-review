// THE BUILD CLAIM'S LIFECYCLE (docs/STORY-BUILD.md § The team claim; the lines and the fold: build-claim.ts).
//
//   READ     `readTicketClaim`: ONE GraphQL read of the ticket branch in every workspace repository, then the
//            `ensemble/build` lines of each branch head that exists (usually none or one). The story view asks
//            through `ticketClaimForView` (cached TICKET_CLAIM_VIEW_TTL_MS) before it offers Implement or Fill
//            gaps; POST /api/story-builds asks again before it starts anything.
//   TAKE     `takeTicketClaim` (the start, and a Resume through the reconciler): a lapsed claim is released
//            first ("Cleared by alex: robin's claim expired"); the LEDGER intent; the placeholder (a new
//            branch, or a free placeholder replaced by a fast-forward); the pending line; then READ AGAIN —
//            the earliest live claim wins, a loser stands down. Never throws; a failure goes ahead UNMARKED.
//   FOLLOW   `noteTicketBranchMoved` (git-ops.ts, after a push lands): the claim moves to the commit this
//            machine pushed onto the ticket branch, and its pending line goes up there at once.
//   PUSH     `placeholderReplaceable` (git-ops.ts `pushNewBranch`): a branch that exists may be replaced, with
//            a lease, only when its head is a placeholder of ours, or a placeholder nobody holds.
//   CLEAR    `clearTicketClaim`: the reader's press on a lapsed claim (or their own from another computer).
// Renewal, the final line and the crash release are the reconciler's (build-claim-release.ts).
import type { StoryBuildTeamClaim } from '@pierre-review/shared';
import { claimErrorKind, newestLine, releaseContextOf, sameGithubLogin } from '../../review/claude-review/team-claim.js';
import { sessionBranch } from '../../sandbox/workspace/seed.js';
import {
  BUILD_CLAIM_CONTEXT,
  anchorKey,
  buildClearedLine,
  buildExpiredLine,
  buildingLine,
  buildLostLine,
  claimWinner,
  claimsOf,
  decideBuildClaim,
  isPlaceholderMessage,
  placeholderMessage,
  toStoryBuildTeamClaim,
  type BuildClaimAnchor,
  type BuildClaimDecision,
} from './build-claim.js';
import { defaultBuildClaimGithub, type BuildClaimGithub, type TicketBranchRepo } from './build-claim-github.js';
import {
  openBuildRowsOf,
  ownBuildHeads,
  ownBuildRowAt,
  recordBuildClaimIntent,
  recordTeammateBuildRelease,
  updateBuildClaimLine,
} from './build-claim-ledger.js';

export interface BuildClaimLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface BuildClaimSeams {
  gh: BuildClaimGithub;
  nowMs: () => number;
  /** Is this build's session live in this process (the sandbox runs)? Default: the session manager's probe. */
  liveBuild: (buildId: number) => boolean;
}

let overrides: Partial<BuildClaimSeams> = {};
let liveProbe: ((buildId: number) => boolean) | null = null;

/** The session manager tells the claim which builds are live (no import cycle). */
export function registerBuildClaimLiveProbe(fn: (buildId: number) => boolean): void {
  liveProbe = fn;
}

/** The seams in use. */
export function buildClaimSeams(): BuildClaimSeams {
  return {
    gh: overrides.gh ?? defaultBuildClaimGithub,
    nowMs: overrides.nowMs ?? (() => Date.now()),
    liveBuild: overrides.liveBuild ?? ((id) => liveProbe?.(id) ?? false),
  };
}

/** Test seam: replace the adapter, the clock or the live probe (null ⇒ the real ones). */
export function setBuildClaimSeamsForTest(s: Partial<BuildClaimSeams> | null): void {
  overrides = s ?? {};
  viewCache.clear();
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

export interface TicketTarget {
  accountId: number;
  workspaceId: number;
  ident: string;
  ticketKey: string;
  /** Every repository of the workspace (the claim may hang on any of them). */
  repos: ReadonlyArray<{ owner: string; name: string }>;
}

export interface TicketClaimRead {
  login: string;
  branch: string;
  repos: TicketBranchRepo[];
  anchors: BuildClaimAnchor[];
  decision: BuildClaimDecision;
}

/** READ (see the header). null: no login, or GitHub could not be read (the caller goes ahead). */
export async function readTicketClaim(t: TicketTarget, log?: BuildClaimLog): Promise<TicketClaimRead | null> {
  const s = buildClaimSeams();
  const login = await s.gh.login(t.accountId).catch(() => null);
  if (!login) return null;
  const branch = sessionBranch(t.ticketKey);
  try {
    const repos = await s.gh.readTicketBranch(t.accountId, t.repos, branch);
    const anchors: BuildClaimAnchor[] = [];
    for (const r of repos) {
      if (r.head == null) continue;
      const lines = await s.gh.listLines(t.accountId, r.owner, r.name, r.head.oid, BUILD_CLAIM_CONTEXT);
      anchors.push({ owner: r.owner, name: r.name, sha: r.head.oid, placeholder: isPlaceholderMessage(r.head.message), lines });
    }
    const own = await ownBuildHeads(t.accountId).catch(() => new Set<string>());
    const decision = decideBuildClaim(anchors, login, s.nowMs(), (c) => own.has(anchorKey(c.owner, c.name, c.sha)));
    return { login, branch, repos, anchors, decision };
  } catch (err) {
    log?.warn(`build claim ${t.ticketKey}: the ticket branch could not be read (${errText(err)})`);
    return null;
  }
}

// ---- the story view's read (cached) ----

export const TICKET_CLAIM_VIEW_TTL_MS = 30_000;
const viewCache = new Map<string, { atMs: number; claim: StoryBuildTeamClaim | null }>();
const viewKey = (accountId: number, workspaceId: number, ident: string): string => `${accountId}:${workspaceId}:${ident}`;

/** What the story view shows: a teammate's (or the reader's other computer's) claim, or null. Never throws. */
export async function ticketClaimForView(t: TicketTarget, log?: BuildClaimLog): Promise<StoryBuildTeamClaim | null> {
  const key = viewKey(t.accountId, t.workspaceId, t.ident);
  const hit = viewCache.get(key);
  const now = buildClaimSeams().nowMs();
  if (hit && now - hit.atMs < TICKET_CLAIM_VIEW_TTL_MS) return hit.claim;
  const read = await readTicketClaim(t, log);
  const claim = read && read.decision.kind === 'held' ? toStoryBuildTeamClaim(read.decision) : null;
  if (viewCache.size > 500) viewCache.clear();
  viewCache.set(key, { atMs: now, claim });
  return claim;
}

export function forgetTicketClaimView(accountId: number, workspaceId: number, ident: string): void {
  viewCache.delete(viewKey(accountId, workspaceId, ident));
}

/** The sentence a refused start answers (409 `TeamClaimed`). */
export function teamClaimedMessage(c: StoryBuildTeamClaim): string {
  if (c.mine) return c.live ? 'You are building this ticket on another computer. Clear that build first.' : 'Your build on another computer stopped. Clear it first.';
  return c.live
    ? `${c.login} is building this ticket. Ensemble offers Clear if their claim lapses.`
    : `${c.login} stopped building this ticket. Clear their claim first.`;
}

// ---- TAKE ----

export type TakeClaimResult =
  | { kind: 'held'; ledgerId: number; owner: string; name: string; sha: string }
  /** No claim: the build goes ahead without one (never blocked on GitHub). */
  | { kind: 'unmarked'; reason: string }
  /** Someone else holds the ticket: the build must not go on. */
  | { kind: 'lost'; claim: StoryBuildTeamClaim };

/** Release every LAPSED claim the read found (posted once; a teammate's is recorded). Never throws. */
async function releaseLapsed(t: TicketTarget, read: TicketClaimRead, log?: BuildClaimLog): Promise<void> {
  const s = buildClaimSeams();
  const own = await ownBuildHeads(t.accountId).catch(() => new Set<string>());
  for (const c of claimsOf(read.anchors, s.nowMs())) {
    if (c.live || own.has(anchorKey(c.owner, c.name, c.sha))) continue;
    const mine = sameGithubLogin(c.login, read.login);
    const description = mine ? buildClearedLine(read.login) : buildExpiredLine(read.login, c.login);
    const anchor = read.anchors.find((a) => a.owner === c.owner && a.name === c.name && a.sha === c.sha);
    let lastError: string | null = null;
    try {
      await s.gh.postLine(t.accountId, c.owner, c.name, c.sha, releaseContextOf(anchor ? newestLine(anchor.lines) : null, BUILD_CLAIM_CONTEXT), {
        state: 'success',
        description,
      });
    } catch (err) {
      lastError = errText(err);
      log?.warn(`build claim ${t.ticketKey}: ${c.login}'s lapsed claim was not released (${lastError})`);
    }
    if (!mine) {
      await recordTeammateBuildRelease({
        accountId: t.accountId,
        workspaceId: t.workspaceId,
        ident: t.ident,
        owner: c.owner,
        name: c.name,
        branch: read.branch,
        headSha: c.sha,
        login: c.login,
        description,
        lastError,
      }).catch(() => {});
    }
  }
}

/** The repositories the placeholder may go in, in order: pushable, with a default branch, and the ticket
 *  branch absent there (create) or a placeholder nobody holds (replace). */
function anchorCandidates(read: TicketClaimRead, nowMs: number): Array<{ repo: TicketBranchRepo; replace: string | null }> {
  const liveAt = new Set(claimsOf(read.anchors, nowMs).filter((c) => c.live).map((c) => anchorKey(c.owner, c.name, c.sha)));
  const out: Array<{ repo: TicketBranchRepo; replace: string | null }> = [];
  const sorted = [...read.repos].sort((a, b) => `${a.owner}/${a.name}`.toLowerCase().localeCompare(`${b.owner}/${b.name}`.toLowerCase()));
  for (const r of sorted) {
    if (!r.canPush || r.defaultBranch == null) continue;
    if (r.head == null) out.push({ repo: r, replace: null });
    else if (isPlaceholderMessage(r.head.message) && !liveAt.has(anchorKey(r.owner, r.name, r.head.oid))) out.push({ repo: r, replace: r.head.oid });
  }
  return out;
}

const MAX_ANCHOR_TRIES = 3;

/** TAKE (see the header). `buildId`: the session the claim is for. Never throws. */
export async function takeTicketClaim(t: TicketTarget & { buildId: number }, log?: BuildClaimLog): Promise<TakeClaimResult> {
  const s = buildClaimSeams();
  // A session holds at most one claim: a Resume of a build whose claim is still open keeps it.
  const held = (await openBuildRowsOf(t.accountId, t.buildId).catch(() => []))[0];
  if (held) return { kind: 'held', ledgerId: held.id, owner: held.owner, name: held.name, sha: held.headSha };
  const read = await readTicketClaim(t, log);
  if (read == null) return { kind: 'unmarked', reason: 'the ticket branch could not be read' };
  if (read.decision.kind === 'held' && read.decision.claim.live) return { kind: 'lost', claim: toStoryBuildTeamClaim(read.decision) };
  await releaseLapsed(t, read, log);

  let tries = 0;
  for (const cand of anchorCandidates(read, s.nowMs())) {
    if (tries >= MAX_ANCHOR_TRIES) break;
    tries += 1;
    const { repo } = cand;
    let ledgerId: number;
    try {
      ledgerId = await recordBuildClaimIntent({
        accountId: t.accountId,
        buildId: t.buildId,
        workspaceId: t.workspaceId,
        ident: t.ident,
        kind: 'build',
        context: BUILD_CLAIM_CONTEXT,
        owner: repo.owner,
        name: repo.name,
        branch: read.branch,
        headSha: '',
        login: read.login,
      });
    } catch (err) {
      log?.warn(`build claim ${t.ticketKey}: ledger not written (${errText(err)}); building without a claim`);
      return { kind: 'unmarked', reason: 'ledger' };
    }
    let sha: string;
    try {
      const base = cand.replace != null ? { treeOid: repo.head!.treeOid, parentOid: cand.replace } : { treeOid: repo.defaultBranch!.treeOid, parentOid: repo.defaultBranch!.oid };
      sha = await s.gh.createPlaceholder(t.accountId, repo.owner, repo.name, read.branch, { ...base, message: placeholderMessage(read.login, t.ticketKey) }, cand.replace);
    } catch (err) {
      const taken = (err as { code?: string }).code === 'REF_TAKEN';
      const kind = taken ? 'taken' : claimErrorKind(err, t.accountId);
      await updateBuildClaimLine(ledgerId, { state: 'released', lastError: taken ? 'ref taken' : errText(err) }).catch(() => {});
      if (kind === 'rate_limited') return { kind: 'unmarked', reason: 'rate limited' };
      log?.info(`build claim ${t.ticketKey}: no placeholder on ${repo.owner}/${repo.name} (${errText(err)})`);
      continue; // taken, refused or failed here: the next repository
    }
    await updateBuildClaimLine(ledgerId, { headSha: sha }).catch(() => {});
    const description = buildingLine(read.login, read.branch);
    try {
      await s.gh.postLine(t.accountId, repo.owner, repo.name, sha, BUILD_CLAIM_CONTEXT, { state: 'pending', description });
    } catch (err) {
      // No line: nothing holds the placeholder, so it goes, and the build runs unmarked (never retried).
      log?.warn(`build claim ${t.ticketKey}: the pending line was not posted (${errText(err)}); building without a claim`);
      await s.gh.deletePlaceholder(t.accountId, repo.owner, repo.name, read.branch, sha).catch(() => false);
      await updateBuildClaimLine(ledgerId, { state: 'released', lastError: errText(err) }).catch(() => {});
      return { kind: 'unmarked', reason: 'line not posted' };
    }
    await updateBuildClaimLine(ledgerId, { state: 'pending', lastDescription: description, lastPostedAt: new Date(s.nowMs()), lastError: null }).catch(() => {});
    // CLAIM, THEN READ AGAIN: the earliest live claim wins.
    let again: TicketClaimRead | null = null;
    try {
      again = await readTicketClaim(t, log);
    } catch {
      again = null;
    }
    const winner = again ? claimWinner(again.anchors, s.nowMs()) : null;
    if (again && winner && !(winner.owner === repo.owner && winner.name === repo.name && winner.sha === sha)) {
      const lost = buildLostLine(read.login, winner.login);
      try {
        await s.gh.postLine(t.accountId, repo.owner, repo.name, sha, BUILD_CLAIM_CONTEXT, { state: 'success', description: lost });
        await updateBuildClaimLine(ledgerId, { state: 'released', lastDescription: lost, lastPostedAt: new Date(s.nowMs()), lastError: 'stood down' });
      } catch (err) {
        // Retried by the reconciler while our pending line is the newest (the build is not live then).
        await updateBuildClaimLine(ledgerId, { finalDescription: lost, lastError: errText(err) }).catch(() => {});
      }
      await s.gh.deletePlaceholder(t.accountId, repo.owner, repo.name, read.branch, sha).catch(() => false);
      return {
        kind: 'lost',
        claim: toStoryBuildTeamClaim({ kind: 'held', claim: winner, mine: sameGithubLogin(winner.login, read.login) }),
      };
    }
    forgetTicketClaimView(t.accountId, t.workspaceId, t.ident);
    return { kind: 'held', ledgerId, owner: repo.owner, name: repo.name, sha };
  }
  return { kind: 'unmarked', reason: 'no repository to hold the claim' };
}

// ---- FOLLOW and PUSH (git-ops.ts) ----

/**
 * A push of THIS machine landed on `branch` of owner/name, moving it from `from` to `to`. When a build claim
 * of ours hangs on `from`, it moves to `to`, and its pending line goes up there at once (while the build
 * runs) — so the claim stays on the branch head teammates read. Never throws.
 */
export async function noteTicketBranchMoved(a: { accountId: number; owner: string; name: string; branch: string; from: string | null; to: string }): Promise<void> {
  if (a.from == null || a.from === a.to) return;
  try {
    const row = await ownBuildRowAt(a.accountId, a.owner, a.name, a.branch, a.from);
    if (row == null || (row.state !== 'claiming' && row.state !== 'pending')) return;
    await updateBuildClaimLine(row.id, { headSha: a.to });
    const s = buildClaimSeams();
    if (row.buildId == null || !s.liveBuild(row.buildId) || row.login == null) return;
    const description = buildingLine(row.login, row.branch ?? a.branch);
    await s.gh.postLine(a.accountId, a.owner, a.name, a.to, BUILD_CLAIM_CONTEXT, { state: 'pending', description });
    await updateBuildClaimLine(row.id, { state: 'pending', lastDescription: description, lastPostedAt: new Date(s.nowMs()) });
  } catch {
    // The reconciler's renewal posts it on its next tick.
  }
}

/**
 * May a push REPLACE this existing branch (with a lease on `sha`)? Only when its head is a placeholder —
 * one of ours (this machine's ledger), or one whose claim nobody holds (free, or lapsed). Anything else,
 * or any read error, keeps today's BRANCH_EXISTS. Never throws.
 */
export async function placeholderReplaceable(accountId: number, owner: string, name: string, branch: string, sha: string): Promise<boolean> {
  try {
    if ((await ownBuildRowAt(accountId, owner, name, branch, sha)) != null) return true;
    const s = buildClaimSeams();
    if (!isPlaceholderMessage(await s.gh.commitMessage(accountId, owner, name, sha))) return false;
    const me = await s.gh.login(accountId).catch(() => null);
    const lines = await s.gh.listLines(accountId, owner, name, sha, BUILD_CLAIM_CONTEXT);
    return !claimsOf([{ owner, name, sha, placeholder: true, lines }], s.nowMs()).some((c) => c.live && !sameGithubLogin(c.login, me));
  } catch {
    return false;
  }
}

// ---- CLEAR ----

export type ClearClaimResult = { ok: true } | { ok: false; error: 'NotReady' | 'rate_limited' | 'no_access' | 'error'; message: string };

/** CLEAR (see the header): only a lapsed claim, or the reader's own from another computer. */
export async function clearTicketClaim(t: TicketTarget, log?: BuildClaimLog): Promise<ClearClaimResult> {
  const s = buildClaimSeams();
  forgetTicketClaimView(t.accountId, t.workspaceId, t.ident);
  const read = await readTicketClaim(t, log);
  if (read == null) return { ok: false, error: 'error', message: 'GitHub could not be read. Try again in a minute.' };
  if (read.decision.kind !== 'held') return { ok: true };
  const { claim, mine } = read.decision;
  if (claim.live && !mine) return { ok: false, error: 'NotReady', message: `${claim.login} is still building this. Clear is offered once their claim lapses.` };
  const anchor = read.anchors.find((x) => x.owner === claim.owner && x.name === claim.name && x.sha === claim.sha);
  const description = mine ? buildClearedLine(read.login) : buildExpiredLine(read.login, claim.login);
  let lastError: string | null = null;
  try {
    await s.gh.postLine(t.accountId, claim.owner, claim.name, claim.sha, releaseContextOf(anchor ? newestLine(anchor.lines) : null, BUILD_CLAIM_CONTEXT), {
      state: 'success',
      description,
    });
  } catch (err) {
    const kind = claimErrorKind(err, t.accountId);
    lastError = errText(err);
    if (kind === 'rate_limited') return { ok: false, error: 'rate_limited', message: 'GitHub rate limit reached. Try again in a few minutes.' };
    if (kind === 'no_access') return { ok: false, error: 'no_access', message: `GitHub refused: you need write access to ${claim.owner}/${claim.name}.` };
    return { ok: false, error: 'error', message: lastError.slice(0, 200) };
  } finally {
    if (!mine) {
      await recordTeammateBuildRelease({
        accountId: t.accountId,
        workspaceId: t.workspaceId,
        ident: t.ident,
        owner: claim.owner,
        name: claim.name,
        branch: read.branch,
        headSha: claim.sha,
        login: claim.login,
        description,
        lastError,
      }).catch(() => {});
    }
  }
  forgetTicketClaimView(t.accountId, t.workspaceId, t.ident);
  return { ok: true };
}
