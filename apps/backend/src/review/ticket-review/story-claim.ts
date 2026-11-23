// THE STORY CHECK'S OWN TEAM CLAIM (docs/TEAM-REVIEW.md § The story check's own claim; docs/CLAUDE-REVIEW.md
// § Team claims → The story check's claim). 2026-11-23.
//
// Not every teammate has story checks (a tracker set up, a ticket that resolves). A teammate WITHOUT them who
// claims a commit for the code review must not hold its story check. So the story check claims on its OWN
// commit status, beside the review's, with the SAME lifecycle — the same fold, lease, renewal, ledger,
// reconciler and never-blind final line (team-claim.ts):
//
//     context  ensemble/story-check   (ONE for the team, whichever model runs it: a story check is never a
//                                      pair, so a second model adds no second opinion — unlike the review's
//                                      one-per-provider contexts. An older `limn/story-check` would read the
//                                      same, `sameStatusContext`; no older version wrote one.)
//     pending  "alex is checking the story"                 (renewed every TEAM_CLAIM_RENEW_MS)
//     success  "alex checked the story · 3 gaps" / "· no gaps" / "· no new gaps"   (holds the commit)
//     success  "alex checked the story · kept in Ensemble"  (gaps found, nothing reached GitHub: FREE)
//     success  "Cleared by alex: story check didn't finish · free to claim"         (FREE)
//     success  "Cleared by alex: bob's claim expired"       (a teammate's stale line, released once)
//
// ⚠ PER MEMBER HEAD. A story check judges a TICKET: every open member PR at its head. Its line goes on each
//   open member's head (in the reader's repositories), so a push to ANY member frees that head and the next
//   story check is anyone's. The ONE rule (`decideStoryClaim`, pure): the per-head fold is
//   `decideTeamClaim` itself; a teammate holds the story check only when they hold EVERY open member head
//   (reviewed, or a live claim). Otherwise this Ensemble claims the free heads and runs. After posting it
//   re-reads: it stands down only when it lost EVERY head it claimed (a split race runs twice — a
//   duplicate, never a story check nobody runs).
// ⚠ THE PR AUTHOR'S LINES COUNT HERE (unlike the review's): a story check gives no verdict, so the author's
//   own Ensemble checking the story is as good as anyone's.
// ⚠ AUTOMATIC STORY CHECKS ONLY (the sweeper, sweep.ts). A click (Re-check) never claims and never waits.
// ⚠ A SKIP WRITES NO RUN ROW (no daily-cap use). It is remembered in memory per ticket and per set of heads
//   (`storyClaimSkipFor` — the states route says "@robin checked the story at these commits"); the next look
//   waits until the holder's lease ends, or TEAM_CLAIM_REVIEWED_RECHECK_MS after a "checked". A new head
//   reads GitHub at once. A restart forgets it.
// ⚠ NEVER BLOCKS A RUN ON GITHUB: no login, an unreadable head, a refused write ⇒ that head runs without a
//   line. ⚠ THE LEDGER FIRST: each head's row (`team_claim_lines`, provider 'story') is written BEFORE its
//   pending line; the reconciler (team-claim-release.ts) releases any open row no story check of this
//   process holds (`storyClaimBusy`).
import { and, eq, inArray } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';
import {
  STORY_CLAIM_KEY,
  TEAM_CLAIM_RENEW_MS,
  TEAM_CLAIM_REVIEWED_RECHECK_MS,
  claimErrorKind,
  decideTeamClaim,
  defaultTeamClaimGithub,
  newestLine,
  releaseContextOf,
  releasedLine,
  sameGithubLogin,
  staleTeammateLine,
  storyCheckedLine,
  storyCheckingLine,
  storyClaimContext,
  storyUnfinishedLine,
  teammateHolds,
  waitForClaimRelease,
  type TeamClaimDecision,
  type TeamClaimGithub,
  type TeamClaimLine,
} from '../claude-review/team-claim.js';
import { recordClaimIntent, recordTeammateRelease, setClaimLine, teammateLineReleased } from '../claude-review/team-claim-ledger.js';
import type { TicketAutoPostOutcome } from './auto-post.js';

/** One open member PR's head a story claim is written on. */
export interface StoryClaimHead {
  prId: number;
  owner: string;
  name: string;
  number: number;
  headSha: string;
}

export interface StoryClaimTarget {
  accountId: number;
  ident: string;
  heads: readonly StoryClaimHead[];
}

/** Who holds the story check of these heads, when a teammate holds them all. */
export interface StoryClaimHolder {
  kind: 'reviewing' | 'reviewed';
  login: string;
  atMs: number;
  // A live claim's lease end (the earliest among the heads); null for "checked".
  leaseEndsAtMs: number | null;
  description: string | null;
}

export type StoryClaimDecision =
  // Claim these heads (indexes into the heads read; [] = nothing to claim, run without a line).
  | { kind: 'claim'; heads: number[] }
  // A teammate holds every head: do not run.
  | { kind: 'held'; holder: StoryClaimHolder };

const holderOf = (d: Extract<TeamClaimDecision, { kind: 'reviewed' | 'reviewing' }>): StoryClaimHolder =>
  d.kind === 'reviewing'
    ? { kind: 'reviewing', login: d.login, atMs: d.firstAtMs, leaseEndsAtMs: d.leaseEndsAtMs, description: d.description }
    : { kind: 'reviewed', login: d.login, atMs: d.atMs, leaseEndsAtMs: null, description: d.description };

/**
 * THE ONE RULE (pure). `perHead`: each open member head's story-context lines (any order). Each head is
 * folded by `decideTeamClaim` (author lines count: no author is passed). A head that is free or the
 * reader's own is claimable; when none is (and there is at least one head) a teammate holds the story
 * check — named by a LIVE claim over a finished one (the wait ends at its lease), the earliest lease first.
 */
export function decideStoryClaim(
  perHead: ReadonlyArray<readonly TeamClaimLine[]>,
  me: string | null,
  nowMs: number,
): StoryClaimDecision {
  const claim: number[] = [];
  let holder: StoryClaimHolder | null = null;
  perHead.forEach((lines, i) => {
    const d = decideTeamClaim(lines, me, nowMs);
    if (d.kind === 'free' || d.kind === 'mine') {
      claim.push(i);
      return;
    }
    const h = holderOf(d);
    const better =
      holder == null ||
      (h.kind === 'reviewing' && (holder.kind !== 'reviewing' || (h.leaseEndsAtMs ?? 0) < (holder.leaseEndsAtMs ?? 0)));
    if (better) holder = h;
  });
  if (claim.length > 0 || holder == null) return { kind: 'claim', heads: claim };
  return { kind: 'held', holder };
}

/** When a held story check is read again: the holder's lease end (+30 s), or the "checked" recheck. */
export function storyRecheckAtMs(holder: StoryClaimHolder, nowMs: number): number {
  return holder.kind === 'reviewing' && holder.leaseEndsAtMs != null ? holder.leaseEndsAtMs + 30_000 : nowMs + TEAM_CLAIM_REVIEWED_RECHECK_MS;
}

/** The identity of a set of heads (order-free). */
export function storyHeadsKey(heads: ReadonlyArray<{ prId: number; headSha: string }>): string {
  return heads
    .map((h) => `${h.prId}:${h.headSha}`)
    .sort()
    .join(',');
}

export type StoryClaimFinish = { kind: 'succeeded'; gaps: number | null; alreadyPosted?: boolean } | { kind: 'unfinished' };

/**
 * WHAT A FINISHED STORY CHECK'S LINE SAYS (pure). From the run and what auto-posting did with it:
 * gaps posted ⇒ "N gaps"; nothing new to post ⇒ "no new gaps" (they are on GitHub already) or "no gaps"
 * (none found); found but NOT on GitHub (auto-posting off or refused, a post that failed, nowhere to post)
 * ⇒ null, "kept in Ensemble" — FREE, so a teammate's story check can still put the gaps on the PR. A run
 * that did not succeed ⇒ unfinished.
 */
export function storyCheckedSummary(
  run: { status: string; items: readonly unknown[]; assessment: { notRequested?: readonly unknown[] | null } | null } | null,
  out: TicketAutoPostOutcome | null,
): StoryClaimFinish {
  if (run == null || run.status !== 'succeeded') return { kind: 'unfinished' };
  const hasGaps = run.items.length > 0 || (run.assessment?.notRequested?.length ?? 0) > 0;
  if (out?.kind === 'done') {
    const posted =
      out.record.postedItemIds.length + out.record.notRequested.filter((n) => !n.carried && n.commentId != null).length;
    return { kind: 'succeeded', gaps: posted > 0 ? posted : null };
  }
  if (out?.kind === 'skipped' && out.reason === 'nothing_new') {
    return hasGaps ? { kind: 'succeeded', gaps: 0, alreadyPosted: true } : { kind: 'succeeded', gaps: 0 };
  }
  return { kind: 'succeeded', gaps: hasGaps ? null : 0 };
}

// ---- in-process state ----

export interface StoryClaimSkip {
  kind: 'reviewing' | 'reviewed';
  login: string;
  at: string;
  description: string | null;
  // `storyHeadsKey` of the heads it was read at.
  heads: string;
}

interface SkipEntry {
  skip: StoryClaimSkip;
  recheckAtMs: number;
  where: StoryClaimHead[];
}
const skips = new Map<string, SkipEntry>(); // `${accountId}:${ident}`
const skipKey = (accountId: number, ident: string): string => `${accountId}:${ident}`;

// `${accountId}:${prId}:${headSha}` → story checks of this process holding a line there.
const active = new Map<string, number>();
const activeKey = (accountId: number, prId: number, headSha: string): string => `${accountId}:${prId}:${headSha}`;
function hold(accountId: number, heads: readonly StoryClaimHead[]): void {
  for (const h of heads) {
    const k = activeKey(accountId, h.prId, h.headSha);
    active.set(k, (active.get(k) ?? 0) + 1);
  }
}
function unhold(accountId: number, heads: readonly StoryClaimHead[]): void {
  for (const h of heads) {
    const k = activeKey(accountId, h.prId, h.headSha);
    const n = (active.get(k) ?? 0) - 1;
    if (n > 0) active.set(k, n);
    else active.delete(k);
  }
}

/** Is a story check of this process still holding its line at this head (the reconciler asks)? */
export function storyClaimBusy(accountId: number, prId: number, headSha: string): boolean {
  return active.has(activeKey(accountId, prId, headSha));
}

/**
 * The remembered skip for this ticket at exactly these heads, while it still waits (before its recheck
 * time), else null. The states route shows it; the sweeper waits on it. Memory only.
 */
export function storyClaimSkipFor(
  accountId: number,
  ident: string,
  heads: ReadonlyArray<{ prId: number; headSha: string }>,
  nowMs: number,
): StoryClaimSkip | null {
  const e = skips.get(skipKey(accountId, ident));
  if (!e || nowMs >= e.recheckAtMs || e.skip.heads !== storyHeadsKey(heads)) return null;
  return e.skip;
}

/** Test hook. */
export function _resetStoryClaimsForTest(): void {
  skips.clear();
  active.clear();
}

// ---- the lifecycle ----

export interface StoryClaimHandleHead {
  head: StoryClaimHead;
  marked: boolean;
  ledgerId: number | null;
}

/** A story claim this run holds (heads with no line run unmarked). */
export interface StoryClaimHandle {
  target: StoryClaimTarget;
  login: string | null;
  heads: StoryClaimHandleHead[];
  timer: ReturnType<typeof setInterval> | null;
  done: boolean;
}

export type StoryClaimStart = { kind: 'run'; handle: StoryClaimHandle } | { kind: 'skip'; skip: StoryClaimSkip };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const nowIso = (ms: number): string => new Date(ms).toISOString();

/** The open member heads a story claim goes on: open members with a synced head, in this account's repos. */
export async function storyClaimHeads(
  ctx: AgentContext,
  accountId: number,
  members: ReadonlyArray<{ prId: number; headSha: string; state: string }>,
): Promise<StoryClaimHead[]> {
  const open = members.filter((m) => m.state === 'open' && m.headSha !== '');
  if (open.length === 0) return [];
  const { pullRequests: prs, repos } = ctx.schema;
  const rows = (await ctx.db
    .select({ prId: prs.id, number: prs.number, owner: repos.owner, name: repos.name })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(prs.accountId, accountId), inArray(prs.id, open.map((m) => m.prId))))
    .execute()) as Array<{ prId: number; number: number; owner: string; name: string }>;
  const byId = new Map(rows.map((r) => [r.prId, r]));
  const out: StoryClaimHead[] = [];
  for (const m of open) {
    const r = byId.get(m.prId);
    if (r) out.push({ prId: m.prId, owner: r.owner, name: r.name, number: r.number, headSha: m.headSha });
  }
  return out.sort((a, b) => `${a.owner}/${a.name}#${a.number}`.localeCompare(`${b.owner}/${b.name}#${b.number}`));
}

/**
 * Read, decide, claim, re-read, arbitrate — before an AUTOMATIC story check is queued. Never throws.
 * `skip`: a teammate holds every head (no run row is written). `run`: go ahead; the handle carries the
 * heads this Ensemble holds a line on (none when it could not claim any: it runs without a line).
 */
export async function claimStoryBeforeAutoRun(
  ctx: AgentContext,
  target: StoryClaimTarget,
  opts: { nowMs?: () => number } = {},
  gh: TeamClaimGithub = defaultTeamClaimGithub,
): Promise<StoryClaimStart> {
  const now = opts.nowMs ?? Date.now;
  const { accountId, ident, heads } = target;
  const context = storyClaimContext();
  const handle: StoryClaimHandle = {
    target,
    login: null,
    heads: heads.map((head) => ({ head, marked: false, ledgerId: null })),
    timer: null,
    done: false,
  };
  if (heads.length === 0) return { kind: 'run', handle };

  // A remembered skip at exactly these heads, still inside its wait: skip without a GitHub read.
  const mem = skips.get(skipKey(accountId, ident));
  if (mem && mem.skip.heads === storyHeadsKey(heads) && now() < mem.recheckAtMs) return { kind: 'skip', skip: mem.skip };

  const login = await gh.login(accountId).catch(() => null);
  if (!login) {
    ctx.log.warn(`story claim ${ident}: no GitHub login known; checking without a line`);
    return { kind: 'run', handle };
  }
  handle.login = login;
  // Held from here on: the reconciler leaves our rows on these heads alone until `finishStoryClaim`.
  hold(accountId, heads);

  // STEP 1 — read every head, decide. An unreadable head counts as free and gets no line.
  const perHead: TeamClaimLine[][] = [];
  const readable: boolean[] = [];
  for (const h of heads) {
    await waitForClaimRelease(accountId, h.prId, h.headSha, STORY_CLAIM_KEY);
    try {
      perHead.push(await gh.listLines(accountId, h.owner, h.name, h.headSha, context));
      readable.push(true);
    } catch (err) {
      ctx.log.warn(`story claim ${ident}: ${h.owner}/${h.name}#${h.number} statuses unreadable (${errText(err)}); no line there`);
      perHead.push([]);
      readable.push(false);
    }
  }
  const remember = (holder: StoryClaimHolder): StoryClaimStart => {
    const skip: StoryClaimSkip = {
      kind: holder.kind,
      login: holder.login,
      at: nowIso(holder.atMs),
      description: holder.description,
      heads: storyHeadsKey(heads),
    };
    skips.set(skipKey(accountId, ident), { skip, recheckAtMs: storyRecheckAtMs(holder, now()), where: [...heads] });
    unhold(accountId, heads);
    return { kind: 'skip', skip };
  };
  const first = decideStoryClaim(perHead, login, now());
  if (first.kind === 'held') return remember(first.holder);
  skips.delete(skipKey(accountId, ident));

  // STEP 2 — claim each free head (ledger first), then re-read: the earliest live claimant wins per head.
  for (const i of first.heads) {
    if (!readable[i]) continue;
    const slot = handle.heads[i]!;
    const h = slot.head;
    let ledgerId: number;
    try {
      ledgerId = await recordClaimIntent(ctx, {
        accountId,
        prId: h.prId,
        headSha: h.headSha,
        provider: STORY_CLAIM_KEY,
        login,
        owner: h.owner,
        name: h.name,
      });
    } catch (err) {
      ctx.log.warn(`story claim ${ident}: ledger not written (${errText(err)}); no line on #${h.number}`);
      continue;
    }
    try {
      await gh.postLine(accountId, h.owner, h.name, h.headSha, context, { state: 'pending', description: storyCheckingLine(login) });
    } catch (err) {
      const kind = claimErrorKind(err, accountId);
      ctx.log.warn(`story claim ${ident}: status not written on ${h.owner}/${h.name}#${h.number} (${errText(err)}); no line there`);
      // Refused or rate-limited: nothing landed. Any other failure may have: the row stays for the reconciler.
      await setClaimLine(ctx, ledgerId, kind === 'error' ? { lastError: errText(err) } : { state: 'released', lastError: kind }).catch(() => {});
      if (kind === 'error') slot.ledgerId = ledgerId;
      continue;
    }
    await setClaimLine(ctx, ledgerId, { state: 'pending' }).catch(() => {});
    slot.marked = true;
    slot.ledgerId = ledgerId;
  }
  const claimed = handle.heads.filter((s) => s.marked);
  if (claimed.length === 0) {
    startStoryClaimRenew(ctx, handle, gh);
    return { kind: 'run', handle };
  }
  let lost: StoryClaimHolder | null = null;
  for (const slot of claimed) {
    const h = slot.head;
    let after: TeamClaimLine[];
    try {
      after = await gh.listLines(accountId, h.owner, h.name, h.headSha, context);
    } catch {
      continue; // our line is up; nothing says anyone else's is earlier
    }
    const d = decideTeamClaim(after, login, now());
    if (d.kind !== 'reviewing' && d.kind !== 'reviewed') continue;
    // Lost this head: stand down here, and re-post the winner's live line so GitHub names them.
    slot.marked = false;
    if (slot.ledgerId != null) await setClaimLine(ctx, slot.ledgerId, { state: 'released', lastError: 'stood down' }).catch(() => {});
    slot.ledgerId = null;
    if (d.kind === 'reviewing') {
      await gh
        .postLine(accountId, h.owner, h.name, h.headSha, context, { state: 'pending', description: d.description ?? storyCheckingLine(d.login) })
        .catch((err) => ctx.log.warn(`story claim ${ident}: stand-down line not written: ${errText(err)}`));
    }
    const hd = holderOf(d);
    if (lost == null || (hd.kind === 'reviewing' && lost.kind !== 'reviewing')) lost = hd;
  }
  // Lost EVERY head it claimed: the teammates have it. (A row whose pending write may have landed is
  // released by the reconciler once these heads are no longer held.)
  if (lost != null && !handle.heads.some((s) => s.marked)) return remember(lost);
  startStoryClaimRenew(ctx, handle, gh);
  return { kind: 'run', handle };
}

/** Renew every marked head's pending line while the check waits and runs. Cleared by `finishStoryClaim`. */
export function startStoryClaimRenew(ctx: AgentContext, handle: StoryClaimHandle, gh: TeamClaimGithub = defaultTeamClaimGithub): void {
  if (handle.timer || handle.login == null || !handle.heads.some((s) => s.marked)) return;
  const login = handle.login;
  handle.timer = setInterval(() => {
    for (const s of handle.heads) {
      if (!s.marked) continue;
      const h = s.head;
      void gh
        .postLine(handle.target.accountId, h.owner, h.name, h.headSha, storyClaimContext(), { state: 'pending', description: storyCheckingLine(login) })
        .catch((err) => ctx.log.warn(`story claim ${handle.target.ident}: renew not written: ${errText(err)}`));
    }
  }, TEAM_CLAIM_RENEW_MS);
  handle.timer.unref?.();
}

/**
 * The final line on every head this check holds (once; never throws). A success ⇒ "alex checked the
 * story · …" (ledger 'finished'); anything else ⇒ the release line (ledger 'released'). ⚠ NEVER BLIND:
 * each head is read first — a teammate's newer success or live claim there stands and nothing is posted.
 * A final line GitHub did not take leaves its row open for the reconciler (it posts the same line).
 */
export async function finishStoryClaim(
  ctx: AgentContext,
  handle: StoryClaimHandle,
  outcome: StoryClaimFinish,
  gh: TeamClaimGithub = defaultTeamClaimGithub,
  nowMs: () => number = Date.now,
): Promise<void> {
  if (handle.done) return;
  handle.done = true;
  if (handle.timer) clearInterval(handle.timer);
  handle.timer = null;
  const { accountId, ident } = handle.target;
  const login = handle.login;
  try {
    if (login == null) return;
    const description =
      outcome.kind === 'succeeded' ? storyCheckedLine(login, outcome.gaps, outcome.alreadyPosted === true) : storyUnfinishedLine(login);
    for (const s of handle.heads) {
      if (s.ledgerId == null) continue;
      const h = s.head;
      if (!s.marked) {
        // A pending POST that failed in a way that may still have landed: the reconciler decides, with
        // THIS outcome's line for a check that succeeded.
        if (outcome.kind === 'succeeded') await setClaimLine(ctx, s.ledgerId, { finalDescription: description }).catch(() => {});
        continue;
      }
      let over: string | null = null;
      try {
        over = teammateHolds(await gh.listLines(accountId, h.owner, h.name, h.headSha, storyClaimContext()), login, nowMs());
      } catch (err) {
        ctx.log.warn(`story claim ${ident}: statuses unreadable before the final line (${errText(err)}); posting it`);
      }
      const settled = outcome.kind === 'succeeded' ? 'finished' : 'released';
      if (over != null) {
        ctx.log.info(`story claim ${ident}: final line not posted on #${h.number}: @${over} has it now`);
        await setClaimLine(ctx, s.ledgerId, { state: settled, lastError: 'superseded' }).catch(() => {});
        continue;
      }
      try {
        await gh.postLine(accountId, h.owner, h.name, h.headSha, storyClaimContext(), { state: 'success', description });
        await setClaimLine(ctx, s.ledgerId, { state: settled, lastError: null }).catch(() => {});
      } catch (err) {
        ctx.log.warn(`story claim ${ident}: final line not written on #${h.number}: ${errText(err)}`);
        const kind = claimErrorKind(err, accountId);
        await setClaimLine(
          ctx,
          s.ledgerId,
          kind === 'no_access'
            ? { state: 'released', lastError: 'no_access' }
            : { lastError: errText(err), ...(outcome.kind === 'succeeded' ? { finalDescription: description } : {}) },
        ).catch(() => {});
      }
    }
  } finally {
    if (login != null) unhold(accountId, handle.target.heads);
  }
}

/**
 * TEAMMATES' EXPIRED STORY LINES: a remembered "is checking the story" skip whose lease has ended and whose
 * ticket this Ensemble did not take back (no story check of it queued or running, `held`): on each head
 * whose newest line is still that teammate's stale pending one, post "Cleared by alex: bob's claim expired"
 * ONCE (recorded in the ledger). A story check that claims the heads itself needs none of this: its own
 * pending line replaces bob's. Never throws.
 */
export async function releaseExpiredStoryTeammateLines(
  ctx: AgentContext,
  deps: { gh?: TeamClaimGithub; nowMs?: number; held?: (accountId: number, ident: string) => boolean } = {},
): Promise<{ released: number; limited: boolean }> {
  const out = { released: 0, limited: false };
  const gh = deps.gh ?? defaultTeamClaimGithub;
  const nowMs = deps.nowMs ?? Date.now();
  const held =
    deps.held ??
    (await import('./manager.js').then(
      (m) => m.ticketReviewHeld,
      () => () => false,
    ));
  for (const [key, e] of [...skips]) {
    if (e.skip.kind !== 'reviewing' || nowMs < e.recheckAtMs) continue;
    const sep = key.indexOf(':');
    const accountId = Number(key.slice(0, sep));
    const ident = key.slice(sep + 1);
    if (held(accountId, ident)) continue;
    skips.delete(key);
    const me = await gh.login(accountId).catch(() => null);
    if (!me) continue;
    for (const h of e.where) {
      try {
        const lines = await gh.listLines(accountId, h.owner, h.name, h.headSha, storyClaimContext());
        const stale = staleTeammateLine(lines, me, nowMs);
        if (!stale || (await teammateLineReleased(ctx, accountId, h.prId, h.headSha, STORY_CLAIM_KEY, stale.login))) continue;
        let lastError: string | null = null;
        try {
          const theirs = newestLine(lines.filter((l) => sameGithubLogin(l.login, stale.login)));
          await gh.postLine(accountId, h.owner, h.name, h.headSha, releaseContextOf(theirs, storyClaimContext()), {
            state: 'success',
            description: releasedLine(stale.login, me),
          });
          out.released += 1;
        } catch (err) {
          const kind = claimErrorKind(err, accountId);
          if (kind === 'rate_limited') {
            out.limited = true;
            return out;
          }
          lastError = kind === 'no_access' ? 'no_access' : errText(err);
        }
        await recordTeammateRelease(ctx, { accountId, prId: h.prId, headSha: h.headSha, provider: STORY_CLAIM_KEY, login: stale.login, lastError });
      } catch (err) {
        if (claimErrorKind(err, accountId) === 'rate_limited') {
          out.limited = true;
          return out;
        }
        ctx.log.warn(`story claim ${ident}: teammate line not checked: ${errText(err)}`);
      }
    }
  }
  return out;
}
