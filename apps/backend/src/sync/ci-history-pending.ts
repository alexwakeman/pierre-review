import { and, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

// THE CI-HISTORY "STILL OWED" STAMP (`sync_state.ci_history_pending_at`, migration 0156).
//
// The one-time CI-history backfill runs as FOLLOW-ON work after a completed FULL walk — and a
// queued full walk PARKS its follow-ons in the in-memory account queue while another repo waits
// for its first pass. The walk itself is already stamped (`lastFullSyncAt`), so a restart or a
// dropped job would leave an incremental-mode repo whose CI charts stay empty for good. So the
// owed backfill is written down before it is deferred, cleared only once it RAN, and any later
// walk of the repo (or the boot recovery, `resumePendingCiHistory`) runs it when it finds the stamp.
//
// Every helper here is NON-FATAL by contract at the call site (sync-manager wraps them).

const { syncState } = schema;

/** Write down that this repo is owed the CI-history backfill. The repo's walk stamped its row. */
export async function markCiHistoryPending(repoId: number, at: Date = new Date()): Promise<void> {
  await db
    .update(syncState)
    .set({ ciHistoryPendingAt: at })
    .where(eq(syncState.repoId, repoId))
    .execute();
}

/** The backfill ran: clear the stamp. */
export async function clearCiHistoryPending(repoId: number): Promise<void> {
  await db
    .update(syncState)
    .set({ ciHistoryPendingAt: null })
    .where(eq(syncState.repoId, repoId))
    .execute();
}

/** Is this repo still owed the CI-history backfill? */
export async function isCiHistoryPending(repoId: number): Promise<boolean> {
  const rows = await db
    .select({ at: syncState.ciHistoryPendingAt })
    .from(syncState)
    .where(and(eq(syncState.repoId, repoId), isNotNull(syncState.ciHistoryPendingAt)))
    .limit(1)
    .execute();
  return rows.length > 0;
}

/** Every repo still owed the backfill (the boot recovery reads this). */
export async function listCiHistoryPendingRepoIds(): Promise<number[]> {
  const rows = await db
    .select({ repoId: syncState.repoId })
    .from(syncState)
    .where(isNotNull(syncState.ciHistoryPendingAt))
    .execute();
  return rows.map((r) => r.repoId);
}
