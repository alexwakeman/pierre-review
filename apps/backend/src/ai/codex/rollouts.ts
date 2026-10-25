// CODEX'S SESSION FILES ("rollouts") IN LIMN'S OWN CODEX HOME. A run is NOT ephemeral — the one
// validation retry is `exec resume`, which needs the thread's rollout on disk (CODEX-SPIKE.md § 3) —
// so every run leaves `<home>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl` behind, holding
// the prompt, the pull request's text, file contents and diffs. Those must not pile up for ever:
//
//   • `deleteThreadRollouts(home, threadId)` — after a run SETTLES (its retry included), its own
//     files go. The provider calls it for every run that reported a thread id, success or not.
//   • `sweepOldRollouts(home, maxAgeMs)` — anything older than a day (a run cut off by a crash, a
//     killed Limn): once per process, before the first run.
//   • `removeAllRollouts(home)` — every rollout (Codex is local-only, so the home has ONE account).
//   • `eraseCodexHistory(home)` — ACCOUNT ERASURE: every rollout AND Codex's own sqlite state in the
//     home, which keeps a second copy of every thread (`state_<n>`, `thread_history_<n>`, `logs_<n>`,
//     `memories_<n>`, `goals_<n>`, `queue_<n>` .sqlite, each with its -wal/-shm). The per-run and aged
//     removal of a thread's ROWS is ai/codex/threads.ts (through Codex's own `thread/delete`).
//
// The sign-in (auth.json), config.toml and installation_id are NEVER touched.
// Every function is best-effort and never throws: a cleanup failure must not fail the run it follows.
import { readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROLLOUT_DIRS = ['sessions', 'archived_sessions'] as const;
/** The tree is YYYY/MM/DD (depth 3); a little slack, never an unbounded walk. */
const MAX_DEPTH = 5;
export const ROLLOUT_MAX_AGE_MS = 24 * 60 * 60_000;

/** A thread id is a UUID; anything else is never matched against file names (`rollout-<time>-<id>.jsonl`). */
const THREAD_ID = /^[0-9a-zA-Z][0-9a-zA-Z-]{0,127}$/;

function walk(dir: string, depth: number, visit: (file: string) => void): void {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, visit);
    else if (e.isFile()) visit(p);
  }
}

function unlinkQuiet(p: string): boolean {
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Delete one thread's rollout file(s). Returns how many went. */
export function deleteThreadRollouts(home: string, threadId: string | null | undefined): number {
  if (!threadId || !THREAD_ID.test(threadId)) return 0;
  let n = 0;
  for (const d of ROLLOUT_DIRS) {
    walk(join(home, d), 0, (f) => {
      const name = basename(f);
      if (name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`) && unlinkQuiet(f)) n++;
    });
  }
  return n;
}

/** Delete every rollout last written more than `maxAgeMs` ago. Returns how many went. */
export function sweepOldRollouts(home: string, maxAgeMs: number = ROLLOUT_MAX_AGE_MS, now: number = Date.now()): number {
  let n = 0;
  for (const d of ROLLOUT_DIRS) {
    walk(join(home, d), 0, (f) => {
      try {
        if (now - statSync(f).mtimeMs > maxAgeMs && unlinkQuiet(f)) n++;
      } catch {
        /* gone meanwhile */
      }
    });
  }
  return n;
}

let swept = false;
/** `sweepOldRollouts` once per process (the provider calls it before a run). */
export function sweepOldRolloutsOnce(home: string): void {
  if (swept) return;
  swept = true;
  sweepOldRollouts(home);
}

/** Erasure: every rollout in the home, the folders included. Never the sign-in or the config. */
export function removeAllRollouts(home: string): void {
  for (const d of ROLLOUT_DIRS) {
    try {
      rmSync(join(home, d), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Codex's own sqlite state files (with their WAL, shared-memory and journal files). */
export const CODEX_STATE_FILE = /^(state|thread_history|logs|memories|goals|queue)_\d+\.sqlite(-wal|-shm|-journal)?$/;
/** Folders of per-run leftovers, removed whole at erasure. */
const ERASE_DIRS = [...ROLLOUT_DIRS, 'shell_snapshots', 'thread-writer-locks'] as const;
/** Never erased: the sign-in, Limn's config, Codex's install id. */
const KEEP = new Set(['auth.json', 'config.toml', 'installation_id']);

/**
 * Account erasure: every rollout and every one of Codex's sqlite state files in Limn's Codex home.
 * Never the sign-in, config.toml or installation_id. Returns the names removed (for the test).
 */
export function eraseCodexHistory(home: string): string[] {
  const removed: string[] = [];
  for (const d of ERASE_DIRS) {
    try {
      rmSync(join(home, d), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (KEEP.has(name) || !CODEX_STATE_FILE.test(name)) continue;
    if (unlinkQuiet(join(home, name))) removed.push(name);
  }
  return removed;
}
