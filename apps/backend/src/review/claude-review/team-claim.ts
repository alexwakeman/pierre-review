// TEAM CLAIMS — "Mark auto reviews on GitHub" (docs/CLAUDE-REVIEW.md § Team claims).
//
// Limn runs on each person's machine. When several people on one team switch auto review on for the
// same repos, every install would review every new head. With this switch on (per workspace, OFF by
// default, `workspaces.team_claims_enabled`), an AUTO review marks the PR's head commit with a GitHub
// COMMIT STATUS before it runs, so a teammate's Limn sees the line and skips that head:
//
//     context  limn/review-claude | limn/review-codex   (ONE per provider family, the RUN's provider —
//                                                         a different provider still reviews)
//     pending  "alex is reviewing with Claude"          (the claim; renewed every TEAM_CLAIM_RENEW_MS)
//     success  "alex reviewed · 4 comments"             (target_url = the posted GitHub review, if any)
//     pending  "alex's review didn't finish · free to claim"   (a failure or a Stop; the phrase frees it)
//     success  "Cleared by alex"                        (the reader's Clear; reads as free)
//
// ⚠ AUTO REVIEWS ONLY (the tick AND the reader's "Run auto reviews now" / Retry). A manual run never
//   claims and never checks claims.
// ⚠ WHO and WHEN come from GitHub, never from the description: the line's `creator.login` and its
//   `created_at` (the lease runs TEAM_CLAIM_LEASE_MS from the claimant's NEWEST line). Descriptions
//   are for people; only the two FREE phrases ("free to claim", "Cleared by") are read back.
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
//   still honoured. A status write is NEVER retried (a renew is a new line, not a retry).
import type {
  AiProviderId,
  ClaudeTeamClaimPending,
  ClaudeTeamClaimRecord,
  ClaudeTeamClaimSkip,
} from '@pierre-review/shared';
import { aiProviderName } from '@pierre-review/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';

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

/** The status context for a provider family. */
export function teamClaimContext(provider: AiProviderId): string {
  return provider === 'codex' ? 'limn/review-codex' : 'limn/review-claude';
}

const clamp = (s: string): string =>
  s.length <= TEAM_CLAIM_DESCRIPTION_MAX ? s : `${s.slice(0, TEAM_CLAIM_DESCRIPTION_MAX - 1)}…`;

export function reviewingLine(login: string, provider: AiProviderId): string {
  return clamp(`${login} is reviewing with ${aiProviderName(provider)}`);
}
/** `comments`: inline/PR comments the auto-post put on GitHub; null = nothing posted (kept in Limn). */
export function reviewedLine(login: string, comments: number | null): string {
  if (comments == null) return clamp(`${login} reviewed · kept in Limn`);
  return clamp(`${login} reviewed · ${comments === 0 ? 'no' : comments} comment${comments === 1 ? '' : 's'}`);
}
export function unfinishedLine(login: string): string {
  return clamp(`${login}'s review didn't finish · ${FREE_PHRASE}`);
}
export function clearedLine(login: string): string {
  return clamp(`${CLEARED_PREFIX}${login}`);
}

/** One status line of ONE context, as GitHub lists it. */
export interface TeamClaimLine {
  id: number;
  state: string; // pending | success | failure | error
  description: string | null;
  createdAtMs: number;
  login: string | null; // the line's creator
}

const isFreeLine = (l: TeamClaimLine): boolean =>
  (l.state === 'pending' && (l.description ?? '').includes(FREE_PHRASE)) ||
  (l.state === 'success' && (l.description ?? '').startsWith(CLEARED_PREFIX));
const settles = (l: TeamClaimLine): boolean => l.state !== 'pending' || isFreeLine(l);
const sameLogin = (a: string | null, b: string | null): boolean =>
  a != null && b != null && a.toLowerCase() === b.toLowerCase();
const order = (a: TeamClaimLine, b: TeamClaimLine): number => a.createdAtMs - b.createdAtMs || a.id - b.id;

export type TeamClaimDecision =
  | { kind: 'free' }
  // The reader's own live claim (a restart mid-run, another of their machines): theirs to take.
  | { kind: 'mine' }
  | { kind: 'reviewed'; login: string; atMs: number }
  | {
      kind: 'reviewing';
      login: string;
      // The holder's first line in this race (the "earliest wins" key) and its newest (the lease).
      firstAtMs: number;
      leaseEndsAtMs: number;
      // The holder's own description, for a loser's re-post.
      description: string | null;
    };

/**
 * THE ONE FOLD over one context's history (any order). Pure. `me` is the reader's GitHub login.
 */
export function decideTeamClaim(lines: readonly TeamClaimLine[], me: string | null, nowMs: number): TeamClaimDecision {
  if (lines.length === 0) return { kind: 'free' };
  const sorted = [...lines].sort(order);
  const last = sorted[sorted.length - 1]!;
  if (last.state === 'success') {
    if (isFreeLine(last) || sameLogin(last.login, me) || last.login == null) return { kind: 'free' };
    return { kind: 'reviewed', login: last.login, atMs: last.createdAtMs };
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
    const { accountGithubLogin } = await import('../../db/review-threads-for-review.js');
    return accountGithubLogin(accountId);
  },
};

const enc = (s: string): string => encodeURIComponent(s);

/** A write GitHub refused for lack of access (403 / 404): run without a line, never retry. */
export function isNoAccessError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

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
const skips = new Map<string, SkipEntry>(); // `${accountId}:${prId}`

/** Test hook. */
export function _resetTeamClaimsForTest(): void {
  skips.clear();
}

/** The remembered skip for this PR at `headSha` (any provider when `headSha` is null). */
export function teamClaimSkipFor(accountId: number, prId: number, headSha: string | null): ClaudeTeamClaimSkip | null {
  const e = skips.get(`${accountId}:${prId}`);
  if (!e) return null;
  if (headSha != null && e.skip.headSha !== headSha) return null;
  return e.skip;
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
  const e = skips.get(`${accountId}:${prId}`);
  return e && nowMs < e.recheckAtMs ? e.skip.headSha : null;
}

function rememberSkip(accountId: number, prId: number, skip: ClaudeTeamClaimSkip, recheckAtMs: number): void {
  skips.set(`${accountId}:${prId}`, { skip, recheckAtMs });
}
function forgetSkip(accountId: number, prId: number): void {
  skips.delete(`${accountId}:${prId}`);
}

// ---- the workspace switch ----

/** Is "Mark auto reviews on GitHub" on for the workspace holding this PR's repo? Only a stored true. */
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
  return rows[0]?.on === true;
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
}

/** A claim this run holds (or a run that went ahead without one: `record.state === 'unmarked'`). */
export interface TeamClaimHandle {
  target: TeamClaimTarget;
  login: string;
  record: ClaudeTeamClaimRecord;
  /** Only a 'marked' claim posts more lines. */
  marked: boolean;
  timer: ReturnType<typeof setInterval> | null;
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
  const mem = skips.get(`${accountId}:${prId}`);
  if (mem && mem.skip.headSha === headSha && mem.skip.provider === provider && !opts.pressed && now() < mem.recheckAtMs) {
    return { kind: 'skip', skip: mem.skip };
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

  // STEP 1 — read and decide.
  let lines: TeamClaimLine[];
  try {
    lines = await gh.listLines(accountId, owner, name, headSha, context);
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: statuses unreadable (${errText(err)}); reviewing without a line`);
    return unmarked(login, isNoAccessError(err) ? 'no_access' : 'error');
  }
  const first = decideTeamClaim(lines, login, now());
  const skipOf = (d: Extract<TeamClaimDecision, { kind: 'reviewed' | 'reviewing' }>): TeamClaimStart => {
    const skip: ClaudeTeamClaimSkip = {
      provider,
      kind: d.kind,
      login: d.login,
      headSha,
      at: nowIso(d.kind === 'reviewed' ? d.atMs : d.firstAtMs),
    };
    rememberSkip(
      accountId,
      prId,
      skip,
      d.kind === 'reviewed' ? now() + TEAM_CLAIM_REVIEWED_RECHECK_MS : d.leaseEndsAtMs + 30_000,
    );
    return { kind: 'skip', skip };
  };
  if (first.kind === 'reviewed' || first.kind === 'reviewing') return skipOf(first);
  forgetSkip(accountId, prId);

  // STEP 2 — claim, then re-read: the earliest live claimant wins.
  const description = reviewingLine(login, provider);
  try {
    await gh.postLine(accountId, owner, name, headSha, context, { state: 'pending', description });
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: status not written (${errText(err)}); reviewing without a line`);
    return unmarked(login, isNoAccessError(err) ? 'no_access' : 'error');
  }
  const marked = (): TeamClaimStart => ({
    kind: 'run',
    handle: {
      target,
      login,
      marked: true,
      timer: null,
      record: { context, state: 'marked', reason: null, lastLine: 'reviewing', at: nowIso(now()) },
    },
  });
  let after: TeamClaimLine[];
  try {
    after = await gh.listLines(accountId, owner, name, headSha, context);
  } catch {
    return marked(); // our line is up; nothing says anyone else's is earlier
  }
  const second = decideTeamClaim(after, login, now());
  if (second.kind !== 'reviewing' && second.kind !== 'reviewed') return marked();
  // We lost: stand down. Under a pending race, re-post the winner's line so GitHub's displayed
  // latest line names them (a success that landed after ours is already the latest line).
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

/** Stop the renew timer (every exit path). */
export function stopTeamClaimRenew(handle: TeamClaimHandle): void {
  if (handle.timer) clearInterval(handle.timer);
  handle.timer = null;
}

export type TeamClaimFinish =
  | { kind: 'succeeded'; comments: number | null; reviewUrl: string | null }
  | { kind: 'unfinished' };

/**
 * Steps 4-5: the final line (success, or "didn't finish · free to claim"), and the run row's
 * record. Never throws. A handle that is not marked posts nothing.
 */
export async function finishTeamClaim(
  ctx: AgentContext,
  handle: TeamClaimHandle,
  reviewId: number | null,
  outcome: TeamClaimFinish,
  gh: TeamClaimGithub = defaultTeamClaimGithub,
): Promise<void> {
  stopTeamClaimRenew(handle);
  if (!handle.marked) return;
  const { accountId, prId, owner, name, headSha, provider } = handle.target;
  const post: TeamClaimPost =
    outcome.kind === 'succeeded'
      ? { state: 'success', description: reviewedLine(handle.login, outcome.comments), targetUrl: outcome.reviewUrl }
      : { state: 'pending', description: unfinishedLine(handle.login) };
  try {
    await gh.postLine(accountId, owner, name, headSha, teamClaimContext(provider), post);
    handle.record = {
      ...handle.record,
      lastLine: outcome.kind === 'succeeded' ? 'reviewed' : 'unfinished',
      at: new Date().toISOString(),
    };
  } catch (err) {
    ctx.log.warn(`team claim pr ${prId}: final line not written: ${errText(err)}`);
  }
  if (reviewId != null) await saveTeamClaimRecord(ctx, reviewId, handle.record).catch(() => {});
}

/** Write a run's record (`claude_reviews.team_claim`). */
export async function saveTeamClaimRecord(ctx: AgentContext, reviewId: number, record: ClaudeTeamClaimRecord): Promise<void> {
  const cr = ctx.schema.claudeReviews;
  await ctx.db.update(cr).set({ teamClaim: record }).where(eq(cr.id, reviewId)).execute();
}

// ---- the pending line a Clear would replace ----

/**
 * The pending Limn line at the PR's current head that "Clear" would replace (DB + memory only): a
 * teammate's live claim this Limn skipped for, else this machine's latest run at the head whose
 * last line is pending (unfinished, or a crash mid-run) and that is not running now.
 */
export async function teamClaimPendingFor(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string | null,
  running: boolean,
): Promise<ClaudeTeamClaimPending | null> {
  if (!headSha) return null;
  const skip = teamClaimSkipFor(accountId, prId, headSha);
  if (skip?.kind === 'reviewing') return { provider: skip.provider, login: skip.login, mine: false };
  if (running) return null;
  const cr = ctx.schema.claudeReviews;
  const rows = (await ctx.db
    .select({ teamClaim: cr.teamClaim, provider: cr.provider })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.headSha, headSha), eq(cr.trigger, 'auto')))
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{ teamClaim: ClaudeTeamClaimRecord | null; provider: string | null }>;
  const rec = rows[0]?.teamClaim;
  if (!rec || rec.state !== 'marked') return null;
  if (rec.lastLine !== 'unfinished' && rec.lastLine !== 'reviewing') return null;
  const provider: AiProviderId = rec.context === 'limn/review-codex' ? 'codex' : 'claude';
  const login = (await defaultTeamClaimGithub.login(accountId).catch(() => null)) ?? 'you';
  return { provider, login, mine: true };
}

/**
 * CLEAR: post "Cleared by <login>" (success — free to every Limn) at the PR's current head for one
 * provider. Never retried. Forgets the skip and marks this machine's latest record at the head
 * cleared, so the button goes.
 */
export async function clearTeamClaim(
  ctx: AgentContext,
  target: TeamClaimTarget,
  gh: TeamClaimGithub = defaultTeamClaimGithub,
): Promise<{ ok: true } | { ok: false; error: 'no_access' | 'error'; message: string }> {
  const { accountId, prId, owner, name, headSha, provider } = target;
  const login = (await gh.login(accountId).catch(() => null)) ?? null;
  if (!login) return { ok: false, error: 'error', message: 'Your GitHub login is not known yet.' };
  try {
    await gh.postLine(accountId, owner, name, headSha, teamClaimContext(provider), {
      state: 'success',
      description: clearedLine(login),
    });
  } catch (err) {
    return isNoAccessError(err)
      ? { ok: false, error: 'no_access', message: 'GitHub refused: you need write access to this repo.' }
      : { ok: false, error: 'error', message: errText(err).slice(0, 200) };
  }
  const mem = skips.get(`${accountId}:${prId}`);
  if (mem && mem.skip.provider === provider) forgetSkip(accountId, prId);
  const cr = ctx.schema.claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id, teamClaim: cr.teamClaim })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.headSha, headSha), eq(cr.trigger, 'auto')))
    .orderBy(desc(cr.id))
    .limit(1)
    .execute()) as Array<{ id: number; teamClaim: ClaudeTeamClaimRecord | null }>;
  const row = rows[0];
  if (row?.teamClaim && row.teamClaim.context === teamClaimContext(provider)) {
    await saveTeamClaimRecord(ctx, row.id, { ...row.teamClaim, lastLine: 'cleared', at: new Date().toISOString() });
  }
  return { ok: true };
}
