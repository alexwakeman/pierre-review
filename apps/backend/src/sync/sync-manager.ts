import { eq } from 'drizzle-orm';
import type { SyncRunStatus, SyncStatus } from '@gh-team-monitor/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { syncRepo, type Logger } from './sync-repo.js';

const { repos, syncState } = schema;

// In-memory record of which repos are mid-sync (status isn't persisted as
// "running" — it lives only for the lifetime of the process).
const running = new Set<number>();

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
  const task = syncRepo({ owner: repo.owner, name: repo.name, ...plan, log })
    .catch((err) => {
      log.error(
        `background sync ${repo.owner}/${repo.name} failed: ${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => {
      running.delete(repoId);
    });

  if (!opts.background) return Boolean(task);
  return true;
}

/** Incrementally sync every configured repo (used by the scheduler). */
export async function syncAllRepos(log: Logger): Promise<void> {
  const all = db.select({ id: repos.id }).from(repos).all();
  for (const r of all) {
    if (running.has(r.id)) continue;
    running.add(r.id);
    try {
      const repo = getRepoRow(r.id)!;
      const plan = planSync(r.id);
      await syncRepo({ owner: repo.owner, name: repo.name, ...plan, log });
    } catch (err) {
      log.error(
        `scheduled sync of repo ${r.id} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      running.delete(r.id);
    }
  }
}
