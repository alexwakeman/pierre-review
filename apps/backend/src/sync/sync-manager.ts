import { eq } from 'drizzle-orm';
import type { SyncProgress, SyncRunStatus, SyncStatus } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
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

export function getSyncStatus(repoId: number): SyncStatus | null {
  const state = db
    .select()
    .from(syncState)
    .where(eq(syncState.repoId, repoId))
    .get();

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
}

function getRepoRow(repoId: number): RepoRow | null {
  return (
    db
      .select({ id: repos.id, owner: repos.owner, name: repos.name })
      .from(repos)
      .where(eq(repos.id, repoId))
      .get() ?? null
  );
}

// Decide window: incremental if we've ever synced, otherwise a full backfill.
function planSync(repoId: number): { mode: 'full' | 'incremental'; since: Date } {
  const state = db
    .select()
    .from(syncState)
    .where(eq(syncState.repoId, repoId))
    .get();
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
export function runSyncForRepo(
  repoId: number,
  log: Logger,
  opts: { background?: boolean; forceFull?: boolean } = {},
): boolean {
  if (running.has(repoId)) return false;
  const repo = getRepoRow(repoId);
  if (!repo) return false;

  const plan = opts.forceFull
    ? { mode: 'full' as const, since: new Date(Date.now() - config.backfillDays * DAY_MS) }
    : planSync(repoId);

  running.add(repoId);
  // Track forced-full runs so the scheduler stands down for the whole deep-sync
  // session (added synchronously here, before any await, so a cron tick that
  // fires right after this call already sees the deep sync as active).
  if (opts.forceFull) deepSyncing.add(repoId);
  setSyncProgress(repoId, { percent: 0, prsProcessed: 0, pages: 0, mode: plan.mode });
  const task = syncRepo({
    owner: repo.owner,
    name: repo.name,
    ...plan,
    log,
    onProgress: (p) => setSyncProgress(repoId, { ...p, mode: plan.mode }),
  })
    .catch((err) => {
      log.error(
        `background sync ${repo.owner}/${repo.name} failed: ${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => {
      running.delete(repoId);
      deepSyncing.delete(repoId);
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
  const all = db.select({ id: repos.id }).from(repos).all();
  for (const r of all) {
    if (running.has(r.id)) continue;
    running.add(r.id);
    try {
      const repo = getRepoRow(r.id)!;
      const plan = planSync(r.id);
      setSyncProgress(r.id, { percent: 0, prsProcessed: 0, pages: 0, mode: plan.mode });
      await syncRepo({
        owner: repo.owner,
        name: repo.name,
        ...plan,
        log,
        onProgress: (p) => setSyncProgress(r.id, { ...p, mode: plan.mode }),
      });
    } catch (err) {
      log.error(
        `scheduled sync of repo ${r.id} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      running.delete(r.id);
      clearSyncProgress(r.id);
    }
  }
}
