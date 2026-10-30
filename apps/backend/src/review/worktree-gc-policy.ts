// THE WORKTREE SWEEP'S POLICY — pure, so every rule is a test (worktree-gc-policy.test.ts).
// docs/BACKEND.md § Worktree cleanup. review/worktree-gc.ts gathers the facts and acts on the verdict.
//
// The order of the rules IS the policy. Read it top to bottom:
//   1. gone from disk               → forget (close the ledger row; nothing to remove)
//   2. a job in THIS process has it → keep   ("in use" — identity, never age: a long run touches
//                                             nothing under its tree for hours)
//   3. another Limn process that is still alive made it, and it is not idle → keep
//   4. it holds work the reader may still push → keep, until pushed/discarded or the long pin TTL
//   5. its PR is merged, closed or gone → remove
//   6. its run let go of it (the run's own removal failed) → remove
//   7. its run is over → remove
//   8. the process that made it has exited → remove (a crashed run; no job survives a restart)
//   9. idle past the TTL → remove
//  10. otherwise keep
//
// ⚠ Rules 2–4 come BEFORE every remove rule on purpose. A merged PR does not free a tree a running
// job is reading, and a closed PR does not discard a fix the reader has not pushed.

export type WorktreeVerdict =
  | { action: 'keep'; reason: WorktreeKeepReason }
  | { action: 'remove'; reason: WorktreeRemoveReason }
  | { action: 'forget'; reason: 'missing' };

export type WorktreeKeepReason = 'in_use' | 'other_process' | 'unpushed' | 'recent';

export type WorktreeRemoveReason =
  | 'pr_closed'
  | 'released'
  | 'run_finished'
  | 'owner_exited'
  | 'idle'
  | 'pin_expired'
  | 'orphan';

/** What the owning run's row says. 'unknown' when the kind has no row to read, or it is gone. */
export type RunState = 'running' | 'finished' | 'unknown';

/** Whether the tree holds a result the reader may still push. */
export type WorkState = 'unpushed' | 'pushed' | 'discarded' | 'none';

/** 'gone' = the PR row no longer exists (repo removed); null = the tree names no PR. */
export type PrState = 'open' | 'merged' | 'closed' | 'gone' | null;

export interface LedgeredFacts {
  exists: boolean;
  /** In this process's `liveWorktrees` — a job here is using it right now. */
  liveHere: boolean;
  /** Made by this process (same boot token). */
  ownedHere: boolean;
  /** The creating process is still running (always true when ownedHere). */
  ownerAlive: boolean;
  pinReason: string | null;
  releasedAt: number | null;
  runState: RunState;
  workState: WorkState;
  prState: PrState;
  createdAt: number;
  lastUsedAt: number;
}

export interface WorktreePolicy {
  /** A tree nothing names as needed is removed after this long untouched. */
  idleMs: number;
  /** A tree holding unpushed work is kept at most this long after it was last used. */
  pinMaxMs: number;
}

export function decideLedgered(f: LedgeredFacts, now: number, p: WorktreePolicy): WorktreeVerdict {
  if (!f.exists) return { action: 'forget', reason: 'missing' };
  if (f.liveHere) return { action: 'keep', reason: 'in_use' };
  const idle = now - f.lastUsedAt;
  if (!f.ownedHere && f.ownerAlive && idle < p.idleMs) return { action: 'keep', reason: 'other_process' };
  const unpushed = f.workState === 'unpushed' || (f.pinReason === 'unpushed' && f.workState === 'none');
  if (unpushed) {
    return idle < p.pinMaxMs ? { action: 'keep', reason: 'unpushed' } : { action: 'remove', reason: 'pin_expired' };
  }
  if (f.prState === 'merged' || f.prState === 'closed' || f.prState === 'gone') return { action: 'remove', reason: 'pr_closed' };
  if (f.releasedAt != null) return { action: 'remove', reason: 'released' };
  if (f.runState === 'finished' || f.workState === 'pushed' || f.workState === 'discarded') {
    return { action: 'remove', reason: 'run_finished' };
  }
  // Made here and no job here holds it: its run let go without the ledger hearing (rule 2 failed).
  if (f.ownedHere) return { action: 'remove', reason: 'released' };
  if (!f.ownerAlive) return { action: 'remove', reason: 'owner_exited' };
  if (idle >= p.idleMs) return { action: 'remove', reason: 'idle' };
  return { action: 'keep', reason: 'recent' };
}

export interface OrphanFacts {
  /** In this process's `liveWorktrees`. */
  liveHere: boolean;
  /** The directory's own mtime — all an unledgered tree has. */
  mtimeMs: number;
}

/**
 * A directory under `.worktrees/` with NO ledger row: made by a build before the ledger, or its row
 * write failed. Nothing names an owner, so only age speaks — the same TTL the boot sweep used before
 * the ledger (`config.worktreeTtlMs`).
 */
export function decideOrphan(f: OrphanFacts, now: number, orphanTtlMs: number): WorktreeVerdict {
  if (f.liveHere) return { action: 'keep', reason: 'in_use' };
  if (now - f.mtimeMs < orphanTtlMs) return { action: 'keep', reason: 'recent' };
  return { action: 'remove', reason: 'orphan' };
}

/** An ai_fixes row → the fix tree's run and work state. */
export function fixRowStates(row: { status: string; pushedAt: number | null; hasPatch: boolean } | null): {
  runState: RunState;
  workState: WorkState;
} {
  if (!row) return { runState: 'unknown', workState: 'none' };
  if (row.status === 'queued' || row.status === 'running') return { runState: 'running', workState: 'none' };
  if (row.pushedAt != null) return { runState: 'finished', workState: 'pushed' };
  if (row.status === 'succeeded' && row.hasPatch) return { runState: 'finished', workState: 'unpushed' };
  if (row.status === 'failed' || row.status === 'cancelled') return { runState: 'finished', workState: 'discarded' };
  return { runState: 'finished', workState: 'none' };
}

/**
 * A story build's repository row (`story_build_repos`, runId of a `story_build` tree) and its session's
 * status → the KEPT write worktree's run and work state (docs/STORY-BUILD.md § Worktree ledger):
 *   running   while the repository is `preparing | building | checking`
 *   unpushed  `ready` with a stored patch and no push — kept for Retry / Re-run checks until pinMaxMs
 *   pushed    pushed (the patch is on GitHub; the tree is spent)
 *   discarded the session was discarded / cancelled, or the repository failed / was cancelled / skipped
 * The patch is stored after every pass, so removing a tree loses nothing: a later pass re-makes it.
 */
export function storyBuildRepoStates(
  row: { status: string; sessionStatus: string | null; hasPatch: boolean; pushedAt: number | null } | null,
): { runState: RunState; workState: WorkState } {
  if (!row) return { runState: 'unknown', workState: 'none' };
  if (row.status === 'preparing' || row.status === 'building' || row.status === 'checking') return { runState: 'running', workState: 'none' };
  if (row.sessionStatus === 'discarded' || row.sessionStatus === 'cancelled') return { runState: 'finished', workState: 'discarded' };
  if (row.status === 'pushed' || row.pushedAt != null) return { runState: 'finished', workState: 'pushed' };
  if (row.status === 'ready' && row.hasPatch) return { runState: 'finished', workState: 'unpushed' };
  if (row.status === 'failed' || row.status === 'cancelled' || row.status === 'skipped') return { runState: 'finished', workState: 'discarded' };
  // queued / planned: no pass is running in it right now.
  return { runState: 'finished', workState: 'none' };
}

/**
 * Is `path` a per-run checkout inside Limn's clone cache — exactly `<cloneDir>/<clone>/.worktrees/<entry>`?
 * The sweep removes NOTHING that fails this. Both sides must already be resolved (realpath).
 */
export function isCacheWorktreePath(path: string, cloneDir: string, sep = '/'): boolean {
  const root = cloneDir.endsWith(sep) ? cloneDir : cloneDir + sep;
  if (!path.startsWith(root)) return false;
  const parts = path.slice(root.length).split(sep);
  return (
    parts.length === 3 &&
    parts[1] === '.worktrees' &&
    parts.every((p) => p.length > 0 && p !== '.' && p !== '..')
  );
}
