import { eq } from 'drizzle-orm';
import type { SyncProgress, SyncRunStatus, SyncStatus } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { syncRepo, type Logger } from './sync-repo.js';

const { repos, syncState } = schema;

// In-memory record of which repos are mid-sync (status isn't persisted as
// "running" — it lives only for the lifetime of the process).
const running = new Set<number>();

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

// Repos the user has asked to STOP mid-sync. syncRepo polls this between pages
// (and PRs) and bails out without recording the run as complete, so a cancelled
// initial backfill leaves the repo "never synced" (the cancel endpoint then
// deletes it + its partial data). Only meaningful while the repo is running.
const cancelRequested = new Set<number>();

export function requestSyncCancel(repoId: number): void {
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

// Live progress for in-flight syncs, surfaced via getSyncStatus so the UI can
// show a determinate bar. Lives only for the duration of the run.
const progressByRepo = new Map<number, SyncProgress>();

function setSyncProgress(repoId: number, p: SyncProgress): void {
  progressByRepo.set(repoId, p);
}

function clearSyncProgress(repoId: number): void {
  progressByRepo.delete(repoId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isSyncRunning(repoId: number): boolean {
  return running.has(repoId);
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

  let status: SyncRunStatus = 'idle';
  if (running.has(repoId)) status = 'running';
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
): Promise<{ mode: 'full' | 'incremental'; since: Date }> {
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
  return { mode: 'full', since: new Date(Date.now() - config.backfillDays * DAY_MS) };
}

/**
 * Run a sync for one repo. When `background` is true (the default for the API),
 * returns immediately and the sync continues; the running flag and sync_state
 * reflect progress. Returns false if a sync is already in flight.
 */
export async function runSyncForRepo(
  repoId: number,
  log: Logger,
  opts: { background?: boolean; forceFull?: boolean } = {},
): Promise<boolean> {
  if (running.has(repoId)) return false;
  // Reserve the slot synchronously, BEFORE any await, so a cron tick (or a
  // second request) firing during the now-async getRepoRow/planSync below sees
  // this repo as already in-flight and stands down. Mirror this with a
  // running.delete on every early-bail after this point.
  running.add(repoId);
  // Track forced-full runs so the scheduler stands down for the whole deep-sync
  // session (added synchronously here, before any await, so a cron tick that
  // fires right after this call already sees the deep sync as active).
  if (opts.forceFull) deepSyncing.add(repoId);

  const repo = await getRepoRow(repoId);
  if (!repo) {
    running.delete(repoId);
    if (opts.forceFull) deepSyncing.delete(repoId);
    return false;
  }

  const plan = opts.forceFull
    ? { mode: 'full' as const, since: new Date(Date.now() - config.backfillDays * DAY_MS) }
    : await planSync(repoId);

  setSyncProgress(repoId, { percent: 0, prsProcessed: 0, pages: 0, mode: plan.mode });
  let token: string;
  try {
    token = await getAccessToken(repo.accountId);
  } catch (err) {
    running.delete(repoId);
    if (opts.forceFull) deepSyncing.delete(repoId);
    clearSyncProgress(repoId);
    log.error(
      `sync ${repo.owner}/${repo.name}: no access token for account ${repo.accountId}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }

  const common = {
    owner: repo.owner,
    name: repo.name,
    accountId: repo.accountId,
    token,
    log,
    commitFileConcurrency: config.commitFileConcurrency,
    shouldCancel: () => cancelRequested.has(repoId),
  };

  // Two-phase only for a first full backfill (never-synced, not a forced "deep"
  // re-sync) when the backfill window is wider than the foreground window. A deep
  // re-sync stays single-pass — its board is already populated, so there's no
  // blank-board wait to shorten.
  const twoPhase =
    !opts.forceFull && plan.mode === 'full' && config.backfillDays > config.foregroundSyncDays;

  const runWalk = async (): Promise<void> => {
    if (!twoPhase) {
      await syncRepo({
        ...common,
        mode: plan.mode,
        since: plan.since,
        commitState: true,
        onProgress: (p) => setSyncProgress(repoId, { ...p, mode: plan.mode }),
      });
      return;
    }
    // Phase 1 — the fast foreground window (the default timeline range). Committed
    // per-PR so the recent board is usable in seconds, but does NOT stamp
    // syncState, so the repo stays an "initial backfill" until phase 2 finishes.
    const foregroundSince = new Date(Date.now() - config.foregroundSyncDays * DAY_MS);
    const p1 = await syncRepo({
      ...common,
      mode: 'full',
      since: foregroundSince,
      commitState: false,
      onProgress: (p) =>
        setSyncProgress(repoId, { ...p, mode: 'full', foregroundComplete: false }),
    });
    if (p1.cancelled) return;
    // Foreground done — flip the flag so the UI drops the user into the recent
    // view, then continue the SAME cursor walk back to the full backfill window.
    setSyncProgress(repoId, {
      percent: 1,
      prsProcessed: p1.prCount,
      pages: p1.pages,
      mode: 'full',
      foregroundComplete: true,
    });
    await syncRepo({
      ...common,
      mode: 'full',
      since: plan.since, // now − backfillDays
      startCursor: p1.endCursor,
      commitState: true,
      onProgress: (p) =>
        setSyncProgress(repoId, { ...p, mode: 'full', foregroundComplete: true }),
    });
  };

  const task = runWalk()
    .catch((err) => {
      log.error(
        `background sync ${repo.owner}/${repo.name} failed: ${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => {
      running.delete(repoId);
      deepSyncing.delete(repoId);
      cancelRequested.delete(repoId);
      clearSyncProgress(repoId);
    });

  if (!opts.background) return Boolean(task);
  return true;
}

/** Incrementally sync every configured repo (used by the scheduler). */
export async function syncAllRepos(log: Logger): Promise<void> {
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
  const all = await db.select({ id: repos.id }).from(repos).execute();
  for (const r of all) {
    if (running.has(r.id)) continue;
    // Reserve the slot synchronously before the now-async getRepoRow/planSync
    // awaits below so a concurrent tick doesn't double-start this repo.
    running.add(r.id);
    try {
      const repo = (await getRepoRow(r.id))!;
      const token = await getAccessToken(repo.accountId);
      const plan = await planSync(r.id);
      setSyncProgress(r.id, { percent: 0, prsProcessed: 0, pages: 0, mode: plan.mode });
      await syncRepo({
        owner: repo.owner,
        name: repo.name,
        accountId: repo.accountId,
        token,
        ...plan,
        commitState: true,
        commitFileConcurrency: config.commitFileConcurrency,
        log,
        onProgress: (p) => setSyncProgress(r.id, { ...p, mode: plan.mode }),
        shouldCancel: () => cancelRequested.has(r.id),
      });
    } catch (err) {
      log.error(
        `scheduled sync of repo ${r.id} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      running.delete(r.id);
      cancelRequested.delete(r.id);
      clearSyncProgress(r.id);
    }
  }
}
