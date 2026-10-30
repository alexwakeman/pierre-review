import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { WorktreeOwner } from './worktree-owner.js';

// THE WORKTREE LEDGER's writes (docs/BACKEND.md § Worktree cleanup; table `worktree_ledger`,
// migration 0146). clone-manager.ts calls these LAZILY (a dynamic import) so the git helpers stay
// importable without opening the database.
//
// ⚠ EVERY WRITE HERE IS BEST-EFFORT. A ledger row is bookkeeping for the sweep; a failed write must
// never fail the run that made the checkout. A tree with no row is an orphan the sweep collects by age.

/** This process's boot token: a pid is reused across restarts, this is not. */
export const PROCESS_INSTANCE = randomUUID();

export async function recordWorktreeCreated(args: {
  path: string;
  cloneDir: string;
  owner: string;
  name: string;
  headSha: string;
  ownerInfo: WorktreeOwner | null;
}): Promise<void> {
  const now = new Date();
  const o = args.ownerInfo;
  const values = {
    accountId: o?.accountId ?? null,
    path: args.path,
    cloneDir: args.cloneDir,
    owner: args.owner,
    name: args.name,
    kind: o?.kind ?? 'other',
    prId: o?.prId ?? null,
    ticket: o?.ticket ?? null,
    runId: o?.runId ?? null,
    headSha: args.headSha,
    pid: process.pid,
    instance: PROCESS_INSTANCE,
    pinReason: 'running',
    createdAt: now,
    lastUsedAt: now,
  };
  try {
    // The path is unique per run (`<sha>-<pid>-<n>`), so a conflict is a recycled pid reaching the
    // same counter after a restart: the old row describes a tree that is gone — overwrite it whole.
    await db
      .insert(schema.worktreeLedger)
      .values(values)
      .onConflictDoUpdate({
        target: schema.worktreeLedger.path,
        set: { ...values, releasedAt: null, removedAt: null, removeReason: null, bytesReclaimed: null },
      })
      .execute();
  } catch {
    /* bookkeeping only */
  }
}

/**
 * The run let go of its checkout. `removed` = its own `git worktree remove` (or the rm fallback)
 * took the directory; otherwise the row stays open with `releasedAt` for the sweep to finish.
 */
export async function recordWorktreeReleased(path: string, removed: boolean): Promise<void> {
  const now = new Date();
  try {
    await db
      .update(schema.worktreeLedger)
      .set(
        removed
          ? { pinReason: null, releasedAt: now, lastUsedAt: now, removedAt: now, removeReason: 'run_finished' }
          : { pinReason: null, releasedAt: now, lastUsedAt: now },
      )
      .where(eq(schema.worktreeLedger.path, path))
      .execute();
  } catch {
    /* bookkeeping only */
  }
}
