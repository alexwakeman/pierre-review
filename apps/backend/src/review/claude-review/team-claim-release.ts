// RELEASING STALE TEAM-CLAIM LINES (docs/CLAUDE-REVIEW.md § Team claims → Releasing stale lines).
//
// A `limn/review-*` line this machine posted must never stay PENDING once no review of ours is going:
// a pending line holds the commit for every teammate's Limn and shows as a yellow check on the PR. A
// run's own end posts its final line (team-claim.ts `finishTeamClaim`); this module catches whatever
// that missed — Limn restarted mid-run, a run dropped before it started, a final write GitHub did not
// take, an older Limn's pending "free to claim" line (backfilled into the ledger by migration 0138).
//
//   OUR LINES (`releaseStaleOwnClaims`): every OPEN ledger row ('claiming' / 'pending') whose run is
//     not queued, starting or running in this process (`busy`) and whose final line is not being
//     written right now is checked against GitHub. ⚠ ONLY when the head's NEWEST line for the context
//     is still OUR pending one does it get the release line: success "Cleared by <login>: review
//     didn't finish · free to claim" (or the success line the run's end could not write). A newer line
//     by a teammate (they claimed or reviewed while we were down), one of ours already settled, or no
//     line at all ⇒ the row is closed and NOTHING is posted, so a release never overwrites a
//     teammate's claim or review. Status writes are idempotent, so a failure is retried on later ticks
//     with backoff, at most RELEASE_MAX_ATTEMPTS times (then logged and left out of the read; Clear
//     still works). 403/404 ⇒ closed with the error (no access: nothing we can do). A rate limit ⇒
//     left for a later tick, and the pass stops (`noteLimited` already told the budget). A release is
//     registered in flight (`trackClaimRelease`) and a claim at that head waits for it, so it never
//     lands after the claim's own pending line. ⚠ It never reads the team-claims switch: a workspace
//     switched OFF after claiming still gets its lines released. The row's own owner/name let it
//     release a line after the PR or repo left Limn (the delete paths keep open rows).
//   TEAMMATES' LINES (`releaseExpiredTeammateLines`): a "being reviewed by @bob" skip this Limn
//     remembered, whose lease has ended and whose PR the sweeper did not take back: if the head's
//     newest line is still bob's pending one (expired, or an older Limn's pending "free to claim"),
//     post "Cleared by alex: bob's claim expired" ONCE (recorded in the ledger) — only where the workspace
//     has team claims on. A Limn that claims the head itself needs none of this: its own pending line
//     replaces bob's.
//
// Runs once at boot (non-blocking, never fails the boot) and after every auto-review tick. Never inside
// a transaction; every GitHub call is outside any DB write.
import type { AiProviderId } from '@pierre-review/shared';
import { and, eq } from 'drizzle-orm';
import type { AgentContext } from '../agent-context.js';
import {
  claimErrorKind,
  claimLineFinishing,
  defaultTeamClaimGithub,
  expiredReviewingSkips,
  forgetTeamClaimSkip,
  newestLine,
  releasedLine,
  sameGithubLogin,
  staleTeammateLine,
  teamClaimContext,
  teamClaimsOnForPr,
  trackClaimRelease,
  unfinishedLine,
  type TeamClaimGithub,
  type TeamClaimLine,
} from './team-claim.js';
import {
  RELEASE_MAX_ATTEMPTS,
  openClaimLines,
  recordTeammateRelease,
  setClaimLine,
  teammateLineReleased,
  type ClaimLineRow,
} from './team-claim-ledger.js';

export { RELEASE_MAX_ATTEMPTS };
/** The wait before retry n (1-based): 1, 2, 4, 8 minutes. */
export function releaseBackoffMs(attempts: number): number {
  return attempts <= 0 ? 0 : 60_000 * 2 ** Math.min(attempts - 1, 6);
}

export interface ReleaseDeps {
  /** Is a run of this process still holding `provider`'s line at `headSha` on this PR? */
  busy: (accountId: number, prId: number, provider: AiProviderId, headSha: string) => boolean;
  /** Is a review of this PR queued, starting or running in this process (the teammate pass)? */
  held?: (prId: number) => boolean;
  gh?: TeamClaimGithub;
  nowMs?: number;
}

export interface ReleaseResult {
  released: number;
  finished: number;
  failed: number;
  gaveUp: number;
  limited: boolean;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function prRepo(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<{ owner: string; name: string } | null> {
  const { pullRequests: prs, repos } = ctx.schema;
  const rows = (await ctx.db
    .select({ owner: repos.owner, name: repos.name })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ owner: string; name: string }>;
  return rows[0] ?? null;
}

let releasing = false;

/** Test hook. */
export function _resetTeamClaimReleaseForTest(): void {
  releasing = false;
}

type RowOutcome =
  | { kind: 'released' }
  | { kind: 'finished' }
  | { kind: 'closed'; why: string; state: 'released' | 'finished' }
  | { kind: 'busy' }
  | { kind: 'limited' }
  | { kind: 'no_access' }
  | { kind: 'failed'; error: string };

/**
 * ONE row's release, decided from GitHub's own history (never blind): post only when the head's
 * NEWEST line for the context is still OUR pending one. A newer line by someone else (a teammate
 * claimed or reviewed meanwhile: a long restart, a backoff, a backfilled row) or one of ours already
 * settled is left as it is, and the row is closed. No line at all ⇒ nothing reached GitHub: closed.
 */
async function releaseOne(
  deps: ReleaseDeps,
  gh: TeamClaimGithub,
  row: ClaimLineRow,
  where: { owner: string; name: string },
  provider: AiProviderId,
  me: string,
): Promise<RowOutcome> {
  const context = teamClaimContext(provider);
  const failure = (err: unknown): RowOutcome => {
    const kind = claimErrorKind(err, row.accountId);
    if (kind === 'rate_limited') return { kind: 'limited' };
    if (kind === 'no_access') return { kind: 'no_access' };
    return { kind: 'failed', error: errText(err) };
  };
  let lines: TeamClaimLine[];
  try {
    lines = await gh.listLines(row.accountId, where.owner, where.name, row.headSha, context);
  } catch (err) {
    return failure(err);
  }
  const last = newestLine(lines);
  if (!last) return { kind: 'closed', why: 'no line', state: 'released' };
  if (!sameGithubLogin(last.login, me)) return { kind: 'closed', why: 'superseded', state: 'released' };
  if (last.state !== 'pending') {
    // Ours and settled already (e.g. a final write that landed though it read as failed).
    return { kind: 'closed', why: 'settled', state: row.finalDescription != null ? 'finished' : 'released' };
  }
  // ⚠ Asked again after the read: a run may have started on this head meanwhile.
  if (deps.busy(row.accountId, row.prId, provider, row.headSha)) return { kind: 'busy' };
  const finalLine = row.finalDescription != null;
  try {
    await gh.postLine(row.accountId, where.owner, where.name, row.headSha, context, {
      state: 'success',
      description: finalLine ? row.finalDescription! : unfinishedLine(me),
      ...(finalLine && row.finalTargetUrl ? { targetUrl: row.finalTargetUrl } : {}),
    });
  } catch (err) {
    return failure(err);
  }
  return finalLine ? { kind: 'finished' } : { kind: 'released' };
}

/** OUR open lines whose run is over: release them (see the header). Never throws. */
export async function releaseStaleOwnClaims(ctx: AgentContext, deps: ReleaseDeps): Promise<ReleaseResult> {
  const out: ReleaseResult = { released: 0, finished: 0, failed: 0, gaveUp: 0, limited: false };
  if (releasing) return out; // a slow pass is still going: the next tick picks up the rest
  releasing = true;
  const gh = deps.gh ?? defaultTeamClaimGithub;
  const nowMs = deps.nowMs ?? Date.now();
  try {
    let rows: ClaimLineRow[];
    try {
      rows = await openClaimLines(ctx);
    } catch (err) {
      ctx.log.warn(`team claim release: ledger unreadable: ${errText(err)}`);
      return out;
    }
    const logins = new Map<number, string | null>();
    const fail = async (row: ClaimLineRow, provider: AiProviderId, error: string): Promise<void> => {
      const attempts = row.releaseAttempts + 1;
      await setClaimLine(ctx, row.id, { releaseAttempts: attempts, lastError: error }).catch(() => {});
      out.failed += 1;
      if (attempts >= RELEASE_MAX_ATTEMPTS) {
        out.gaveUp += 1;
        ctx.log.warn(
          `team claim pr ${row.prId}: could not release the ${provider} line at ${row.headSha.slice(0, 7)} after ${attempts} tries (${error}); Clear it from the AI Review tab`,
        );
      }
    };
    for (const row of rows) {
      const provider: AiProviderId = row.provider === 'codex' ? 'codex' : 'claude';
      if (row.releaseAttempts >= RELEASE_MAX_ATTEMPTS) continue;
      if (deps.busy(row.accountId, row.prId, provider, row.headSha)) continue;
      if (claimLineFinishing(row.id, nowMs)) continue;
      const lastAt = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt);
      if (row.releaseAttempts > 0 && nowMs < lastAt + releaseBackoffMs(row.releaseAttempts)) continue;
      // Where: the row's own owner/name (kept even after the PR or repo left Limn), else the PR's repo.
      let where: { owner: string; name: string } | null;
      if (row.owner && row.name) where = { owner: row.owner, name: row.name };
      else {
        try {
          where = await prRepo(ctx, row.accountId, row.prId);
        } catch (err) {
          // A lookup that THREW is not "gone": tried again later.
          await fail(row, provider, errText(err));
          continue;
        }
      }
      if (!where) {
        await setClaimLine(ctx, row.id, { state: 'released', lastError: 'pull request gone' }).catch(() => {});
        continue;
      }
      let me = row.login;
      if (me == null) {
        if (!logins.has(row.accountId)) logins.set(row.accountId, await gh.login(row.accountId).catch(() => null));
        me = logins.get(row.accountId) ?? null;
      }
      if (me == null) {
        await fail(row, provider, 'GitHub login unknown');
        continue;
      }
      // ⚠ Asked again right before the release, with NO await between this check and its registration
      // (`trackClaimRelease`): a claim that starts at this head from here on waits for the release.
      if (deps.busy(row.accountId, row.prId, provider, row.headSha)) continue;
      const at = { accountId: row.accountId, prId: row.prId, headSha: row.headSha, provider };
      const login = me;
      const target = where;
      const res = await trackClaimRelease(at, () => releaseOne(deps, gh, row, target, provider, login));
      if (res.kind === 'busy') continue;
      if (res.kind === 'limited') {
        out.limited = true;
        break; // the budget waits; so does every other row
      }
      if (res.kind === 'no_access') {
        await setClaimLine(ctx, row.id, { state: 'released', lastError: 'no_access' }).catch(() => {});
        continue;
      }
      if (res.kind === 'failed') {
        await fail(row, provider, res.error);
        continue;
      }
      if (res.kind === 'closed') {
        await setClaimLine(ctx, row.id, { state: res.state, lastError: res.why }).catch(() => {});
        continue;
      }
      await setClaimLine(ctx, row.id, { state: res.kind, lastError: null }).catch(() => {});
      if (res.kind === 'finished') out.finished += 1;
      else out.released += 1;
      // The run row's record reads "Marked on GitHub" either way; a run that died mid-way says its line
      // was released.
      if (res.kind === 'released' && row.reviewId != null) await markRecordUnfinished(ctx, row.reviewId).catch(() => {});
    }
    return out;
  } catch (err) {
    ctx.log.warn(`team claim release: ${errText(err)}`);
    return out;
  } finally {
    releasing = false;
  }
}

async function markRecordUnfinished(ctx: AgentContext, reviewId: number): Promise<void> {
  const cr = ctx.schema.claudeReviews;
  const rows = (await ctx.db.select({ teamClaim: cr.teamClaim }).from(cr).where(eq(cr.id, reviewId)).limit(1).execute()) as Array<{
    teamClaim: { lastLine?: string | null } | null;
  }>;
  const rec = rows[0]?.teamClaim;
  if (!rec || rec.lastLine !== 'reviewing') return;
  await ctx.db
    .update(cr)
    .set({ teamClaim: { ...rec, lastLine: 'unfinished', at: new Date().toISOString() } })
    .where(eq(cr.id, reviewId))
    .execute();
}

/** TEAMMATES' expired lines this Limn skipped for (see the header). Never throws. */
export async function releaseExpiredTeammateLines(ctx: AgentContext, deps: ReleaseDeps): Promise<{ released: number; limited: boolean }> {
  const out = { released: 0, limited: false };
  const gh = deps.gh ?? defaultTeamClaimGithub;
  const nowMs = deps.nowMs ?? Date.now();
  for (const { accountId, prId, skip } of expiredReviewingSkips(nowMs)) {
    try {
      if (deps.held?.(prId)) continue; // the sweeper took it back: its own claim replaces the line
      if (!(await teamClaimsOnForPr(ctx, accountId, prId))) {
        forgetTeamClaimSkip(accountId, prId);
        continue;
      }
      if (await teammateLineReleased(ctx, accountId, prId, skip.headSha, skip.provider, skip.login)) {
        forgetTeamClaimSkip(accountId, prId);
        continue;
      }
      const where = await prRepo(ctx, accountId, prId);
      const me = await gh.login(accountId).catch(() => null);
      if (!where || !me) continue;
      const context = teamClaimContext(skip.provider);
      const lines = await gh.listLines(accountId, where.owner, where.name, skip.headSha, context);
      const stale = staleTeammateLine(lines, me, nowMs);
      if (!stale) {
        forgetTeamClaimSkip(accountId, prId); // settled (or claimed again): nothing to release
        continue;
      }
      let lastError: string | null = null;
      try {
        await gh.postLine(accountId, where.owner, where.name, skip.headSha, context, {
          state: 'success',
          description: releasedLine(stale.login, me),
        });
        out.released += 1;
      } catch (err) {
        const kind = claimErrorKind(err, accountId);
        if (kind === 'rate_limited') {
          out.limited = true;
          break;
        }
        lastError = kind === 'no_access' ? 'no_access' : errText(err);
      }
      // Posted ONCE: recorded either way, so it is never re-posted every tick.
      await recordTeammateRelease(ctx, { accountId, prId, headSha: skip.headSha, provider: skip.provider, login: stale.login, lastError });
      forgetTeamClaimSkip(accountId, prId);
    } catch (err) {
      const kind = claimErrorKind(err, accountId);
      if (kind === 'rate_limited') {
        out.limited = true;
        break;
      }
      ctx.log.warn(`team claim pr ${prId}: teammate line not checked: ${errText(err)}`);
    }
  }
  return out;
}

/**
 * THE ONE ENTRY (boot + every auto-review tick): our lines first, then teammates' — the manager's
 * in-memory queue answers "is a run still holding it?". Never throws.
 */
export async function releaseStaleTeamClaims(ctx: AgentContext, gh?: TeamClaimGithub): Promise<void> {
  try {
    const { reviewClaimBusy, reviewHeldForPr } = await import('./manager.js');
    const deps: ReleaseDeps = { busy: reviewClaimBusy, held: reviewHeldForPr, ...(gh ? { gh } : {}) };
    const own = await releaseStaleOwnClaims(ctx, deps);
    if (own.limited) return;
    await releaseExpiredTeammateLines(ctx, deps);
  } catch (err) {
    ctx.log.warn(`team claim release: ${errText(err)}`);
  }
}
