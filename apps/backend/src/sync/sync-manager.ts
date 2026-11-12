import { eq, gte } from 'drizzle-orm';
import type { SyncProgress, SyncRunStatus, SyncStatus } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { syncRepo, type Logger } from './sync-repo.js';
import {
  backoffMsFor,
  decideIncrementalWalk,
  isDue,
  noteAttempt,
  noteWalkFailure,
  noteWalkStart,
  noteWalkSuccess,
  recordFullWalk,
  isPinnedCold,
  setPinnedColdRepos,
} from './adaptive.js';
import { isSeverityApiConfigured } from '../ml/severity-client.js';
import { runMlEnrichmentTick } from './ml-enrichment.js';
import { notifyRepoWalked } from './walk-listeners.js';
import { notifyRepoSynced } from './repo-synced-hooks.js';
import { deleteMlLabelsForRepo } from '../db/ml-labels.js';
import { allExternalRepoIds } from '../db/external-repos.js';

const { repos, syncState, accounts } = schema;

// In-memory record of which repos are mid-sync (status isn't persisted as
// "running" — it lives only for the lifetime of the process).
const running = new Set<number>();

// Repos the SCHEDULER is probing right now (the free conditional REST probe, before it has
// decided to walk). Deliberately NOT `running`: at a 10-second tick a repo is probed every 20s,
// and a probe that read as `running` would (a) flash "syncing" on every status poll and (b)
// refuse a person's "Sync now" with a 409 for the probe's few hundred milliseconds. A probe that
// decides to walk moves the repo into `running` synchronously (re-checking it first), so a
// manual sync that started during the probe wins and the probe stands down.
// `isSyncRunning` still counts it: the delete route must not remove a repo a probe is about to
// walk (the walk's upsertRepo would resurrect it).
const probing = new Set<number>();

// True while a scheduled tick (syncAllRepos) is in progress. A tick never starts while the
// previous one is still running — at a 10-second cron that would pile loops up behind one slow
// walk. Claimed synchronously, released in a `finally`.
let tickInFlight = false;

// Repos currently undergoing a user-initiated FULL ("deep") sync. The deep button
// fires a forced full sync on every repo at once; they finish at different times.
// While ANY deep sync is still in flight we skip the scheduled incremental run
// entirely — otherwise the cron starts a fresh incremental on each repo the moment
// its deep sync finishes, resetting that repo's progress bar to 0% mid-session.
const deepSyncing = new Set<number>();

// True while a deep (forced-full) sync is in progress on any repo.
export function isDeepSyncActive(): boolean {
  return deepSyncing.size > 0;
}

// ---- Manual-sync throttling ----
//
// `running.has(repoId)` only refuses a sync for the SAME repo that is already going. It did
// not stop: (a) restarting a repo the instant its sync finished, or (b) starting a forced
// 90-day backfill on all 100 permitted repos at once. Either turns one authenticated caller
// into a permanent, N-way GraphQL+REST walk that drains the tenant's GitHub quota (so their
// real sync silently stalls) and, in cloud, starves every other tenant of event-loop time in
// the single shared Fastify process.
//
// Two bounds, both deliberately outside `runSyncForRepo` so its signature (and its tests)
// stay as they are: a per-repo cooldown the route checks first, and the per-account SERIAL
// queue below (`enqueueSyncForRepo` — which replaced the old process-wide
// MAX_CONCURRENT_SYNCS cap + its 429). The SCHEDULER is exempt from both — it is a
// sequential loop that already skips `running` repos and is not caller-controlled.
const manualSyncAt = new Map<number, number>();

// A forced full backfill is the expensive one (90 days, every page, per-commit REST fetches),
// so it gets the long cooldown. A plain manual sync is an incremental walk — cheap, and users
// legitimately hit Refresh — so it only needs enough to stop a hammering loop.
// Read straight from env with a local parser rather than importing config's `intFromEnv`:
// sync-manager's tests vi.mock('../config.js') wholesale, so importing a second symbol from it
// would make every one of them fail on a missing mock export.
const envSec = (key: string, fallback: number): number => {
  const n = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const FULL_SYNC_COOLDOWN_MS = envSec('FULL_SYNC_COOLDOWN_SEC', 5 * 60) * 1000;
const MANUAL_SYNC_COOLDOWN_MS = envSec('MANUAL_SYNC_COOLDOWN_SEC', 30) * 1000;

/**
 * Milliseconds a caller must wait before manually syncing this repo again, or 0 when it may
 * go now. Checked by the route so it can answer 429 + Retry-After; `runSyncForRepo` itself is
 * unchanged so the scheduler and the tests are unaffected.
 */
export function manualSyncCooldownMs(repoId: number, forceFull: boolean): number {
  const last = manualSyncAt.get(repoId);
  if (last === undefined) return 0;
  const window = forceFull ? FULL_SYNC_COOLDOWN_MS : MANUAL_SYNC_COOLDOWN_MS;
  const remaining = window - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

/** Record a manual sync so the cooldown above starts running. Called by the route. */
export function noteManualSync(repoId: number): void {
  manualSyncAt.set(repoId, Date.now());
  // Bounded: a tenant may watch at most MAX_REPOS_PER_ACCOUNT repos, but in cloud this map is
  // process-wide across all tenants, so drop entries that are past every cooldown window.
  if (manualSyncAt.size > 5_000) {
    const cutoff = Date.now() - Math.max(FULL_SYNC_COOLDOWN_MS, MANUAL_SYNC_COOLDOWN_MS);
    for (const [id, at] of manualSyncAt) if (at < cutoff) manualSyncAt.delete(id);
  }
}

// Repos the user has asked to STOP mid-sync. syncRepo polls this between pages
// (and PRs) and bails out without recording the run as complete, so a cancelled
// initial backfill leaves the repo "never synced" (the cancel endpoint then
// deletes it + its partial data). Only meaningful while the repo is running.
const cancelRequested = new Set<number>();

export function requestSyncCancel(
  repoId: number,
  opts: { dropFollowOns?: boolean } = {},
): void {
  // A repo whose walk is COMPLETE and stamped and that waits only for its parked follow-on work
  // (the CI-history backfill etc.) keeps that job: a cancel is about the walk, and dropping it
  // would lose work the stamped repo can no longer ask for. Only removing the repo drops it
  // (`dropFollowOns`). (The CI-history half is also stamped as owed, so a lost job is recovered.)
  if (!opts.dropFollowOns && queuedRepos.has(repoId) && onlyFollowOnsQueued(repoId)) return;
  // A repo still WAITING in the per-account queue never started anything: drop it and
  // clear its 'queued' progress row synchronously, so waitForSyncToStop (which watches
  // `running`) returns immediately and cancel-and-delete of a never-synced repo works
  // without ever touching GitHub.
  if (queuedRepos.delete(repoId)) {
    clearSyncProgress(repoId);
    dropQueuedJobs(repoId);
    return;
  }
  if (running.has(repoId)) cancelRequested.add(repoId);
}

// Block until a repo's in-flight sync has actually stopped (the loop notices the
// cancel flag after its current page/PR), or the timeout elapses. Returns true if
// it stopped. Used by the cancel endpoint before deleting an initial-load repo.
export async function waitForSyncToStop(
  repoId: number,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (running.has(repoId)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

// ---- Per-account serialization of API-triggered syncs ----
//
// POST /api/repos (add → initial backfill) and POST /api/repos/:id/sync used to fire
// runSyncForRepo directly, so adding several repos consecutively (or "deep sync
// everything") ran N concurrent two-phase 90-day walks — each with a 10-way commit-file
// REST fan-out — against ONE token, which is precisely how a caller drives their own
// account into GitHub's rate limiter. API-triggered walks now run ONE AT A TIME per
// account: one queue per accountId, drained by one loop (`drainAccountQueue`, below — read
// its job comment for the BREADTH-FIRST first sync); later repos wait with an honest
// `paused: { reason: 'queued' }` progress row (status reads 'running'). The SCHEDULER
// stays exempt — it is already a sequential loop and is not caller-controlled.
const accountQueues = new Map<number, AccountQueue>();
// Repos waiting in an account's queue (queued, not yet started — or between the jobs of a first
// sync: done with the foreground pass and waiting for the backfill, or waiting for parked
// follow-on work). The source of truth for "still wants to run": requestSyncCancel drops a repo
// from here (and its job from the queue) synchronously, and the queue skips it.
const queuedRepos = new Set<number>();

/** True while a repo is waiting in the per-account API-sync queue (not yet running). */
export function isSyncQueued(repoId: number): boolean {
  return queuedRepos.has(repoId);
}

// Live progress for in-flight syncs, surfaced via getSyncStatus so the UI can
// show a determinate bar. Lives only for the duration of the run.
const progressByRepo = new Map<number, SyncProgress>();

/**
 * Snapshot of every live progress row — running walks AND repos still waiting in the
 * per-account queue (their seeded row rides `paused: { reason: 'queued' }`). Read-only,
 * for `GET /api/sync-activity`; the maps themselves stay private to this module. The
 * caller filters (e.g. to full-mode walks) and MUST re-scope by account — this map is
 * process-wide across tenants in cloud. Progress objects are replaced wholesale by
 * setSyncProgress (never mutated in place), so returning the references is safe.
 */
export function listActiveSyncProgress(): Array<{ repoId: number; progress: SyncProgress }> {
  return [...progressByRepo].map(([repoId, progress]) => ({ repoId, progress }));
}

function setSyncProgress(repoId: number, p: SyncProgress): void {
  progressByRepo.set(repoId, p);
}

function clearSyncProgress(repoId: number): void {
  progressByRepo.delete(repoId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isSyncRunning(repoId: number): boolean {
  return running.has(repoId) || probing.has(repoId);
}

export async function getSyncStatus(repoId: number): Promise<SyncStatus | null> {
  const state = (
    await db
      .select()
      .from(syncState)
      .where(eq(syncState.repoId, repoId))
      .limit(1)
      .execute()
  )[0];

  // A repo WAITING in the per-account queue reads as 'running' with its queued progress
  // row — an honest "held, will go on its own", never idle/error.
  let status: SyncRunStatus = 'idle';
  if (running.has(repoId) || queuedRepos.has(repoId)) status = 'running';
  else if (state?.lastSyncStatus === 'error') status = 'error';
  else if (state?.lastSyncStatus === 'ok') status = 'ok';

  return {
    repoId,
    status,
    progress: status === 'running' ? progressByRepo.get(repoId) ?? null : null,
    lastFullSyncAt: state?.lastFullSyncAt?.toISOString() ?? null,
    lastIncrementalSyncAt: state?.lastIncrementalSyncAt?.toISOString() ?? null,
    lastSyncError: state?.lastSyncError ?? null,
  };
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  accountId: number;
}

async function getRepoRow(repoId: number): Promise<RepoRow | null> {
  return (
    (
      await db
        .select({
          id: repos.id,
          owner: repos.owner,
          name: repos.name,
          accountId: repos.accountId,
        })
        .from(repos)
        .where(eq(repos.id, repoId))
        .limit(1)
        .execute()
    )[0] ?? null
  );
}

// Decide window: incremental if we've ever synced, otherwise a full backfill.
async function planSync(
  repoId: number,
): Promise<{ mode: 'full' | 'incremental'; since: Date; light?: boolean }> {
  const state = (
    await db
      .select()
      .from(syncState)
      .where(eq(syncState.repoId, repoId))
      .limit(1)
      .execute()
  )[0];
  if (state?.lastIncrementalSyncAt) {
    const since = new Date(
      state.lastIncrementalSyncAt.getTime() - config.syncOverlapMinutes * 60 * 1000,
    );
    return { mode: 'incremental', since };
  }
  // EXTERNAL REPOS (db/external-repos.ts) sync LIGHT: a first walk covers the foreground window
  // only (no 90-day backfill, no second phase, no CI-history backfill). Their PRs are not watched;
  // only recent project PRs and ticket-linked PRs are read from them.
  if (isPinnedCold(repoId)) {
    return { mode: 'full', since: new Date(Date.now() - config.foregroundSyncDays * DAY_MS), light: true };
  }
  return { mode: 'full', since: new Date(Date.now() - config.backfillDays * DAY_MS) };
}

// `light`: an EXTERNAL repo's first walk (see `planSync`) — single pass, no CI-history backfill.
type Plan = { mode: 'full' | 'incremental'; since: Date; light?: boolean };

// Everything one walk needs once its slot is claimed and its lookups have landed.
interface WalkCtx {
  repoId: number;
  repo: RepoRow;
  plan: Plan;
  token: string;
  log: Logger;
  forceFull: boolean;
  common: {
    owner: string;
    name: string;
    accountId: number;
    knownRepoId: number;
    token: string;
    log: Logger;
    commitFileConcurrency: number;
    shouldCancel: () => boolean;
  };
}

/**
 * Claim a repo's `running` slot and resolve what a walk needs (repo row, plan, token). Returns
 * null — with every reservation it took released — when the repo is already running, is gone,
 * or a lookup throws. ⚠ The slot is reserved SYNCHRONOUSLY, before the first await, so a cron
 * tick (or a second request) firing during the lookups sees the repo as in flight and stands
 * down; every bail path after that point releases it, including a thrown lookup.
 */
async function prepareWalk(
  repoId: number,
  log: Logger,
  opts: { forceFull?: boolean; plan?: Plan; progress?: SyncProgress },
): Promise<WalkCtx | null> {
  if (running.has(repoId)) return null;
  const forceFull = opts.forceFull === true;
  running.add(repoId);
  // Track forced-full runs so the scheduler stands down for the whole deep-sync session (added
  // synchronously here, before any await, so a cron tick that fires right after this call
  // already sees the deep sync as active).
  if (forceFull) deepSyncing.add(repoId);

  let repo: RepoRow;
  let plan: Plan;
  try {
    const row = await getRepoRow(repoId);
    if (!row) {
      running.delete(repoId);
      if (forceFull) deepSyncing.delete(repoId);
      return null;
    }
    repo = row;
    plan =
      opts.plan ??
      (forceFull
        ? { mode: 'full' as const, since: new Date(Date.now() - config.backfillDays * DAY_MS) }
        : await planSync(repoId));
  } catch (err) {
    // Mirror of the token catch below: a rejected lookup must release BOTH reservations,
    // or a transient DB error leaks them forever — a leaked `running` entry makes the
    // repo un-syncable and un-deletable, and a leaked `deepSyncing` entry stands the
    // scheduler down on every tick (isDeepSyncActive).
    running.delete(repoId);
    if (forceFull) deepSyncing.delete(repoId);
    clearSyncProgress(repoId);
    log.error(
      `sync repo ${repoId}: repo/plan lookup failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  setSyncProgress(
    repoId,
    opts.progress ?? {
      percent: 0,
      prsProcessed: 0,
      pages: 0,
      mode: plan.mode,
      sinceMs: plan.since.getTime(),
    },
  );
  let token: string;
  try {
    token = await getAccessToken(repo.accountId);
  } catch (err) {
    running.delete(repoId);
    if (forceFull) deepSyncing.delete(repoId);
    clearSyncProgress(repoId);
    log.error(
      `sync ${repo.owner}/${repo.name}: no access token for account ${repo.accountId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  return {
    repoId,
    repo,
    plan,
    token,
    log,
    forceFull,
    common: {
      owner: repo.owner,
      name: repo.name,
      accountId: repo.accountId,
      // So a walk that dies BEFORE upsertRepo (404 / dead token / SAML wall) still records an
      // error on sync_state — otherwise a repo that never once synced reads 'idle' forever.
      knownRepoId: repoId,
      token,
      log,
      commitFileConcurrency: config.commitFileConcurrency,
      shouldCancel: () => cancelRequested.has(repoId),
    },
  };
}

/**
 * Release a walk's slot. `parked` ⇒ the repo was just handed to the queue (`parkInQueue`), which
 * already owns its progress row, so the row is kept.
 *
 * ⚠ ORDER IS LOAD-BEARING: the enrichment tick is kicked BEFORE this repo is released and its
 * progress cleared. The GitHub walk is only half of making the board correct — the severity
 * badges come from a CPU-bound model pass over the same text, which cannot run inside the walk
 * (see docs/ML-SEVERITY.md) and therefore always follows it. This used to run AFTER
 * clearSyncProgress, which put the model calls structurally downstream of "done": the client saw
 * every repo idle, declared the sync complete, and only then did scoring start — so no indicator
 * could ever represent it. runMlEnrichmentTick's guards and its `running = true` all sit before
 * its first await, so by the time this line returns `GET /api/ml-status` already reports the
 * scoring phase. The tick is re-entrancy-guarded and budget-bounded; if one is already running
 * this is a cheap no-op.
 */
function releaseWalk(repoId: number, log: Logger, parked = false): void {
  if (isSeverityApiConfigured()) void runMlEnrichmentTick(log);
  running.delete(repoId);
  deepSyncing.delete(repoId);
  cancelRequested.delete(repoId);
  if (!parked) clearSyncProgress(repoId);
}

// Two-phase only for a first full backfill (never-synced, not a forced "deep" re-sync) when the
// backfill window is wider than the foreground window. A deep re-sync stays single-pass — its
// board is already populated, so there's no blank-board wait to shorten.
function isTwoPhase(ctx: WalkCtx): boolean {
  return (
    !ctx.forceFull &&
    ctx.plan.mode === 'full' &&
    ctx.plan.light !== true &&
    !isPinnedCold(ctx.repoId) &&
    config.backfillDays > config.foregroundSyncDays
  );
}

async function runSinglePass(ctx: WalkCtx): Promise<{ cancelled: boolean }> {
  const { repoId, plan } = ctx;
  const r = await syncRepo({
    ...ctx.common,
    mode: plan.mode,
    since: plan.since,
    commitState: true,
    onProgress: (p) =>
      setSyncProgress(repoId, { ...p, mode: plan.mode, sinceMs: plan.since.getTime() }),
  });
  return { cancelled: r.cancelled };
}

/**
 * Phase 1 — the fast foreground window (the default timeline range). Committed per-PR so the
 * recent board is usable in seconds, but does NOT stamp syncState, so the repo stays an "initial
 * backfill" until phase 2 finishes.
 */
async function runForegroundPass(
  ctx: WalkCtx,
): Promise<{
  cancelled: boolean;
  endCursor: string | null;
  prCount: number;
  pages: number;
  foregroundSinceMs: number;
}> {
  const { repoId } = ctx;
  const foregroundSince = new Date(Date.now() - config.foregroundSyncDays * DAY_MS);
  const p1 = await syncRepo({
    ...ctx.common,
    mode: 'full',
    since: foregroundSince,
    commitState: false,
    onProgress: (p) =>
      setSyncProgress(repoId, {
        ...p,
        mode: 'full',
        foregroundComplete: false,
        // Phase 1 walks the FOREGROUND window, not plan.since — `sinceMs` names the cutoff
        // this percent is measured against, so it must be the same one syncRepo was given.
        sinceMs: foregroundSince.getTime(),
      }),
  });
  return {
    cancelled: p1.cancelled,
    endCursor: p1.endCursor,
    prCount: p1.prCount,
    pages: p1.pages,
    foregroundSinceMs: foregroundSince.getTime(),
  };
}

// Foreground done — the row that flips the flag so the UI drops the user into the recent view.
// Still the foreground window: this percent is phase 1's completed one. Phase 2's own first
// update re-stamps it with the backfill window.
function foregroundDoneRow(p1: {
  prCount: number;
  pages: number;
  foregroundSinceMs: number;
}): SyncProgress {
  return {
    percent: 1,
    prsProcessed: p1.prCount,
    pages: p1.pages,
    mode: 'full',
    foregroundComplete: true,
    sinceMs: p1.foregroundSinceMs,
  };
}

/**
 * Phase 2 — continue the SAME cursor walk back to the full backfill window, stamping syncState.
 * `stampAt` is phase 1's start (see SyncRepoOptions.stampIncrementalAt: the gap between the two
 * phases is not covered by the continued cursor, so the next incremental walk must re-read it).
 * `shouldYield` (queued runs only) stops the walk RESUMABLY when another repo is waiting for its
 * foreground pass: it rides the walk's own cancel check, and the cancelled result's `endCursor`
 * is the page to re-fetch.
 */
async function runBackfillPass(
  ctx: WalkCtx,
  cont: { cursor: string | null; stampAt: Date; prsDone: number; pagesDone: number },
  shouldYield?: () => boolean,
): Promise<{ cancelled: boolean; endCursor: string | null; prCount: number; pages: number }> {
  const { repoId, plan } = ctx;
  const r = await syncRepo({
    ...ctx.common,
    mode: 'full',
    // now − backfillDays — or, for a repo marked EXTERNAL since the walk began, the foreground
    // window: the continued cursor is already past it, so the pass ends at once (light sync).
    since: isPinnedCold(repoId) ? new Date(Date.now() - config.foregroundSyncDays * DAY_MS) : plan.since,
    startCursor: cont.cursor,
    commitState: true,
    stampIncrementalAt: cont.stampAt,
    shouldCancel: shouldYield
      ? () => ctx.common.shouldCancel() || shouldYield()
      : ctx.common.shouldCancel,
    onProgress: (p) =>
      setSyncProgress(repoId, {
        ...p,
        prsProcessed: p.prsProcessed + cont.prsDone,
        pages: p.pages + cont.pagesDone,
        mode: 'full',
        foregroundComplete: true,
        sinceMs: plan.since.getTime(),
      }),
  });
  return { cancelled: r.cancelled, endCursor: r.endCursor, prCount: r.prCount, pages: r.pages };
}

/**
 * The bookkeeping a walk's end owes at once (never deferred): the scheduler's health backoff and
 * walk clock, and a deep sync's ML-label purge. `walkStartedAt` is when the walk's coverage
 * began — phase 1's start for a two-phase first sync, so a dirty flag raised between the phases
 * is NOT treated as covered.
 */
async function noteWalkEnded(
  ctx: WalkCtx,
  walk: { cancelled: boolean },
  walkStartedAt: number,
): Promise<void> {
  const { repoId, repo, log } = ctx;
  // A user-initiated walk that came back clean is proof the repo is readable again:
  // clear the scheduler's health backoff so the normal cadence resumes at once instead
  // of after the (up to 6h) window. Failures are deliberately NOT recorded here — the
  // backoff paces the SCHEDULER's unattended attempts, not a person pressing Refresh.
  if (!walk.cancelled) noteWalkSuccess(repoId, Date.now());
  // Adaptive: a completed manual / queued walk covers what the scheduler's dirty flag was
  // waiting to walk, and resets the insurance clock — otherwise the scheduler re-walks the
  // same window once the cap allows. It does NOT stamp `noteWalkStart`: the walk cap paces
  // the scheduler, never a person's Sync.
  if (!walk.cancelled && config.syncAdaptive) {
    recordFullWalk(repoId, Date.now(), walkStartedAt);
  }
  // Deep re-sync is the user's explicit "re-fetch and re-derive everything" gesture:
  // purge this repo's ML labels so the enrichment worker re-scores the whole corpus
  // against the CURRENTLY served model (labels are model_version-stamped; a deep sync
  // after a model upgrade is exactly how stale labels get replaced).
  if (ctx.forceFull && isSeverityApiConfigured()) {
    await deleteMlLabelsForRepo(repo.accountId, repoId);
    log.info(`deep sync ${repo.owner}/${repo.name}: purged ML labels for re-scoring`);
  }
}

/** Is the CI-history backfill still owed? NON-FATAL: an unreadable stamp reads as not owed. */
async function ciHistoryOwed(repoId: number, log: Logger): Promise<boolean> {
  try {
    const { isCiHistoryPending } = await import('./ci-history-pending.js');
    return await isCiHistoryPending(repoId);
  } catch (err) {
    log.warn(
      `ci-history stamp read for repo ${repoId} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/** Stamp (or clear) the CI-history backfill as owed. NON-FATAL, like the backfill itself. */
async function setCiHistoryOwed(repoId: number, owed: boolean, log: Logger): Promise<void> {
  try {
    const m = await import('./ci-history-pending.js');
    await (owed ? m.markCiHistoryPending(repoId) : m.clearCiHistoryPending(repoId));
  } catch (err) {
    log.warn(
      `ci-history stamp write for repo ${repoId} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * BOOT RECOVERY: queue a walk for every repo still owed the CI-history backfill (a restart lost
 * the parked job). The walk is the repo's normal incremental one; its follow-ons find the stamp
 * and run the backfill. Fire-and-forget, never throws.
 */
export async function resumePendingCiHistory(log: Logger): Promise<number> {
  if (!config.ciHistoryBackfill) return 0;
  try {
    const { listCiHistoryPendingRepoIds } = await import('./ci-history-pending.js');
    let queued = 0;
    for (const repoId of await listCiHistoryPendingRepoIds()) {
      if (await enqueueSyncForRepo(repoId, log)) queued++;
    }
    if (queued > 0) log.info(`ci-history: resumed the owed backfill for ${queued} repo(s)`);
    return queued;
  } catch (err) {
    log.warn(
      `ci-history resume failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
}

/**
 * The FOLLOW-ON work a walk tail-runs: the one-time CI-history backfill (full walks only), the
 * bounded per-repo backfills, the co-change index and the change-shape read. Runs while the repo
 * holds its `running` slot. A queued full walk DEFERS this while another repo is still waiting
 * for its first pass (`afterCompletedWalk`).
 */
async function runFollowOns(ctx: WalkCtx, walk: { cancelled: boolean }): Promise<void> {
  const { repoId, repo, plan, token, log, common } = ctx;
  // One-time CI-HISTORY backfill after a completed FULL walk (a repo's first sync, or a
  // forced deep re-sync): trunk commits back to the trend window + synthesized per-PR CI
  // transition events, so the Activity CI charts aren't blank on a fresh repo. Runs while
  // this repo still holds its `running` slot (no snapshot can race it) and is internally
  // non-fatal + cancellation-aware. Dynamically imported so the gate stays the only
  // coupling — a disabled backfill loads nothing.
  //
  // OWED, not just "after a full walk": a full walk stamps it owed (`afterCompletedWalk`) before
  // the follow-ons run or are parked, and any later walk of the repo runs it while that stamp
  // stands — so a restart or a dropped parked job never loses it (sync/ci-history-pending.ts).
  if (
    !walk.cancelled &&
    !cancelRequested.has(repoId) &&
    config.ciHistoryBackfill &&
    (plan.mode === 'full' || (await ciHistoryOwed(repoId, log)))
  ) {
    const { runCiHistoryBackfill } = await import('./backfill-ci-history.js');
    await runCiHistoryBackfill({
      owner: repo.owner,
      name: repo.name,
      repoId,
      accountId: repo.accountId,
      token,
      log,
      shouldCancel: common.shouldCancel,
    });
    // Ran to the end (it never throws): no longer owed. A cancel mid-run keeps it owed.
    if (!cancelRequested.has(repoId) && !common.shouldCancel?.()) {
      await setCiHistoryOwed(repoId, false, log);
    }
  }

  // BLAST RADIUS, step 1 of 3: give every open pull request a FILE LIST.
  //
  // ⚠ FIRST, because the two steps below both read `files` — the co-change index folds it and
  // the change-shape candidate test needs a level to narrow from. Ordering, not preference.
  //
  // A pull request with no stored `files` has no blast radius at all (measured: 9.8% of open
  // pull requests), and no diff read can fix that — there is nothing for a diff to refine.
  // Bounded per run, once per pull request, strictly non-fatal.
  try {
    const { backfillMissingPrFiles } = await import('./routing-files.js');
    await backfillMissingPrFiles(repo.accountId, repoId, log);
  } catch (err) {
    log.warn(
      `files backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  // Chronology's REVIEW-REQUEST HISTORY for merged PRs the walk will never revisit — bounded
  // per run, once per PR (stamped), budget-aware, strictly non-fatal. After every walk, like the
  // files backfill above, so a repo's history converges over a few syncs rather than waiting
  // for a forced deep re-sync.
  try {
    const { backfillReviewRequestHistory } = await import('./backfill-review-requests.js');
    await backfillReviewRequestHistory(repo.accountId, repoId, log);
  } catch (err) {
    log.warn(
      `review-request backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  // DEPENDENCY + SECURITY signals for open automation PRs the walk has not classified — the
  // same shape as the backfill above: bounded per run, stamped once per PR, budget-aware,
  // strictly non-fatal. After every walk, so a PR classified before the detector existed
  // converges in a few syncs rather than waiting for its next push.
  try {
    const { backfillPrSecurity } = await import('./backfill-pr-security.js');
    await backfillPrSecurity(repo.accountId, repoId, log);
  } catch (err) {
    log.warn(
      `security backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
  // COMMIT HEADLINES for open PRs whose commits were stored before `message_headline` existed
  // (My Turn's "Pushed since" card lists them; the board may not fetch on mount). Bounded per
  // run, asked once per PR per process, budget-aware, strictly non-fatal.
  try {
    const { backfillCommitHeadlines } = await import('./backfill-commit-headlines.js');
    await backfillCommitHeadlines(repo.accountId, repoId, log);
  } catch (err) {
    log.warn(
      `commit headline backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  // "A PR WAS RECEIVED": the plugin's Jira ticket worker reads the tickets new and changed PRs
  // name (sync/repo-synced-hooks.ts). A fire-and-forget KICK — it never holds this repo's slot
  // and never fails the sync; inert with no plugin.
  if (!walk.cancelled && !cancelRequested.has(repoId)) {
    notifyRepoSynced({ accountId: repo.accountId, repoId }, log);
  }

  // The UNSETTLED-PR BACKSTOP (sync/unsettled-prs.ts): re-read merge state stored unknown and
  // CI stuck `pending` — GitHub finishing either never bumps `updatedAt`, so the walk's own
  // `since` window can never see it again. FIRE-AND-FORGET (never holds this repo's slot),
  // budget-aware, never throws; free when the repo has no such PRs.
  if (!walk.cancelled && !cancelRequested.has(repoId)) {
    try {
      const { runUnsettledPrBackstop } = await import('./unsettled-prs.js');
      void runUnsettledPrBackstop({ accountId: repo.accountId, repoId, log });
    } catch (err) {
      log.warn(
        `unsettled-PR backstop ${repo.owner}/${repo.name} failed to start (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // The BLAST-RADIUS co-change index for this repo. Purely LOCAL — one indexed read of the
  // repo's merged pull requests, an in-memory fold and one upsert; it makes NO GitHub call
  // and spends no rate-limit budget, so unlike the backfill above it needs no gate and no
  // cancellation check beyond finishing quickly.
  //
  // Rebuilt after every walk rather than once: the index is a function of the repo's merged
  // history, which every walk can extend. It is also self-correcting — a repo that has
  // dropped below the coverage floor has its row DELETED rather than left stale, which is
  // why this is a rebuild and not an append.
  //
  // ⚠ STRICTLY NON-FATAL, like the branch snapshot. This is a nice-to-have arm on one
  // indicator; it must never be the reason a sync reports failure.
  try {
    const { rebuildRepoCoupling } = await import('../db/file-coupling.js');
    await rebuildRepoCoupling(repo.accountId, repoId);
  } catch (err) {
    log.warn(
      `co-change index ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  // BLAST RADIUS: the targeted diff read that tells a comments-only change from a real one.
  // ⚠ AFTER the co-change index above, not before — its candidate test reads the hub signal,
  // and a stale index would misjudge a hub-driven high as surface-driven and spend a call on
  // it. Ordering, not preference.
  //
  // Unlike the index this DOES spend GitHub quota, which is why it is narrow: only pull
  // requests that are currently high on a CONTRACT SURFACE ALONE and small enough for the
  // answer to be plausible, once per head sha, capped per run. Measured at 1.7% of open pull
  // requests. Strictly non-fatal.
  try {
    const { runChangeShapeClassification } = await import('./classify-change-shape.js');
    await runChangeShapeClassification({
      owner: repo.owner,
      name: repo.name,
      repoId,
      accountId: repo.accountId,
      token,
      log,
      shouldCancel: common.shouldCancel,
    });
  } catch (err) {
    log.warn(
      `change-shape ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * After a walk completed: the bookkeeping, then the follow-on work — unless this is a QUEUED
 * full walk and a never-synced repo's FIRST PASS is waiting in the account's queue
 * (`firstPassWaiting`), in which case the follow-ons are parked behind it (returns true: the
 * caller must release with `parked`). A repo's first sync must not wait behind another repo's
 * CI-history backfill any more than behind its 90 days. ⚠ Behind any OTHER front job (a manual
 * or deep walk) the follow-ons run at once, as they did before the breadth-first queue: parking
 * them there made "deep sync everything" hold every repo's follow-ons until the last deep walk
 * ended, outside the deep-sync stand-down.
 */
async function afterCompletedWalk(
  ctx: WalkCtx,
  walk: { cancelled: boolean },
  walkStartedAt: number,
  queue?: AccountQueue,
): Promise<boolean> {
  await noteWalkEnded(ctx, walk, walkStartedAt);
  // Write the CI-history backfill down as OWED before running or parking the follow-ons: the walk
  // is already stamped, so after a restart (or a dropped parked job) nothing else would ask for it.
  if (
    ctx.plan.mode === 'full' &&
    ctx.plan.light !== true &&
    !isPinnedCold(ctx.repoId) &&
    !walk.cancelled &&
    !cancelRequested.has(ctx.repoId) &&
    config.ciHistoryBackfill
  ) {
    await setCiHistoryOwed(ctx.repoId, true, ctx.log);
  }
  if (
    queue &&
    ctx.plan.mode === 'full' &&
    !walk.cancelled &&
    !cancelRequested.has(ctx.repoId) &&
    firstPassWaiting(queue)
  ) {
    const row = progressByRepo.get(ctx.repoId);
    parkInQueue(
      queue,
      {
        kind: 'follow-ons',
        repoId: ctx.repoId,
        log: ctx.log,
        since: ctx.plan.since,
        row: {
          percent: 1,
          prsProcessed: row?.prsProcessed ?? 0,
          pages: row?.pages ?? 0,
          mode: 'full',
          ...(row?.foregroundComplete ? { foregroundComplete: true } : {}),
          sinceMs: ctx.plan.since.getTime(),
        },
      },
      'next',
    );
    return true;
  }
  await runFollowOns(ctx, walk);
  return false;
}

/**
 * Run a sync for one repo, both phases of a first sync back to back. When `background` is true,
 * returns immediately and the sync continues; the running flag and sync_state reflect progress.
 * Returns false if a sync is already in flight. API-triggered syncs go through
 * `enqueueSyncForRepo` instead, which splits a first sync's phases across the account's queue.
 */
export async function runSyncForRepo(
  repoId: number,
  log: Logger,
  opts: { background?: boolean; forceFull?: boolean } = {},
): Promise<boolean> {
  const ctx = await prepareWalk(repoId, log, { forceFull: opts.forceFull });
  if (!ctx) return false;

  // When this (uncapped) walk began — a dirty flag raised before it is covered by it.
  const walkStartedAt = Date.now();
  const task = (async () => {
    let walk: { cancelled: boolean };
    if (isTwoPhase(ctx)) {
      const p1 = await runForegroundPass(ctx);
      if (p1.cancelled) {
        walk = { cancelled: true };
      } else {
        setSyncProgress(repoId, foregroundDoneRow(p1));
        notifyRepoWalked(ctx.repo.accountId, repoId, p1);
        const p2 = await runBackfillPass(ctx, {
          cursor: p1.endCursor,
          stampAt: new Date(walkStartedAt),
          prsDone: 0,
          pagesDone: 0,
        });
        walk = { cancelled: p2.cancelled };
      }
    } else {
      walk = await runSinglePass(ctx);
      notifyRepoWalked(ctx.repo.accountId, repoId, walk);
    }
    await afterCompletedWalk(ctx, walk, walkStartedAt);
  })()
    .catch((err) => {
      log.error(
        `background sync ${ctx.repo.owner}/${ctx.repo.name} failed: ${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => releaseWalk(repoId, log));

  // background:false waits for the whole task (walk + follow-on phases + the finally) to
  // settle before returning. The task's .catch above means this await never throws.
  if (!opts.background) await task;
  return true;
}

// ---- The per-account queue's jobs ----
//
// BREADTH-FIRST FIRST SYNC. A never-synced repo's walk is two jobs, not one: its foreground pass
// (a FRONT job, FIFO with every other ordinary walk), then its backfill (a BACK job). The queue
// always takes a front job before a back job, so with five repos added at once every repo's
// recent PRs land before any repo's 90 days start. A back job is the repo's backfill (resumed
// from phase 1's cursor) or its parked follow-on work (parked ONLY behind a waiting first pass,
// and run ahead of the front once none is waiting); a running backfill YIELDS — resumably, at
// a page boundary — the moment a front job is waiting. Between jobs the repo sits in
// `queuedRepos` with an honest `paused: 'queued'` row, so the scheduler, the settle sweep and a
// second enqueue all leave it alone and a cancel drops it synchronously.
type QueuedJob =
  | {
      kind: 'walk';
      repoId: number;
      log: Logger;
      forceFull: boolean;
      // A never-synced repo's walk, which runs as two phases: its foreground pass is what parked
      // follow-ons wait for (`firstPassWaiting`). Decided at enqueue from the same plan.
      firstPass: boolean;
    }
  | {
      kind: 'backfill';
      repoId: number;
      log: Logger;
      since: Date;
      cursor: string | null;
      // Phase 1's start: the stamp (and walk-coverage start) the completed backfill records.
      stampAt: Date;
      // Counts from this backfill's earlier (yielded) segments, so its progress row never
      // counts backwards when it resumes.
      prsDone: number;
      pagesDone: number;
      row: SyncProgress;
    }
  | { kind: 'follow-ons'; repoId: number; log: Logger; since: Date; row: SyncProgress };

interface AccountQueue {
  front: QueuedJob[];
  back: QueuedJob[];
  draining: boolean;
}

/** Is a never-synced repo's first (foreground) pass waiting in this queue? Only then is a
 *  completed walk's follow-on work parked, and only then does parked work wait for the front. */
function firstPassWaiting(queue: AccountQueue): boolean {
  return queue.front.some((j) => j.kind === 'walk' && j.firstPass);
}

/**
 * The next job: front before back — except that parked follow-on work no longer waits once no
 * first pass is waiting (a deep or manual walk queued behind does not hold it back).
 */
function nextJob(queue: AccountQueue): QueuedJob | undefined {
  if (!firstPassWaiting(queue)) {
    const i = queue.back.findIndex((j) => j.kind === 'follow-ons');
    if (i >= 0) return queue.back.splice(i, 1)[0];
  }
  return queue.front.shift() ?? queue.back.shift();
}

function queueFor(accountId: number): AccountQueue {
  let q = accountQueues.get(accountId);
  if (!q) {
    q = { front: [], back: [], draining: false };
    accountQueues.set(accountId, q);
  }
  return q;
}

/**
 * Hand a repo that holds `running` back to the queue as a BACK job. ⚠ Synchronous, and
 * `queuedRepos` is added BEFORE the caller releases `running` (releaseWalk with `parked`), so
 * there is no instant in which the repo reads idle — the scheduler would otherwise start a
 * single-pass 90-day walk on a repo whose syncState is still unstamped.
 */
function parkInQueue(
  queue: AccountQueue,
  job: QueuedJob & { row: SyncProgress },
  where: 'next' | 'last',
): void {
  queuedRepos.add(job.repoId);
  setSyncProgress(job.repoId, { ...job.row, paused: { reason: 'queued' } });
  if (where === 'next') queue.back.unshift(job);
  else queue.back.push(job);
}

/** True when every queued job of this repo is parked follow-on work (its walk is done and stamped). */
function onlyFollowOnsQueued(repoId: number): boolean {
  let any = false;
  for (const q of accountQueues.values()) {
    for (const job of [...q.front, ...q.back]) {
      if (job.repoId !== repoId) continue;
      if (job.kind !== 'follow-ons') return false;
      any = true;
    }
  }
  return any;
}

function dropQueuedJobs(repoId: number): void {
  for (const q of accountQueues.values()) {
    for (const list of [q.front, q.back]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]!.repoId === repoId) list.splice(i, 1);
      }
    }
  }
}

async function drainAccountQueue(accountId: number, queue: AccountQueue): Promise<void> {
  for (;;) {
    const job = nextJob(queue);
    if (!job) break;
    // Dropped while waiting (cancelled / cancel-and-deleted): its progress row is already
    // cleared, and nothing must run.
    if (!queuedRepos.delete(job.repoId)) continue;
    try {
      await runQueuedJob(job, queue);
    } catch (err) {
      // The queue must survive a failed job, or one bad repo wedges every later sync of the
      // account. (The job runners catch their own walk errors; this guards everything else.)
      job.log.error(
        `queued sync of repo ${job.repoId} failed: ${err instanceof Error ? err.message : err}`,
      );
      if (!running.has(job.repoId) && !queuedRepos.has(job.repoId)) clearSyncProgress(job.repoId);
    }
  }
  // No await since the last empty check: a job enqueued from here on starts a new drain.
  queue.draining = false;
  if (accountQueues.get(accountId) === queue) accountQueues.delete(accountId);
}

async function runQueuedJob(job: QueuedJob, queue: AccountQueue): Promise<void> {
  const { repoId, log } = job;
  if (job.kind === 'walk') {
    const ctx = await prepareWalk(repoId, log, { forceFull: job.forceFull });
    // A null (repo deleted mid-queue, token failure) must still drop the queued progress row,
    // which a failed prepareWalk never owned.
    if (!ctx) {
      if (!running.has(repoId)) clearSyncProgress(repoId);
      return;
    }
    const walkStartedAt = Date.now();
    let parked = false;
    try {
      if (isTwoPhase(ctx)) {
        const p1 = await runForegroundPass(ctx);
        if (p1.cancelled || cancelRequested.has(repoId)) return;
        // The backfill goes to the BACK of the queue: every repo already waiting for its
        // foreground pass runs first, and earlier repos' backfills keep their places.
        const row = foregroundDoneRow(p1);
        notifyRepoWalked(ctx.repo.accountId, repoId, p1);
        parkInQueue(
          queue,
          {
            kind: 'backfill',
            repoId,
            log,
            since: ctx.plan.since,
            cursor: p1.endCursor,
            stampAt: new Date(walkStartedAt),
            prsDone: 0,
            pagesDone: 0,
            row,
          },
          'last',
        );
        parked = true;
        return;
      }
      const walk = await runSinglePass(ctx);
      notifyRepoWalked(ctx.repo.accountId, repoId, walk);
      parked = await afterCompletedWalk(ctx, walk, walkStartedAt, queue);
    } catch (err) {
      log.error(
        `background sync ${ctx.repo.owner}/${ctx.repo.name} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      releaseWalk(repoId, log, parked);
    }
    return;
  }

  if (job.kind === 'backfill') {
    const ctx = await prepareWalk(repoId, log, {
      plan: { mode: 'full', since: job.since },
      progress: job.row,
    });
    if (!ctx) {
      if (!running.has(repoId)) clearSyncProgress(repoId);
      return;
    }
    let parked = false;
    try {
      const p2 = await runBackfillPass(ctx, job, () => queue.front.length > 0);
      if (cancelRequested.has(repoId)) return;
      if (p2.cancelled) {
        // YIELDED to a waiting foreground pass: resume from the page it stopped on, first in
        // line among the back jobs, once the front is empty again.
        const prsDone = job.prsDone + p2.prCount;
        const pagesDone = job.pagesDone + p2.pages;
        const now = progressByRepo.get(repoId);
        parkInQueue(
          queue,
          {
            ...job,
            cursor: p2.endCursor,
            prsDone,
            pagesDone,
            row: {
              percent: now?.percent ?? 0,
              prsProcessed: prsDone,
              pages: pagesDone,
              mode: 'full',
              foregroundComplete: true,
              sinceMs: job.since.getTime(),
            },
          },
          'next',
        );
        parked = true;
        return;
      }
      parked = await afterCompletedWalk(ctx, { cancelled: false }, job.stampAt.getTime(), queue);
    } catch (err) {
      log.error(
        `background sync ${ctx.repo.owner}/${ctx.repo.name} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      releaseWalk(repoId, log, parked);
    }
    return;
  }

  // Parked follow-on work: the repo's walk is complete and stamped; run what it deferred.
  const ctx = await prepareWalk(repoId, log, {
    plan: { mode: 'full', since: job.since },
    progress: job.row,
  });
  if (!ctx) {
    if (!running.has(repoId)) clearSyncProgress(repoId);
    return;
  }
  try {
    await runFollowOns(ctx, { cancelled: false });
  } catch (err) {
    log.error(
      `follow-on work ${ctx.repo.owner}/${ctx.repo.name} failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    releaseWalk(repoId, log);
  }
}

/**
 * Queue an API-triggered sync behind the account's other API-triggered walks (the add-repo
 * initial backfill and the manual/deep sync both come through here). Returns false when the
 * repo is already running or queued (the manual route 409s), true once queued — the walk
 * itself runs when its turn comes. While waiting, the repo shows a 'running' status with a
 * `paused: { reason: 'queued' }` progress row; the walk's own first progress write clears the
 * flag when it actually starts.
 */
export async function enqueueSyncForRepo(
  repoId: number,
  log: Logger,
  opts: { forceFull?: boolean } = {},
): Promise<boolean> {
  if (running.has(repoId) || queuedRepos.has(repoId)) return false;
  // Reserve synchronously, BEFORE any await (the running.add rule above): a second
  // enqueue racing the lookups below must already see this repo as queued.
  queuedRepos.add(repoId);
  let repo: RepoRow;
  let firstPass = false;
  try {
    const row = await getRepoRow(repoId);
    if (!row) {
      queuedRepos.delete(repoId);
      return false;
    }
    repo = row;
    // The plan is display-only here (the honest waiting row); the walk re-plans when it
    // actually starts. `since` rides it so a repo QUEUED for a cold-return catch-up
    // is reported as one from the moment it is queued, not only once it starts walking.
    const plan = opts.forceFull
      ? { mode: 'full' as const, since: new Date(Date.now() - config.backfillDays * DAY_MS) }
      : await planSync(repoId);
    // A cancel may have raced the awaits above (requestSyncCancel drops queued repos and
    // clears their progress synchronously) — don't resurrect the row it already cleared.
    if (!queuedRepos.has(repoId)) return false;
    // The same rule as `isTwoPhase`, from the same plan.
    firstPass = !opts.forceFull && plan.mode === 'full' && config.backfillDays > config.foregroundSyncDays;
    setSyncProgress(repoId, {
      percent: 0,
      prsProcessed: 0,
      pages: 0,
      mode: plan.mode,
      sinceMs: plan.since.getTime(),
      paused: { reason: 'queued' },
    });
  } catch (err) {
    // A rejected lookup must release the reservation, or a transient DB error leaves the
    // repo 'queued' forever: status reads 'running' with no progress, every later
    // enqueue is refused, and the scheduler skips it. Rethrow so both routes keep their
    // current error behaviour.
    queuedRepos.delete(repoId);
    clearSyncProgress(repoId);
    throw err;
  }

  const queue = queueFor(repo.accountId);
  queue.front.push({ kind: 'walk', repoId, log, forceFull: opts.forceFull === true, firstPass });
  if (!queue.draining) {
    queue.draining = true;
    void drainAccountQueue(repo.accountId, queue);
  }
  return true;
}

/**
 * Incrementally sync every configured repo (used by the scheduler, every 10s by default).
 *
 * ⚠ ONE TICK AT A TIME. A tick that finds the previous one still running returns at once: the
 * loop is sequential, so a slow walk delays the next tick instead of piling a second loop on top
 * of it (which would also double every repo's probe).
 */
export async function syncAllRepos(log: Logger): Promise<void> {
  // The settle sweep is kicked BEFORE the one-tick claim: it has its own one-at-a-time claim, and
  // a long walk holding the tick (a resumed backfill, a budget-paced walk) must not also starve
  // every other repo's updatedAt-silent freshness for its whole length.
  if (config.syncAdaptive && deepSyncing.size === 0) kickSettleSweep(log);
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runScheduledTick(log);
  } finally {
    tickInFlight = false;
  }
}

/**
 * EXTERNAL REPOS: reload sync's in-memory external set (sync/adaptive.ts `setPinnedColdRepos`) —
 * the cold cadence and light sync read it. Called at boot and after every mode change. Never throws.
 */
export async function refreshExternalRepoCadence(log?: Pick<Logger, 'warn'>): Promise<void> {
  try {
    setPinnedColdRepos(await allExternalRepoIds());
  } catch (err) {
    log?.warn(`external repos: could not refresh the sync cadence: ${err instanceof Error ? err.message : err}`);
  }
}

/** Test-only: is a scheduled tick in progress? */
export function __isScheduledTickInFlight(): boolean {
  return tickInFlight;
}

/**
 * THE SETTLE SWEEP (sync/settle-sweep.ts) — the updatedAt-SILENT half of freshness (CI finishing,
 * a thread resolved, the trunk moving under open PRs). FIRE-AND-FORGET with its own one-at-a-time
 * claim, so a ~1-point-per-repo read and its few single-PR syncs never hold up the probes. It
 * reads only repos whose settle interval is due; free otherwise. Never throws.
 */
function kickSettleSweep(log: Logger): void {
  void import('./settle-sweep.js')
    .then(({ runSettleSweep }) =>
      runSettleSweep({ log, isBusy: (id) => running.has(id) || queuedRepos.has(id) }),
    )
    .catch((err: unknown) => {
      log.warn(
        `settle sweep failed to start (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    });
}

async function runScheduledTick(log: Logger): Promise<void> {
  // Stand down entirely while a deep (forced-full) sync is in progress. Resuming
  // a repo incrementally the instant its deep sync finishes would reset its
  // progress bar mid-session; idempotent upserts + the overlap window mean the
  // next scheduled tick loses nothing by waiting.
  if (deepSyncing.size > 0) {
    log.info(
      `scheduled sync skipped: deep sync in progress (${deepSyncing.size} repo(s))`,
    );
    return;
  }
  // Every repo, every tick (the adaptive due-check below decides which actually walk).
  const all = await db.select({ id: repos.id }).from(repos).execute();
  for (const r of all) {
    // Skip repos mid-sync AND repos waiting in the API queue — the queue will run them,
    // and a scheduler-started incremental would reset their honest 'queued' row.
    if (running.has(r.id) || queuedRepos.has(r.id) || probing.has(r.id)) continue;
    // Adaptive (config.syncAdaptive, ON BY DEFAULT — the tick is every TEN SECONDS, so this
    // due-check is the only thing between a repo and 360 attempts an hour): skip repos not yet
    // due for their activity bucket, widened by the health backoff after consecutive failures.
    // Cheap, no I/O — before reserving anything or fetching a token.
    if (config.syncAdaptive && !isDue(r.id, Date.now())) continue;
    // Reserve the PROBE slot synchronously before the now-async getRepoRow/planSync awaits
    // below, so a concurrent caller sees the repo as busy (isSyncRunning) — but NOT as a running
    // sync (see `probing`). Moved into `running` only once a walk is decided.
    probing.add(r.id);
    // ⚠ STAMP THE ATTEMPT FOR EVERY SCHEDULED SYNC, WHATEVER THE MODE, BEFORE ANY AWAIT.
    // decideIncrementalWalk stamps the incremental branch, and for a long time that was the
    // ONLY writer — so a repo pinned in FULL mode (which is exactly what a repo whose first
    // walk always fails is) was due on every single tick and re-walked once a minute
    // forever. This is the floor that makes that structurally impossible; the backoff below
    // is what makes the interval sane.
    noteAttempt(r.id, Date.now());
    // Did THIS iteration take the `running` slot? Only then may the `finally` release it — a
    // manual sync that started while we probed owns its own slot.
    let walking = false;
    try {
      const repo = (await getRepoRow(r.id))!;
      const token = await getAccessToken(repo.accountId);
      const plan = await planSync(r.id);
      // Adaptive: for an INCREMENTAL sync, probe a cheap conditional request first and skip
      // the fat GraphQL walk when nothing changed (304, free) and the insurance walk isn't
      // due; a change is walked at most once per walk cap (adaptive.ts). First backfills
      // (mode 'full') always walk. The `finally` releases the slot.
      if (config.syncAdaptive && plan.mode === 'incremental') {
        const decision = await decideIncrementalWalk(
          r.id,
          repo.owner,
          repo.name,
          token,
          Date.now(),
          // Lets the probe stand down entirely while the account is rate-limited (a
          // limited probe fails non-304, which "never skip on uncertainty" would turn
          // into MORE walks — the opposite of what a limited token needs).
          repo.accountId,
        );
        // No log line for a skip: at a 10-second tick an idle workspace would print one per
        // probe. A walk logs itself.
        if (!decision.walk) continue;
      }
      // The walk decision is made; a manual sync (or a queued one) may have started while we
      // probed. It wins — this tick stands down for the repo. Checked and claimed with no await
      // in between, so exactly one of the two walks.
      if (running.has(r.id) || queuedRepos.has(r.id)) continue;
      running.add(r.id);
      walking = true;
      probing.delete(r.id);
      const walkStartedAt = Date.now();
      if (config.syncAdaptive) noteWalkStart(r.id, walkStartedAt);
      setSyncProgress(r.id, {
        percent: 0,
        prsProcessed: 0,
        pages: 0,
        mode: plan.mode,
        sinceMs: plan.since.getTime(),
      });
      const walked = await syncRepo({
        owner: repo.owner,
        name: repo.name,
        accountId: repo.accountId,
        // So a walk that dies BEFORE upsertRepo still records an error on sync_state (see
        // SyncRepoOptions.knownRepoId): without it a repo that has never once synced
        // reports 'idle' with no error and the failure is invisible on every surface.
        knownRepoId: r.id,
        token,
        ...plan,
        commitState: true,
        commitFileConcurrency: config.commitFileConcurrency,
        log,
        onProgress: (p) =>
          setSyncProgress(r.id, { ...p, mode: plan.mode, sinceMs: plan.since.getTime() }),
        shouldCancel: () => cancelRequested.has(r.id),
      });
      // Adaptive: reset the insurance clock, and clear the dirty flag the walk covered.
      if (config.syncAdaptive) recordFullWalk(r.id, Date.now(), walkStartedAt);
      // ...and clear any health backoff: this repo is readable again.
      noteWalkSuccess(r.id, Date.now());
      // A cancelled walk notifies nobody (walk-listeners.ts decides, from this result).
      notifyRepoWalked(repo.accountId, r.id, walked);
      // Chronology's review-request history for merged PRs the walk never revisits. The
      // scheduled path carries no post-walk tail of its own (runSyncForRepo's is user-triggered),
      // and without this the history would only converge when somebody pressed Sync. Bounded,
      // stamped once per PR, budget-aware, and a failure here is logged, never the walk's.
      try {
        const { backfillReviewRequestHistory } = await import('./backfill-review-requests.js');
        await backfillReviewRequestHistory(repo.accountId, r.id, log);
      } catch (err) {
        log.warn(
          `review-request backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
      // The dependency + security backfill, for the same reason: without it, an open automation
      // PR nobody pushes to is only classified when somebody presses Sync.
      try {
        const { backfillPrSecurity } = await import('./backfill-pr-security.js');
        await backfillPrSecurity(repo.accountId, r.id, log);
      } catch (err) {
        log.warn(
          `security backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
      // COMMIT HEADLINES for open PRs whose commits were stored before `message_headline` existed
      // (My Turn's "Pushed since" card lists them; the board may not fetch on mount). Bounded per
      // run, asked once per PR per process, budget-aware, strictly non-fatal.
      try {
        const { backfillCommitHeadlines } = await import('./backfill-commit-headlines.js');
        await backfillCommitHeadlines(repo.accountId, r.id, log);
      } catch (err) {
        log.warn(
          `commit headline backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
      // The unsettled-PR backstop, as on the manual tail: merge state stored unknown and CI stuck
      // `pending` are updatedAt-silent, so no walk's `since` window can see them.
      // FIRE-AND-FORGET — this loop is sequential per tick, and a ~5s merge-state read must not
      // delay every other repo's walk. Never throws; free when there is nothing to re-read.
      if (!cancelRequested.has(r.id)) {
        try {
          const { runUnsettledPrBackstop } = await import('./unsettled-prs.js');
          void runUnsettledPrBackstop({ accountId: repo.accountId, repoId: r.id, log });
        } catch (err) {
          log.warn(
            `unsettled-PR backstop ${repo.owner}/${repo.name} failed to start (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      // Health backoff: a repo we cannot read must not be retried at the cadence of a
      // healthy one. The count is the ONLY thing that widens the interval past its activity
      // bucket (a first-sighted repo reads HOT, i.e. 20s), so this line is load-bearing —
      // and the error itself is already on sync_state via knownRepoId, so the UI can say so.
      const failures = noteWalkFailure(r.id, Date.now());
      log.error(
        `scheduled sync of repo ${r.id} failed (${failures} consecutive; next attempt in ` +
          `≥${Math.round(backoffMsFor(r.id) / 60_000)} min): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    } finally {
      probing.delete(r.id);
      if (walking) {
        running.delete(r.id);
        cancelRequested.delete(r.id);
        clearSyncProgress(r.id);
      }
    }
  }
}
