// TEAM CLAIMS FOR DEPENDENCY WORK (docs/MERGE-CI-TRUNK.md § Team claims for dependency work).
//
// Two people on one team can both run Limn with dependency automation on the same repos. Without a
// claim each install would ask Dependabot to rebase, run its own AI conflict resolution or CI fix and
// push it, and arm its own merge — on the same PR, at the same time. So, modelled on the AI review
// claims (review/claude-review/team-claim.ts), BEFORE any automated action on a dependency bot's PR
// (approve, rebase request, AI conflict run, AI fix, arming the merge) Limn reads, then posts, ONE
// commit status on the PR's head:
//
//     context  limn/deps                                  (one for every dependency action)
//     pending  "alex handling · fixing CI"               (the claim; renewed every DEPS_CLAIM_RENEW_MS
//                                                          while an AI run goes)
//     success  "alex fixed CI · pushed 1a2b3c4"          (done) — or "alex couldn't fix CI" (failed)
//     success  "Cleared by alex: didn't start · free to claim"   (the claim given back: nothing written)
//
// ⚠ Lines are only ever PENDING or SUCCESS — never red (red reads as broken CI). Every `limn/` line is
//   left out of every CI read (shared `isLimnStatusContext`, a PREFIX test), so `limn/deps` is never CI.
// ⚠ WHO and WHEN come from GitHub (`creator.login`, `created_at`). From a description only two things
//   are read back: the FREE phrases ("Cleared by " / "free to claim") and the action FAMILY (below).
//
// THE FOLD (`decideDepsClaim`, pure):
//   • a teammate's PENDING line younger than DEPS_CLAIM_TTL_MS (30 min) holds the head for EVERY
//     action: someone is working on this PR right now ("Robin is handling this"). Older = stale: a
//     crashed Limn's claim is free after the TTL. Two claimants racing: the one whose current run of
//     pending lines STARTED first wins (created_at, then id); the loser stands down;
//   • a teammate's SUCCESS line (done or failed — their attempt is theirs) holds the head for the SAME
//     FAMILY of action only ("Robin handled this"): approve · conflicts (rebase ask + AI resolve) · CI
//     fix · merge. Robin approving does not stop Alex's Limn arming the merge; Robin's AI fix failing
//     stops Alex's from trying the same head again. A line whose family can't be read holds them all;
//   • the reader's own lines hold nothing on this machine (its DB claim already stops repeats), with
//     one exception for their OTHER machines: an own FINISHED line of the SAME action holds that
//     action (`actionOfLine`) — a second machine has no local row, so without it it would retry;
//   • an AI run that PUSHED a commit posts "<login>'s AI pushed this commit" ON THAT COMMIT
//     (`markAiPushedHead`): every machine's merge sweep holds that head until its CI is green
//     ('awaiting_ci'). It holds nothing else;
//   • family words are read AFTER the poster's login (`wordsOf`): "approver-x armed the merge" is a
//     merge.
//   A new head is a new commit with no lines: claims are per commit.
//
// ⚠ NEVER BLOCKS ON GITHUB: no login, an unreadable history or a refused write ⇒ the action goes
//   ahead WITHOUT a line (logged), exactly like the review claims.
// ⚠ ALWAYS ON, like the review claims (2026-11-10: the old team-claims switch is gone).
// ⚠ NO LEDGER: a line left pending by a crash is released by the TTL, not by a reconciler — dependency
//   actions take seconds (approve, rebase ask, arming) or are renewed while they run (AI runs).
import { DEPENDENCY_CLAIM_CONTEXT, type DependencyAutomationActionKind } from '@pierre-review/shared';
import {
  defaultTeamClaimGithub,
  sameGithubLogin,
  type TeamClaimGithub,
  type TeamClaimLine,
} from '../review/claude-review/team-claim.js';

/** A pending line holds the head this long after the claimant's NEWEST line. */
export const DEPS_CLAIM_TTL_MS = 30 * 60_000;
/** A running AI action re-posts its pending line this often (well inside the TTL). */
export const DEPS_CLAIM_RENEW_MS = 10 * 60_000;
/** A head a teammate already handled is read again after this long. */
export const DEPS_HANDLED_RECHECK_MS = 30 * 60_000;
/** GitHub caps a status description at 140 characters. */
const DESCRIPTION_MAX = 140;

const CLEARED_PREFIX = 'Cleared by ';
const FREE_PHRASE = 'free to claim';

export type DepsFamily = 'approve' | 'conflicts' | 'ai_fix' | 'merge';

export function familyOfAction(action: DependencyAutomationActionKind): DepsFamily {
  switch (action) {
    case 'approve':
      return 'approve';
    case 'rebase_request':
    case 'ai_resolve':
      return 'conflicts';
    case 'ai_fix':
      return 'ai_fix';
    case 'arm_merge':
    case 'merge_landed':
      return 'merge';
  }
}

const clamp = (s: string): string => (s.length <= DESCRIPTION_MAX ? s : `${s.slice(0, DESCRIPTION_MAX - 1)}…`);

// ---- the lines (plain English; the family words below are what `familyOfLine` reads back) ----

const DOING: Record<Exclude<DependencyAutomationActionKind, 'merge_landed'>, string> = {
  approve: 'approving',
  rebase_request: 'asking the bot to rebase',
  ai_resolve: 'resolving conflicts',
  ai_fix: 'fixing CI',
  arm_merge: 'arming the merge',
};
const FAILED: Record<Exclude<DependencyAutomationActionKind, 'merge_landed'>, string> = {
  approve: "couldn't approve",
  rebase_request: "couldn't ask the bot to rebase",
  ai_resolve: "couldn't resolve conflicts",
  ai_fix: "couldn't fix CI",
  arm_merge: "couldn't arm the merge",
};

export type ClaimAction = Exclude<DependencyAutomationActionKind, 'merge_landed'>;

/** The claim: "alex handling · fixing CI". */
export function handlingLine(login: string, action: ClaimAction): string {
  return clamp(`${login} handling · ${DOING[action]}`);
}

/** The done line. `pushedSha`: the commit an AI run pushed. */
export function doneLine(login: string, action: ClaimAction, pushedSha: string | null = null): string {
  const pushed = pushedSha ? ` · pushed ${pushedSha.slice(0, 7)}` : '';
  switch (action) {
    case 'approve':
      return clamp(`${login} approved`);
    case 'rebase_request':
      return clamp(`${login} asked the bot to rebase`);
    case 'ai_resolve':
      return clamp(`${login} resolved conflicts${pushed}`);
    case 'ai_fix':
      return clamp(`${login} fixed CI${pushed}`);
    case 'arm_merge':
      return clamp(`${login} armed the merge · lands when checks pass`);
  }
}

/** A finished attempt that did not work. Still SUCCESS on GitHub: the attempt is theirs, never red. */
export function failedLine(login: string, action: ClaimAction): string {
  return clamp(`${login} ${FAILED[action]}`);
}

/** The claim given back without writing anything: free. */
export function releaseLine(login: string, why: string): string {
  return clamp(`${CLEARED_PREFIX}${login}: ${why} · ${FREE_PHRASE}`);
}

/** A lost race: stand down, naming the winner. Free as far as OUR line goes. */
export function lostLine(login: string, holder: string): string {
  return clamp(`${CLEARED_PREFIX}${login}: ${holder} is handling this`);
}

const isFreeLine = (l: TeamClaimLine): boolean => {
  const d = l.description ?? '';
  return d.startsWith(CLEARED_PREFIX) || d.includes(FREE_PHRASE);
};

/**
 * A line's words WITHOUT the poster's login: every line leads with it ("robin approved"), and a
 * login can itself hold a family word ("approver-x armed the merge" is a merge, not an approval).
 * `login` is the line's creator (GitHub's `creator.login`); a "Cleared by <login>: " lead goes too.
 */
function wordsOf(description: string | null, login: string | null | undefined): string {
  let d = (description ?? '').trim();
  if (d.startsWith(CLEARED_PREFIX)) {
    const colon = d.indexOf(': ');
    d = colon >= 0 ? d.slice(colon + 2) : d.slice(CLEARED_PREFIX.length);
  } else if (login && d.toLowerCase().startsWith(`${login.toLowerCase()} `)) {
    d = d.slice(login.length + 1);
  } else if (login && d.toLowerCase().startsWith(`${login.toLowerCase()}'s `)) {
    d = d.slice(login.length + 3);
  }
  return d.toLowerCase();
}

/** The action family a line names, from its words (after its poster's login); null when it names
 *  none we know. */
export function familyOfLine(description: string | null, login?: string | null): DepsFamily | null {
  const d = wordsOf(description, login);
  if (/\bfix(ed|ing)? ci\b/.test(d)) return 'ai_fix';
  if (d.includes('rebase') || d.includes('conflict')) return 'conflicts';
  if (d.includes('approv')) return 'approve';
  if (d.includes('merge')) return 'merge';
  return null;
}

/** The exact action a FINISHED (done or failed) line names; null for any other line. */
export function actionOfLine(description: string | null, login?: string | null): ClaimAction | null {
  const d = wordsOf(description, login);
  if (d === 'approved' || d.startsWith("couldn't approve")) return 'approve';
  if (d.startsWith('asked the bot to rebase') || d.startsWith("couldn't ask the bot to rebase")) return 'rebase_request';
  if (d.startsWith('resolved conflicts') || d.startsWith("couldn't resolve conflicts")) return 'ai_resolve';
  if (d.startsWith('fixed ci') || d.startsWith("couldn't fix ci")) return 'ai_fix';
  if (d.startsWith('armed the merge') || d.startsWith("couldn't arm the merge")) return 'arm_merge';
  return null;
}

const AI_PUSHED_PHRASE = 'AI pushed this commit';

/**
 * The line an AI run posts on the commit it PUSHED: "robin's AI pushed this commit · merged only
 * once CI is green". Read by every machine's merge sweep, so a head someone's AI wrote is never armed
 * before its CI is green — whoever pushed it. It holds nothing else.
 */
export function aiPushedLine(login: string): string {
  return clamp(`${login}'s ${AI_PUSHED_PHRASE} · merged only once CI is green`);
}

export function isAiPushedLine(l: Pick<TeamClaimLine, 'description'>): boolean {
  return (l.description ?? '').includes(AI_PUSHED_PHRASE);
}

const order = (a: TeamClaimLine, b: TeamClaimLine): number => a.createdAtMs - b.createdAtMs || a.id - b.id;

export type DepsClaimDecision =
  | { kind: 'free' }
  /** The reader's own live claim (a restart mid-action, or another of their machines). */
  | { kind: 'mine' }
  /** A teammate is working on this PR now. */
  | { kind: 'handling'; login: string; leaseEndsAtMs: number; description: string | null }
  /** A teammate finished (done or failed) this family of action at this head — or the reader's own
   *  OTHER machine finished this very action (no local row there stops a repeat). */
  | { kind: 'handled'; login: string; atMs: number; description: string | null }
  /** An AI run pushed this head and its CI is not green yet: never armed (merge only). */
  | { kind: 'awaiting_ci' };

/** What the fold may also weigh. */
export interface DepsClaimFoldOpts {
  /** The action itself: the reader's own FINISHED line of this exact action holds it. On this
   *  machine its local row already stops a repeat, so this only stops ANOTHER of the reader's
   *  machines, which has no row. */
  action?: ClaimAction;
  /** 'merge' only: the head's synced CI is green. An AI-pushed head is held until it is. */
  ciGreen?: boolean;
}

/** THE ONE FOLD over the head's `limn/deps` lines (any order). Pure. `me`: the reader's login. */
export function decideDepsClaim(
  lines: readonly TeamClaimLine[],
  me: string | null,
  nowMs: number,
  family: DepsFamily,
  opts: DepsClaimFoldOpts = {},
): DepsClaimDecision {
  if (lines.length === 0) return { kind: 'free' };
  // An AI-written head is armed only once its CI is green, whoever's AI pushed it.
  if (family === 'merge' && opts.ciGreen !== true && lines.some(isAiPushedLine)) return { kind: 'awaiting_ci' };
  const sorted = [...lines].sort(order);
  // Pending claimants: each login's CURRENT run of pending (non-free) lines, newest back.
  const byLogin = new Map<string, TeamClaimLine[]>();
  for (const l of sorted) {
    if (l.login == null) continue;
    const k = l.login.toLowerCase();
    const list = byLogin.get(k);
    if (list) list.push(l);
    else byLogin.set(k, [l]);
  }
  let holder: { first: TeamClaimLine; newest: TeamClaimLine } | null = null;
  for (const list of byLogin.values()) {
    let first: TeamClaimLine | null = null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const l = list[i]!;
      if (l.state !== 'pending' || isFreeLine(l)) break;
      first = l;
    }
    if (first == null) continue;
    const newest = list[list.length - 1]!;
    if (newest.createdAtMs + DEPS_CLAIM_TTL_MS <= nowMs) continue; // stale: a lost Limn's line
    if (!holder || order(first, holder.first) < 0) holder = { first, newest };
  }
  if (holder) {
    if (sameGithubLogin(holder.first.login, me)) return { kind: 'mine' };
    return {
      kind: 'handling',
      login: holder.first.login!,
      leaseEndsAtMs: holder.newest.createdAtMs + DEPS_CLAIM_TTL_MS,
      description: holder.newest.description,
    };
  }
  // A teammate's finished action of the same family (or one we can't read) holds the head.
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const l = sorted[i]!;
    if (l.state !== 'success' || isFreeLine(l) || isAiPushedLine(l) || l.login == null) continue;
    if (sameGithubLogin(l.login, me)) {
      // The reader's own line: holds only the SAME action (another of their machines did it).
      if (opts.action != null && actionOfLine(l.description, l.login) === opts.action) {
        return { kind: 'handled', login: l.login, atMs: l.createdAtMs, description: l.description };
      }
      continue;
    }
    const f = familyOfLine(l.description, l.login);
    if (f == null || f === family) {
      return { kind: 'handled', login: l.login, atMs: l.createdAtMs, description: l.description };
    }
  }
  return { kind: 'free' };
}

// ---- GitHub (the review claims' adapter, on another context; replaceable in tests) ----

let github: TeamClaimGithub = defaultTeamClaimGithub;

/** Test seam: a fake adapter, or null for the real one. */
export function setDepsClaimGithubForTest(g: TeamClaimGithub | null): void {
  github = g ?? defaultTeamClaimGithub;
}

export interface DepsClaimTarget {
  accountId: number;
  prId: number;
  owner: string;
  name: string;
  headSha: string;
  action: ClaimAction;
}

interface Log {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** A claim this action holds — or `login: null`: it goes ahead without a line (unmarked). */
export interface DepsClaimHandle {
  target: DepsClaimTarget;
  login: string | null;
  timer: ReturnType<typeof setInterval> | null;
}

export type DepsHold = Extract<DepsClaimDecision, { kind: 'handling' | 'handled' }>;

/** Step 1: read the head's lines. `hold` set ⇒ a teammate holds it: do nothing. `awaitingCi` ⇒ an
 *  AI-pushed head whose CI is not green: do nothing yet (merge only). Never throws. */
export async function readDepsClaim(
  target: DepsClaimTarget,
  log: Log,
  nowMs: number = Date.now(),
  opts: Pick<DepsClaimFoldOpts, 'ciGreen'> = {},
): Promise<{ login: string | null; hold: DepsHold | null; awaitingCi?: true }> {
  let login: string | null = null;
  try {
    login = await github.login(target.accountId);
  } catch {
    login = null;
  }
  if (!login) return { login: null, hold: null };
  try {
    const lines = await github.listLines(target.accountId, target.owner, target.name, target.headSha, DEPENDENCY_CLAIM_CONTEXT);
    const d = decideDepsClaim(lines, login, nowMs, familyOfAction(target.action), { action: target.action, ...opts });
    if (d.kind === 'awaiting_ci') return { login, hold: null, awaitingCi: true };
    return { login, hold: d.kind === 'handling' || d.kind === 'handled' ? d : null };
  } catch (err) {
    // Unreadable ⇒ go ahead without a line (never blocks on GitHub).
    log.warn({ err, prId: target.prId }, 'dependency claim: lines unreadable; acting without a line');
    return { login: null, hold: null };
  }
}

async function post(handle: { target: DepsClaimTarget; login: string }, state: 'pending' | 'success', description: string): Promise<void> {
  const t = handle.target;
  await github.postLine(t.accountId, t.owner, t.name, t.headSha, DEPENDENCY_CLAIM_CONTEXT, { state, description });
}

/**
 * Step 2 (after the DB claim): post the pending line, re-read, fold again. A teammate who won the
 * race ⇒ our line stands down and `hold` names them. A refused or failed write ⇒ unmarked handle.
 * Never throws.
 */
export async function postDepsClaim(
  login: string | null,
  target: DepsClaimTarget,
  log: Log,
  nowMs: () => number = Date.now,
): Promise<{ handle: DepsClaimHandle; hold: DepsHold | null }> {
  if (!login) return { handle: { target, login: null, timer: null }, hold: null };
  const handle: DepsClaimHandle = { target, login, timer: null };
  try {
    await post({ target, login }, 'pending', handlingLine(login, target.action));
  } catch (err) {
    log.warn({ err, prId: target.prId }, 'dependency claim: pending line not posted; acting without a line');
    return { handle: { target, login: null, timer: null }, hold: null };
  }
  try {
    const lines = await github.listLines(target.accountId, target.owner, target.name, target.headSha, DEPENDENCY_CLAIM_CONTEXT);
    const d = decideDepsClaim(lines, login, nowMs(), familyOfAction(target.action), { action: target.action, ciGreen: true });
    if (d.kind === 'handling' || d.kind === 'handled') {
      await post({ target, login }, 'success', lostLine(login, d.login)).catch((err) =>
        log.warn({ err, prId: target.prId }, 'dependency claim: stand-down line not posted'),
      );
      return { handle: { target, login: null, timer: null }, hold: d };
    }
  } catch {
    // The re-read failed: our line is up; go ahead.
  }
  return { handle, hold: null };
}

/** Re-post the pending line while a long action (an AI run) goes. Cleared by `endDepsClaim`. */
export function renewDepsClaim(handle: DepsClaimHandle, log: Log): void {
  if (handle.login == null || handle.timer != null) return;
  const login = handle.login;
  handle.timer = setInterval(() => {
    void post({ target: handle.target, login }, 'pending', handlingLine(login, handle.target.action)).catch((err) =>
      log.warn({ err, prId: handle.target.prId }, 'dependency claim: renew failed'),
    );
  }, DEPS_CLAIM_RENEW_MS);
  handle.timer.unref?.();
}

export type DepsClaimEnd =
  | { outcome: 'done'; pushedSha?: string | null }
  | { outcome: 'failed' }
  /** Nothing was written: the claim is given back. */
  | { outcome: 'released'; why: string };

/**
 * After an AI run PUSHED `pushedSha`: the AI-pushed line on THAT commit, so every machine's merge
 * sweep waits for its CI to go green (`decideDepsClaim` 'awaiting_ci'). Never throws; an unmarked
 * handle posts nothing.
 */
export async function markAiPushedHead(handle: DepsClaimHandle, pushedSha: string, log: Log): Promise<void> {
  if (handle.login == null) return;
  const t = handle.target;
  try {
    await github.postLine(t.accountId, t.owner, t.name, pushedSha, DEPENDENCY_CLAIM_CONTEXT, {
      state: 'success',
      description: aiPushedLine(handle.login),
    });
  } catch (err) {
    log.warn({ err, prId: t.prId }, 'dependency claim: AI-pushed line not posted');
  }
}

/** The final line. Never throws; an unmarked handle posts nothing. */
export async function endDepsClaim(handle: DepsClaimHandle, end: DepsClaimEnd, log: Log): Promise<void> {
  if (handle.timer != null) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  if (handle.login == null) return;
  const { login, target } = handle;
  const description =
    end.outcome === 'done'
      ? doneLine(login, target.action, end.pushedSha ?? null)
      : end.outcome === 'failed'
        ? failedLine(login, target.action)
        : releaseLine(login, end.why);
  try {
    await post({ target, login }, 'success', description);
  } catch (err) {
    // The pending line stays up; teammates treat it as stale after the TTL.
    log.warn({ err, prId: target.prId }, 'dependency claim: final line not posted');
  }
}

// ---- the hold memory (in process; a restart forgets it and reads GitHub once) ----

// `${accountId}:${prId}:${headSha}:${family | '*'}` → recheck at. A teammate HANDLING the PR holds
// every family ('*'); one who HANDLED an action holds that family only.
const holds = new Map<string, number>();
const HOLDS_MAX = 2000;
const holdKey = (accountId: number, prId: number, headSha: string, family: DepsFamily | '*'): string =>
  `${accountId}:${prId}:${headSha}:${family}`;

/** Remember a teammate's hold so the next ticks don't re-read GitHub before it can have changed. */
export function rememberDepsHold(
  target: Pick<DepsClaimTarget, 'accountId' | 'prId' | 'headSha' | 'action'>,
  hold: DepsHold,
  nowMs: number = Date.now(),
): void {
  if (holds.size >= HOLDS_MAX) holds.clear();
  if (hold.kind === 'handling') {
    holds.set(holdKey(target.accountId, target.prId, target.headSha, '*'), hold.leaseEndsAtMs + 30_000);
  } else {
    holds.set(holdKey(target.accountId, target.prId, target.headSha, familyOfAction(target.action)), nowMs + DEPS_HANDLED_RECHECK_MS);
  }
}

/** An AI-pushed head whose CI is not green is looked at again after this long (merge only). */
export const DEPS_AWAITING_CI_RECHECK_MS = 5 * 60_000;

/** Remember an AI-pushed head waiting for green CI, so the merge sweep does not re-read it every tick. */
export function rememberDepsAwaitingCi(
  target: Pick<DepsClaimTarget, 'accountId' | 'prId' | 'headSha'>,
  nowMs: number = Date.now(),
): void {
  if (holds.size >= HOLDS_MAX) holds.clear();
  holds.set(holdKey(target.accountId, target.prId, target.headSha, 'merge'), nowMs + DEPS_AWAITING_CI_RECHECK_MS);
}

/** Is this head held by a teammate per the memory (no GitHub read needed yet)? `family` null asks
 *  only about a hold on every action (a teammate handling the PR now). */
export function depsHeldNow(
  accountId: number,
  prId: number,
  headSha: string,
  family: DepsFamily | null,
  nowMs: number = Date.now(),
): boolean {
  const all = holds.get(holdKey(accountId, prId, headSha, '*'));
  if (all != null && nowMs < all) return true;
  if (family == null) return false;
  const one = holds.get(holdKey(accountId, prId, headSha, family));
  return one != null && nowMs < one;
}

/** Test hook. */
export function _resetDepsClaimsForTest(): void {
  holds.clear();
  github = defaultTeamClaimGithub;
}
