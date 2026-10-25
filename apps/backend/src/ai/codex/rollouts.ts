// CODEX'S SESSION FILES ("rollouts") IN LIMN'S OWN CODEX HOME. A run is NOT ephemeral — the one
// validation retry is `exec resume`, which needs the thread's rollout on disk (CODEX-SPIKE.md § 3) —
// so every run leaves `<home>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl` behind, holding
// the prompt, the pull request's text, file contents and diffs. Those must not pile up for ever:
//
//   • `deleteThreadRollouts(home, threadId)` — after a run SETTLES (its retry included), its own
//     files go. The provider calls it for every run that reported a thread id, success or not.
//   • `sweepOldRollouts(home, maxAgeMs)` — anything older than a day (a run cut off by a crash, a
//     killed Limn): once per process, before the first run.
//   • `removeAllRollouts(home)` — account erasure (Codex is local-only, so the home has ONE account).
//
// Only `sessions/` and `archived_sessions/` are touched; the sign-in (auth.json) and config.toml never.
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
