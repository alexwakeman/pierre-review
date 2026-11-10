// ARE A WORKSPACE'S SYNCED HEADS CURRENT? — the auto review's CATCH-UP gate (review/claude-review/auto.ts;
// docs/CLAUDE-REVIEW.md § Auto review → Catch-up on return). After a boot, a wake from sleep or a long
// gap between ticks, the database may hold heads that moved while Limn was off. Reviewing them would
// review (and claim) an old commit. So the sweeper waits until every repo of the workspace was checked
// against GitHub after the gap began:
//   • adaptive polling (the default): GitHub answered for the repo (a probe, a walk, a settle read) at
//     or after `sinceMs` and no change it saw is still waiting for a walk (sync/adaptive.ts);
//   • a pinned SYNC_CRON: the repo's last completed sync (`sync_state`) is at or after `sinceMs`.
// A repo with no membership is not the workspace's; an empty workspace is fresh.
// ⚠ Opens NO database at import (the pure fold's test imports this module): the reads are lazy.
import { inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { checkedCleanSince } from './adaptive.js';

/** Pure: is every repo fresh? `syncedAtMs` is consulted only without adaptive polling. */
export function headsFresh(
  repoIds: readonly number[],
  sinceMs: number,
  adaptive: boolean,
  isCheckedClean: (repoId: number, sinceMs: number) => boolean,
  syncedAtMs: ReadonlyMap<number, number>,
): boolean {
  return repoIds.every((id) => (adaptive ? isCheckedClean(id, sinceMs) : (syncedAtMs.get(id) ?? 0) >= sinceMs));
}

export async function workspaceHeadsFreshSince(accountId: number, workspaceId: number, sinceMs: number): Promise<boolean> {
  const [{ db, schema }, { getWorkspaceRepoIds }] = await Promise.all([import('../db/client.js'), import('../db/queries.js')]);
  const repoIds = await getWorkspaceRepoIds(workspaceId, accountId);
  if (repoIds.length === 0) return true;
  const synced = new Map<number, number>();
  if (!config.syncAdaptive) {
    const { syncState } = schema;
    for (const r of await db
      .select({
        repoId: syncState.repoId,
        full: syncState.lastFullSyncAt,
        incremental: syncState.lastIncrementalSyncAt,
      })
      .from(syncState)
      .where(inArray(syncState.repoId, repoIds))
      .execute()) {
      synced.set(r.repoId, Math.max(r.full?.getTime() ?? 0, r.incremental?.getTime() ?? 0));
    }
  }
  return headsFresh(repoIds, sinceMs, config.syncAdaptive, checkedCleanSince, synced);
}
