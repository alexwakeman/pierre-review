// RENEWING, SETTLING AND RELEASING A STORY BUILD'S LINES (docs/STORY-BUILD.md § The team claim). The story
// builds' twin of merge/deps-claim-release.ts, run once at boot (non-blocking), every
// BUILD_CLAIM_TICK_MS after it, and right after a session closes (`kickStoryBuildClaims`). Never inside a
// transaction; every GitHub call is outside any DB write. Never throws.
//
//   BUILD ROWS (`kind 'build'`, ours, open):
//     • the build's session is LIVE in this process and not finished ⇒ the pending line is RENEWED every
//       BUILD_CLAIM_RENEW_MS (its lease, BUILD_CLAIM_LEASE_MS, runs from the newest one);
//     • otherwise (pushed, the review loop done, discarded, failed, closed, Ensemble restarted) the line is
//       SETTLED — only while the head's NEWEST `ensemble/build` line is still OUR pending one: the line the
//       end could not write (`final_description`), else "alex built PAY-142 · pull request opened" (pushed /
//       the loop done) or "Cleared by alex: build paused / ended / discarded · free to claim". Then our placeholder goes, if the
//       branch still points at it. A newer line by someone else, ours already settled, or none ⇒ closed,
//       nothing posted.
//   REVIEW ROWS (`kind 'review'`, the review loop's `ensemble/review-<provider>` lines): while the build's
//     loop works in this process the round's own end writes the line; otherwise an open row gets its line
//     (`final_description`, else "Cleared by alex: review didn't finish · free to claim") when ours is still
//     the newest pending line.
//   A LIVE SESSION WITH NO CLAIM (a Resume, or a start whose claim went unmarked for a reason that passed):
//     the claim is taken ONCE per live session (`takeTicketClaim`); a teammate's live claim found then is
//     one line in the session, never a stop — the reader's own work is never blocked.
//   Failures back off (1, 2, 4, 8 minutes), at most BUILD_CLAIM_RELEASE_MAX_ATTEMPTS times. 403/404 ⇒ closed
//   (no access). A rate limit stops the pass. Only status lines (and our own placeholder) are written here.
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { claimErrorKind, newestLine, releaseContextOf, sameGithubLogin, unfinishedLine } from '../../review/claude-review/team-claim.js';
import { BUILD_CLAIM_CONTEXT, BUILD_CLAIM_RENEW_MS, buildReleaseLine, buildingLine, builtLine, isFreeBuildLine } from './build-claim.js';
import { buildClaimSeams, takeTicketClaim, teamClaimedMessage, type BuildClaimLog } from './build-claim-flow.js';
import {
  BUILD_CLAIM_RELEASE_MAX_ATTEMPTS,
  openBuildClaimLines,
  openBuildRowsOf,
  updateBuildClaimLine,
  type BuildClaimLineRow,
  type BuildClaimLinePatch,
} from './build-claim-ledger.js';

export const BUILD_CLAIM_TICK_MS = 60_000;

/** The wait before retry n (1-based): 1, 2, 4, 8 minutes. */
export function buildClaimBackoffMs(attempts: number): number {
  return attempts <= 0 ? 0 : 60_000 * 2 ** Math.min(attempts - 1, 6);
}

export interface BuildClaimReleaseResult {
  renewed: number;
  settled: number;
  closed: number;
  taken: number;
  failed: number;
  limited: boolean;
}

/** What the reconciler needs from the session and the loop (lazy defaults; replaced in tests). */
export interface BuildClaimReleaseDeps {
  /** The review loop of this build works in this process. */
  loopBusy?: (buildId: number) => boolean;
  /** Live story sessions in this process (a Resume takes its claim again). */
  liveBuilds?: () => Array<{ buildId: number; accountId: number; workspaceId: number }>;
  /** The workspace's repositories (owner/name), for a Resume's claim. */
  workspaceRepos?: (accountId: number, workspaceId: number) => Promise<Array<{ owner: string; name: string }>>;
  /** One line in a live session (a teammate's claim found at a Resume). */
  notice?: (buildId: number, text: string) => void;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);

interface BuildFacts {
  sessionPhase: string | null;
  status: string;
  loopState: string | null;
  ticketKey: string;
  ident: string;
  workspaceId: number;
}

async function buildFacts(accountId: number, buildId: number): Promise<BuildFacts | null> {
  const b = schema.storyBuilds;
  const rows = (await db
    .select({ sessionPhase: b.sessionPhase, status: b.status, loopState: b.loopState, ticketKey: b.ticketKey, ident: b.ident, workspaceId: b.workspaceId })
    .from(b)
    .where(and(eq(b.id, buildId), eq(b.accountId, accountId)))
    .limit(1)
    .execute()) as BuildFacts[];
  return rows[0] ?? null;
}

/** The build has its pull request(s): every repository pushed, or the review loop opened them. */
const finishedWithPr = (f: BuildFacts | null): boolean => f != null && (f.sessionPhase === 'pushed' || f.loopState === 'done');
/** Nothing more happens in this build (or it is gone). */
const ended = (f: BuildFacts | null): boolean =>
  f == null || finishedWithPr(f) || f.sessionPhase === 'discarded' || f.sessionPhase === 'failed' || f.status === 'discarded' || f.status === 'failed';

type Outcome = { kind: 'done'; patch: BuildClaimLinePatch; count: 'renewed' | 'settled' | 'closed' } | { kind: 'skip' } | { kind: 'limited' } | { kind: 'failed'; error: string };

async function settleRow(row: BuildClaimLineRow, deps: BuildClaimReleaseDeps): Promise<Outcome> {
  const s = buildClaimSeams();
  const now = s.nowMs();
  const login = row.login!;
  const at = (d: Date | number | null): number | null => (d == null ? null : d instanceof Date ? d.getTime() : Number(d));
  try {
    if (row.kind === 'review') {
      if (row.buildId != null && (deps.loopBusy?.(row.buildId) ?? false)) return { kind: 'skip' };
      const newest = newestLine(await s.gh.listLines(row.accountId, row.owner, row.name, row.headSha, row.context));
      if (newest == null || !sameGithubLogin(newest.login, login) || newest.state !== 'pending') {
        return { kind: 'done', patch: { state: row.finalDescription != null ? 'finished' : 'released', lastError: 'settled' }, count: 'closed' };
      }
      const d = row.finalDescription ?? unfinishedLine(login);
      await s.gh.postLine(row.accountId, row.owner, row.name, row.headSha, releaseContextOf(newest, row.context), { state: 'success', description: d });
      return { kind: 'done', patch: { state: row.finalDescription != null ? 'finished' : 'released', lastDescription: d, lastPostedAt: new Date(now), finalDescription: null, lastError: null }, count: 'settled' };
    }
    // ── a build claim ──
    if (row.headSha === '') return { kind: 'done', patch: { state: 'released', lastError: 'no placeholder' }, count: 'closed' };
    const facts = row.buildId != null ? await buildFacts(row.accountId, row.buildId) : null;
    const live = row.buildId != null && s.liveBuild(row.buildId) && !ended(facts);
    if (live) {
      const last = at(row.lastPostedAt);
      if (row.state === 'pending' && last != null && now - last < BUILD_CLAIM_RENEW_MS) return { kind: 'skip' };
      const d = buildingLine(login, row.branch ?? facts?.ticketKey ?? '');
      await s.gh.postLine(row.accountId, row.owner, row.name, row.headSha, BUILD_CLAIM_CONTEXT, { state: 'pending', description: d });
      return { kind: 'done', patch: { state: 'pending', lastDescription: d, lastPostedAt: new Date(now), lastError: null, releaseAttempts: 0 }, count: 'renewed' };
    }
    const lines = await s.gh.listLines(row.accountId, row.owner, row.name, row.headSha, BUILD_CLAIM_CONTEXT);
    const newest = newestLine(lines);
    const ours = newest != null && sameGithubLogin(newest.login, login) && !isFreeBuildLine(newest);
    const key = row.branch ?? facts?.ticketKey ?? '';
    const pr = finishedWithPr(facts);
    const why =
      facts?.sessionPhase === 'discarded' || facts?.status === 'discarded'
        ? 'build discarded'
        : facts == null || facts.sessionPhase === 'failed' || facts.status === 'failed'
          ? 'build ended'
          : 'build paused'; // closed, kept: a Resume claims it again
    const d = row.finalDescription ?? (pr ? builtLine(login, key) : buildReleaseLine(login, why));
    if (ours) await s.gh.postLine(row.accountId, row.owner, row.name, row.headSha, releaseContextOf(newest, BUILD_CLAIM_CONTEXT), { state: 'success', description: d });
    // Our placeholder goes when the branch still points at it (never a commit someone pushed).
    if (row.branch) await s.gh.deletePlaceholder(row.accountId, row.owner, row.name, row.branch, row.headSha).catch(() => false);
    const state = pr || row.finalDescription != null ? 'finished' : 'released';
    return ours
      ? { kind: 'done', patch: { state, lastDescription: d, lastPostedAt: new Date(now), finalDescription: null, lastError: null }, count: 'settled' }
      : { kind: 'done', patch: { state, lastError: 'settled' }, count: 'closed' };
  } catch (err) {
    const kind = claimErrorKind(err, row.accountId);
    if (kind === 'rate_limited') return { kind: 'limited' };
    if (kind === 'no_access') return { kind: 'done', patch: { state: 'released', lastError: 'no_access' }, count: 'closed' };
    return { kind: 'failed', error: errText(err) };
  }
}

// The live sessions this process already tried to claim (a Resume claims once; forgotten when it closes).
const attempted = new Set<number>();
let running = false;

/** Test hook. */
export function _resetBuildClaimReleaseForTest(): void {
  attempted.clear();
  running = false;
}

/** THE ONE PASS (see the header). Never throws. */
export async function settleStoryBuildClaims(log: BuildClaimLog, deps: BuildClaimReleaseDeps = {}): Promise<BuildClaimReleaseResult | null> {
  if (running) return null;
  running = true;
  const out: BuildClaimReleaseResult = { renewed: 0, settled: 0, closed: 0, taken: 0, failed: 0, limited: false };
  try {
    const d = { ...(await defaultDeps()), ...deps };
    const s = buildClaimSeams();
    let rows: BuildClaimLineRow[] = [];
    try {
      rows = await openBuildClaimLines();
    } catch (err) {
      log.warn(`story build claims: ledger unreadable (${errText(err)})`);
    }
    for (const row of rows) {
      if (row.login == null) {
        await updateBuildClaimLine(row.id, { state: 'released', lastError: 'no login' }).catch(() => {});
        continue;
      }
      const at = row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt);
      if (row.releaseAttempts > 0 && s.nowMs() < at + buildClaimBackoffMs(row.releaseAttempts)) continue;
      const res = await settleRow(row, d);
      if (res.kind === 'skip') continue;
      if (res.kind === 'limited') {
        out.limited = true;
        break;
      }
      if (res.kind === 'failed') {
        const attempts = row.releaseAttempts + 1;
        out.failed += 1;
        await updateBuildClaimLine(row.id, { releaseAttempts: attempts, lastError: res.error }).catch(() => {});
        if (attempts >= BUILD_CLAIM_RELEASE_MAX_ATTEMPTS) log.warn(`story build claims: gave up on the ${row.context} line at ${row.headSha.slice(0, 7)} after ${attempts} tries (${res.error})`);
        continue;
      }
      await updateBuildClaimLine(row.id, res.patch).catch(() => {});
      out[res.count] += 1;
    }
    if (out.limited) return out;
    // A live session with no claim (a Resume): take it once.
    const liveNow = d.liveBuilds?.() ?? [];
    const liveIds = new Set(liveNow.map((l) => l.buildId));
    for (const id of [...attempted]) if (!liveIds.has(id)) attempted.delete(id);
    for (const l of liveNow) {
      if (attempted.has(l.buildId)) continue;
      attempted.add(l.buildId);
      if ((await openBuildRowsOf(l.accountId, l.buildId).catch(() => [])).length > 0) continue;
      const f = await buildFacts(l.accountId, l.buildId).catch(() => null);
      if (f == null || ended(f)) continue;
      const repos = (await d.workspaceRepos?.(l.accountId, l.workspaceId).catch(() => [])) ?? [];
      if (repos.length === 0) continue;
      const r = await takeTicketClaim({ accountId: l.accountId, workspaceId: l.workspaceId, ident: f.ident, ticketKey: f.ticketKey, repos, buildId: l.buildId }, log);
      if (r.kind === 'held') out.taken += 1;
      if (r.kind === 'lost') d.notice?.(l.buildId, `${teamClaimedMessage(r.claim)} Your session goes on; pushing may find the branch taken.`);
    }
    return out;
  } catch (err) {
    log.warn(`story build claims: the pass failed (${errText(err)})`);
    return out;
  } finally {
    running = false;
  }
}

/** Mark a live session as already claimed in this process (the start route took its claim). */
export function noteBuildClaimAttempted(buildId: number): void {
  attempted.add(buildId);
}

async function defaultDeps(): Promise<BuildClaimReleaseDeps> {
  const [m, loop] = await Promise.all([import('../../sandbox/session/manager.js'), import('./loop/driver.js')]);
  return {
    loopBusy: (id) => loop.isStoryLoopBusy(id),
    liveBuilds: () => m.liveStoryBuilds(),
    workspaceRepos: async (accountId, workspaceId) => {
      const { resolveWorkspaceScope } = await import('../../db/queries.js');
      const scope = await resolveWorkspaceScope(accountId, workspaceId, null, { members: 'all' });
      return workspaceRepoNames(accountId, scope.repoIds);
    },
    notice: (id, text) => m.noticeStory(id, text),
  };
}

/** owner/name of the given repositories of the account (DB only). */
export async function workspaceRepoNames(accountId: number, repoIds: readonly number[]): Promise<Array<{ owner: string; name: string }>> {
  if (repoIds.length === 0) return [];
  const { inArray } = await import('drizzle-orm');
  const r = schema.repos;
  return (await db
    .select({ owner: r.owner, name: r.name })
    .from(r)
    .where(and(eq(r.accountId, accountId), inArray(r.id, [...repoIds])))
    .execute()) as Array<{ owner: string; name: string }>;
}

// ---- the timer ----

let timer: ReturnType<typeof setInterval> | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let boundLog: BuildClaimLog | null = null;

/** Boot: one pass now (background), then every BUILD_CLAIM_TICK_MS. Idempotent. */
export function bindStoryBuildClaims(log: BuildClaimLog): void {
  boundLog = log;
  if (timer != null) return;
  void settleStoryBuildClaims(log);
  timer = setInterval(() => void settleStoryBuildClaims(log), BUILD_CLAIM_TICK_MS);
  timer.unref?.();
}

/** A session closed or a build ended: settle its lines soon (debounced). No-op before the boot bind. */
export function kickStoryBuildClaims(): void {
  if (boundLog == null || kickTimer != null) return;
  const log = boundLog;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void settleStoryBuildClaims(log);
  }, 2_000);
  kickTimer.unref?.();
}
