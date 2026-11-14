// RELEASING, RETRYING AND RENEWING `limn/deps` LINES (docs/MERGE-CI-TRUNK.md § Team claims for dependency
// work → The ledger). The dependency automation's twin of review/claude-review/team-claim-release.ts,
// run once at boot (non-blocking) and after every auto-merge tick (sync/scheduler.ts). Never inside a
// transaction; every GitHub call is outside any DB write. Never throws.
//
//   OUR LINES (`deps_claim_lines`, whose 'mine', open): a row no claim of THIS process holds
//   (`depsClaimLive` — the row, or any line of ours at that head) is decided from GitHub, never blind:
//     • 'claiming' / 'pending' (Limn stopped mid-action, or a final write GitHub did not take): ONLY
//       when the head's NEWEST `limn/deps` line is still OUR pending one does it post — the line the
//       action could not write (`final_description`: "alex approved", "alex couldn't fix CI", a
//       stand-down), else "Cleared by alex: didn't finish · free to claim". A newer line by someone
//       else, one of ours already settled, or no line at all ⇒ the row is closed, nothing posted.
//     • 'armed' (an armed merge's line): while the reader's intent is still armed on that head, the
//       armed line is RE-POSTED every DEPS_ARMED_RENEW_MS (its lease, DEPS_ARMED_LEASE_MS, runs from the
//       newest one). The intent merged ⇒ closed. It ended unlanded (expired, failed, disarmed,
//       retargeted, gone, re-armed on another head) ⇒ "Cleared by alex: merge not armed any more · free
//       to claim", which frees the merge for a teammate at once.
//     • 'ai_pushed' (the line on a commit an AI run pushed, whose write GitHub did not take): posted
//       again unless one of ours is already on that commit.
//   Failures back off (1, 2, 4, 8 minutes), at most DEPS_RELEASE_MAX_ATTEMPTS times, then the row is
//   logged and left. 403/404 ⇒ closed (no access). A rate limit stops the pass (`noteLimited` told the
//   budget). Only status lines are ever retried here — never an approval, a comment, an arm or a push.
//
//   TEAMMATES' LINES: a teammate's PENDING line this Limn skipped for (a `skipped` row of
//   `dependency_automation_actions`, teammate_handled false — the durable record) whose lease has ended,
//   on the PR's current head: if the head's newest line is still that pending line, post "Cleared by
//   alex: robin's claim expired" ONCE (recorded as a 'teammate' row, posted or not). A Limn that claims
//   the head itself needs none of this: its own pending line replaces robin's, and the claim takes the
//   skip row over.
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DEPENDENCY_CLAIM_CONTEXT } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import {
  claimErrorKind,
  newestLine,
  releasedLine,
  sameGithubLogin,
  type TeamClaimGithub,
  type TeamClaimLine,
} from '../review/claude-review/team-claim.js';
import {
  ARMED_RELEASE_WHY,
  DEPS_ARMED_RENEW_MS,
  DEPS_HANDLED_RECHECK_MS,
  aiPushedLine,
  armedReleaseLine,
  decideDepsClaim,
  depsClaimGithub,
  depsClaimLive,
  depsHeldNow,
  doneLine,
  familyOfAction,
  isAiPushedLine,
  rememberDepsHold,
  releaseLine,
  staleTeammateDepsLine,
  type ClaimAction,
} from './deps-claim.js';
import {
  DEPS_RELEASE_MAX_ATTEMPTS,
  openDepsClaimLines,
  recordTeammateDepsRelease,
  teammateDepsLineReleased,
  updateDepsClaimLine,
  type DepsLineRow,
} from './deps-claim-ledger.js';

const { autoMergeRequests, dependencyAutomationActions: daa, pullRequests, repos } = schema;

/** The wait before retry n (1-based): 1, 2, 4, 8 minutes. */
export function depsReleaseBackoffMs(attempts: number): number {
  return attempts <= 0 ? 0 : 60_000 * 2 ** Math.min(attempts - 1, 6);
}

export interface DepsReleaseDeps {
  gh?: TeamClaimGithub;
  nowMs?: number;
}

export interface DepsReleaseResult {
  released: number;
  finished: number;
  renewed: number;
  teammates: number;
  failed: number;
  limited: boolean;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

let releasing = false;
// Teammate rows read and found settled or live: not read again before this (in process).
const teammateChecked = new Map<string, number>();

/** Test hook. */
export function _resetDepsClaimReleaseForTest(): void {
  releasing = false;
  teammateChecked.clear();
}

type Outcome =
  | { kind: 'done'; patch: Parameters<typeof updateDepsClaimLine>[1]; count: 'released' | 'finished' | 'renewed' | null }
  | { kind: 'skip' }
  | { kind: 'limited' }
  | { kind: 'failed'; error: string };

async function intentOf(accountId: number, prId: number): Promise<{ state: string; expectedHeadOid: string } | null> {
  const rows = await db
    .select({ state: autoMergeRequests.state, expectedHeadOid: autoMergeRequests.expectedHeadOid })
    .from(autoMergeRequests)
    .where(and(eq(autoMergeRequests.accountId, accountId), eq(autoMergeRequests.prId, prId)))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

const isArmedDoneLine = (d: string | null): boolean => (d ?? '').includes(' armed the merge');

/** ONE own row, decided from GitHub's own history. */
async function settleOwnRow(gh: TeamClaimGithub, row: DepsLineRow, me: string, owner: string, name: string, nowMs: number): Promise<Outcome> {
  const failure = (err: unknown): Outcome => {
    const kind = claimErrorKind(err, row.accountId);
    if (kind === 'rate_limited') return { kind: 'limited' };
    if (kind === 'no_access') return { kind: 'done', patch: { state: 'released', lastError: 'no_access' }, count: null };
    return { kind: 'failed', error: errText(err) };
  };
  const list = (): Promise<TeamClaimLine[]> => gh.listLines(row.accountId, owner, name, row.headSha, DEPENDENCY_CLAIM_CONTEXT);
  const postLine = (description: string): Promise<void> =>
    gh.postLine(row.accountId, owner, name, row.headSha, DEPENDENCY_CLAIM_CONTEXT, { state: 'success', description });
  const posted = (description: string, state: 'armed' | 'finished' | 'released', count: 'released' | 'finished' | 'renewed'): Outcome => ({
    kind: 'done',
    patch: { state, lastDescription: description, lastPostedAt: new Date(nowMs), finalDescription: null, lastError: null, releaseAttempts: 0 },
    count,
  });

  try {
    // ── the line on a commit an AI run pushed (gap h) ──
    if (row.action === 'ai_pushed') {
      const lines = await list();
      if (lines.some((l) => isAiPushedLine(l) && sameGithubLogin(l.login, me))) {
        return { kind: 'done', patch: { state: 'finished', lastError: 'already on GitHub', finalDescription: null }, count: null };
      }
      const d = row.finalDescription ?? aiPushedLine(me);
      await postLine(d);
      return posted(d, 'finished', 'finished');
    }

    // ── an armed merge (gap c) ──
    if (row.state === 'armed') {
      const intent = await intentOf(row.accountId, row.prId);
      if (intent && intent.expectedHeadOid === row.headSha && intent.state === 'armed') {
        const last = row.lastPostedAt instanceof Date ? row.lastPostedAt.getTime() : row.lastPostedAt == null ? null : Number(row.lastPostedAt);
        if (last != null && nowMs - last < DEPS_ARMED_RENEW_MS) return { kind: 'skip' };
        const d = row.finalDescription != null && isArmedDoneLine(row.finalDescription) ? row.finalDescription : doneLine(me, 'arm_merge');
        await postLine(d);
        return posted(d, 'armed', 'renewed');
      }
      if (intent && intent.expectedHeadOid === row.headSha && intent.state === 'merged') {
        return { kind: 'done', patch: { state: 'finished', lastError: 'merged', finalDescription: null }, count: null };
      }
      // Ended unlanded: free the merge for a teammate — unless our newest line already says so.
      const ours = newestLine((await list()).filter((l) => sameGithubLogin(l.login, me)));
      if (ours == null) return { kind: 'done', patch: { state: 'released', lastError: 'no line' }, count: null };
      if ((ours.description ?? '').includes(ARMED_RELEASE_WHY)) {
        return { kind: 'done', patch: { state: 'released', lastError: 'settled' }, count: null };
      }
      const d = armedReleaseLine(me);
      await postLine(d);
      return posted(d, 'released', 'released');
    }

    // ── a claim no action of ours holds any more (gap a) ──
    const last = newestLine(await list());
    if (last == null) return { kind: 'done', patch: { state: 'released', lastError: 'no line' }, count: null };
    if (!sameGithubLogin(last.login, me)) return { kind: 'done', patch: { state: 'released', lastError: 'superseded' }, count: null };
    if (last.state !== 'pending') {
      return { kind: 'done', patch: { state: row.finalDescription != null ? 'finished' : 'released', lastError: 'settled' }, count: null };
    }
    const d = row.finalDescription ?? releaseLine(me, "didn't finish");
    await postLine(d);
    if (row.action === 'arm_merge' && isArmedDoneLine(d)) return posted(d, 'armed', 'finished');
    return posted(d, row.finalDescription != null ? 'finished' : 'released', row.finalDescription != null ? 'finished' : 'released');
  } catch (err) {
    return failure(err);
  }
}

/** OUR open rows (see the header). Never throws. */
export async function releaseStaleOwnDepsClaims(log: FastifyBaseLogger, deps: DepsReleaseDeps = {}): Promise<DepsReleaseResult> {
  const out: DepsReleaseResult = { released: 0, finished: 0, renewed: 0, teammates: 0, failed: 0, limited: false };
  const gh = deps.gh ?? depsClaimGithub();
  const nowMs = deps.nowMs ?? Date.now();
  let rows: DepsLineRow[];
  try {
    rows = await openDepsClaimLines();
  } catch (err) {
    log.warn({ err }, 'dependency claim release: ledger unreadable');
    return out;
  }
  for (const row of rows) {
    if (row.releaseAttempts >= DEPS_RELEASE_MAX_ATTEMPTS) continue;
    if (depsClaimLive(row.id, row.accountId, row.prId, row.headSha)) continue;
    const at = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt);
    if (row.releaseAttempts > 0 && nowMs < at + depsReleaseBackoffMs(row.releaseAttempts)) continue;
    if (row.login == null || row.owner == null || row.name == null) {
      await updateDepsClaimLine(row.id, { state: 'released', lastError: 'no login or repository' }).catch(() => {});
      continue;
    }
    const res = await settleOwnRow(gh, row, row.login, row.owner, row.name, nowMs);
    if (res.kind === 'skip') continue;
    if (res.kind === 'limited') {
      out.limited = true;
      break; // the budget waits; so does every other row
    }
    if (res.kind === 'failed') {
      const attempts = row.releaseAttempts + 1;
      out.failed += 1;
      await updateDepsClaimLine(row.id, { releaseAttempts: attempts, lastError: res.error }).catch(() => {});
      if (attempts >= DEPS_RELEASE_MAX_ATTEMPTS) {
        log.warn(
          { prId: row.prId, action: row.action },
          `dependency claim: gave up on the limn/deps line at ${row.headSha.slice(0, 7)} after ${attempts} tries (${res.error})`,
        );
      }
      continue;
    }
    await updateDepsClaimLine(row.id, res.patch).catch((err) => log.warn({ err, rowId: row.id }, 'dependency claim release: ledger not updated'));
    if (res.count) out[res.count] += 1;
  }
  return out;
}

/** TEAMMATES' expired pending lines this Limn skipped for (gap b; see the header). Never throws. */
export async function releaseExpiredTeammateDepsLines(
  log: FastifyBaseLogger,
  deps: DepsReleaseDeps = {},
): Promise<{ released: number; limited: boolean }> {
  const out = { released: 0, limited: false };
  const gh = deps.gh ?? depsClaimGithub();
  const nowMs = deps.nowMs ?? Date.now();
  let rows: Array<{ accountId: number; prId: number; headSha: string; action: string; login: string | null; owner: string; name: string }>;
  try {
    rows = await db
      .select({
        accountId: daa.accountId,
        prId: daa.prId,
        headSha: daa.headSha,
        action: daa.action,
        login: daa.teammateLogin,
        owner: repos.owner,
        name: repos.name,
      })
      .from(daa)
      .innerJoin(pullRequests, and(eq(pullRequests.id, daa.prId), eq(pullRequests.accountId, daa.accountId)))
      .innerJoin(repos, and(eq(repos.id, pullRequests.repoId), eq(repos.accountId, daa.accountId)))
      .where(
        and(
          eq(daa.state, 'skipped'),
          isNotNull(daa.teammateLogin),
          // A teammate HANDLING the head (a pending line), not one who finished an action there.
          sql`coalesce(${daa.teammateHandled}, 0) = 0`,
          eq(pullRequests.state, 'open'),
          // The PR's current head only: an older commit's line no longer holds anything.
          eq(pullRequests.headSha, daa.headSha),
          inArray(daa.action, ['approve', 'rebase_request', 'ai_resolve', 'ai_fix', 'arm_merge']),
        ),
      )
      .orderBy(daa.updatedAt)
      .limit(50)
      .execute();
  } catch (err) {
    log.warn({ err }, 'dependency claim release: skips unreadable');
    return out;
  }
  const logins = new Map<number, string | null>();
  const seenHeads = new Set<string>();
  for (const r of rows) {
    const head = `${r.accountId}:${r.prId}:${r.headSha}`;
    if (seenHeads.has(head)) continue; // one read per head, whichever action skipped there
    seenHeads.add(head);
    if (r.login == null) continue;
    if (depsHeldNow(r.accountId, r.prId, r.headSha, null, nowMs)) continue; // their lease is still live
    if ((teammateChecked.get(head) ?? 0) > nowMs) continue;
    if (depsClaimLive(null, r.accountId, r.prId, r.headSha)) continue;
    try {
      if (await teammateDepsLineReleased(r.accountId, r.prId, r.headSha, r.login)) continue;
      if (!logins.has(r.accountId)) logins.set(r.accountId, await gh.login(r.accountId).catch(() => null));
      const me = logins.get(r.accountId) ?? null;
      if (me == null) continue;
      const lines = await gh.listLines(r.accountId, r.owner, r.name, r.headSha, DEPENDENCY_CLAIM_CONTEXT);
      const stale = staleTeammateDepsLine(lines, me, nowMs);
      if (!stale) {
        const action = r.action as ClaimAction;
        const d = decideDepsClaim(lines, me, nowMs, familyOfAction(action), { action });
        if (d.kind === 'handling') rememberDepsHold({ accountId: r.accountId, prId: r.prId, headSha: r.headSha, action }, d, nowMs);
        else teammateChecked.set(head, nowMs + DEPS_HANDLED_RECHECK_MS);
        continue;
      }
      const description = releasedLine(stale.login, me);
      let lastError: string | null = null;
      try {
        await gh.postLine(r.accountId, r.owner, r.name, r.headSha, DEPENDENCY_CLAIM_CONTEXT, { state: 'success', description });
        out.released += 1;
      } catch (err) {
        const kind = claimErrorKind(err, r.accountId);
        if (kind === 'rate_limited') {
          out.limited = true;
          break;
        }
        lastError = kind === 'no_access' ? 'no_access' : errText(err);
      }
      // Posted ONCE: recorded either way, so it is never re-posted every tick.
      await recordTeammateDepsRelease({
        accountId: r.accountId,
        prId: r.prId,
        owner: r.owner,
        name: r.name,
        headSha: r.headSha,
        login: stale.login,
        description,
        lastError,
      });
    } catch (err) {
      if (claimErrorKind(err, r.accountId) === 'rate_limited') {
        out.limited = true;
        break;
      }
      log.warn({ err, prId: r.prId }, 'dependency claim: teammate line not checked');
    }
  }
  return out;
}

/** THE ONE ENTRY (boot + after every auto-merge tick): our rows first, then teammates'. Never throws. */
export async function releaseStaleDepsClaims(log: FastifyBaseLogger, deps: DepsReleaseDeps = {}): Promise<DepsReleaseResult | null> {
  if (releasing) return null; // a slow pass is still going: the next tick picks up the rest
  releasing = true;
  try {
    const own = await releaseStaleOwnDepsClaims(log, deps);
    if (own.limited) return own;
    const mates = await releaseExpiredTeammateDepsLines(log, deps);
    own.teammates = mates.released;
    own.limited = mates.limited;
    return own;
  } catch (err) {
    log.warn({ err }, 'dependency claim release failed');
    return null;
  } finally {
    releasing = false;
  }
}
