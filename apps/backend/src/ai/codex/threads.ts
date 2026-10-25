// CODEX'S OWN RECORD OF A RUN, IN LIMN'S CODEX HOME — and how Limn removes it. Codex 0.164 keeps every
// thread TWICE: the rollout file (`sessions/…/rollout-<time>-<threadId>.jsonl`, ai/codex/rollouts.ts)
// AND rows in its own sqlite state in the home — `state_<n>.sqlite` (`threads`: the first user message,
// the cwd, the title…), `thread_history_<n>.sqlite` (`thread_turns`, `thread_items`: the turns
// themselves) and `logs_<n>.sqlite` (`logs`, keyed by `thread_id`). Every one holds pull-request text.
//
//   • `forgetCodexThread(home, threadId)` — after a run SETTLES: the app-server's own `thread/delete`
//     (it removes the thread's `threads` row, its history rows and its rollout file — measured on 0.164),
//     then the rollout file again (in case the app-server could not start), then the thread's `logs`
//     rows (`thread/delete` leaves those; Limn deletes them by `thread_id` with better-sqlite3, the
//     backend's own driver, under a short busy timeout).
//   • `sweepOldCodexThreads(home)` — once per process, in the background: every thread whose last
//     update is older than a day (a run cut off by a crash or a killed Limn) goes the same way, through
//     `thread/list` + `thread/delete`, and every `logs` row older than a day goes too.
//   • Erasure removes the sqlite FILES themselves (rollouts.ts `eraseCodexHistory`).
//
// Rows are deleted through Codex's own API wherever one exists, never by writing Codex's tables
// directly — except `logs`, which no API reaches. Everything here is best-effort and never throws: a
// cleanup failure must not fail the run it follows.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { limnAppServerOptions, withCodexAppServer, type AppServerSpawnOptions, type CodexAppServer } from './app-server.js';
import { deleteThreadRollouts, ROLLOUT_MAX_AGE_MS, sweepOldRollouts } from './rollouts.js';

/** A thread id is a UUID; anything else is never sent anywhere. */
const THREAD_ID = /^[0-9a-zA-Z][0-9a-zA-Z-]{0,127}$/;
/** Every source kind `thread/list` knows (it defaults to the INTERACTIVE ones, which `exec` is not). */
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
/** One cleanup's whole budget (spawn + the deletes). */
export const THREAD_CLEANUP_TIMEOUT_MS = 20_000;
/** Codex's logs databases: `logs_<n>.sqlite`. */
const LOGS_DB = /^logs_\d+\.sqlite$/;
/** At most this many pages of `thread/list` per sweep (a page is 100). */
const MAX_SWEEP_PAGES = 20;

/** `thread/delete` each id on one app-server. Returns how many Codex accepted. */
async function deleteOn(server: CodexAppServer, ids: readonly string[]): Promise<number> {
  let n = 0;
  for (const threadId of ids) {
    try {
      await server.request('thread/delete', { threadId });
      n++;
    } catch {
      /* gone already, or refused: the files and logs are still cleaned */
    }
  }
  return n;
}

/**
 * Delete rows from every `logs_<n>.sqlite` in the home: those of one thread (`threadId`), and/or every
 * row older than `olderThanMs` (`ts` is Unix seconds). Returns how many rows went.
 */
export async function purgeCodexLogs(home: string, opts: { threadId?: string | null; olderThanMs?: number | null }): Promise<number> {
  const threadId = opts.threadId && THREAD_ID.test(opts.threadId) ? opts.threadId : null;
  const olderThanSec = opts.olderThanMs != null && Number.isFinite(opts.olderThanMs) ? Math.floor(opts.olderThanMs / 1000) : null;
  if (threadId == null && olderThanSec == null) return 0;
  let files: string[];
  try {
    files = readdirSync(home).filter((f) => LOGS_DB.test(f));
  } catch {
    return 0;
  }
  if (files.length === 0) return 0;
  let Database: typeof import('better-sqlite3');
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    let db: import('better-sqlite3').Database | null = null;
    try {
      db = new Database(join(home, f), { fileMustExist: true, timeout: 2_000 });
      if (threadId != null) n += db.prepare('DELETE FROM logs WHERE thread_id = ?').run(threadId).changes;
      if (olderThanSec != null) n += db.prepare('DELETE FROM logs WHERE ts < ?').run(olderThanSec).changes;
    } catch {
      /* no such table, or busy past the timeout: best effort */
    } finally {
      try {
        db?.close();
      } catch {
        /* closed */
      }
    }
  }
  return n;
}

/**
 * Remove one SETTLED run's thread from Limn's Codex home: its rows (`thread/delete`), its rollout file,
 * its log rows. `server` is the app-server to use (a test seam); absent ⇒ one is started for this.
 */
export async function forgetCodexThread(
  home: string,
  threadId: string | null | undefined,
  opts: { spawn?: AppServerSpawnOptions | null; timeoutMs?: number } = {},
): Promise<void> {
  if (!threadId || !THREAD_ID.test(threadId)) return;
  const spawnOpts = opts.spawn === undefined ? limnAppServerOptions() : opts.spawn;
  if (spawnOpts) {
    try {
      await withCodexAppServer((s) => deleteOn(s, [threadId]), spawnOpts, opts.timeoutMs ?? THREAD_CLEANUP_TIMEOUT_MS);
    } catch {
      /* the app-server could not start: the file and the logs still go */
    }
  }
  deleteThreadRollouts(home, threadId);
  await purgeCodexLogs(home, { threadId });
}

interface ListedThread {
  id?: unknown;
  updatedAt?: unknown;
}

/** Every thread (archived or not) last updated before `cutoffMs`, by `thread/list`, oldest first. */
async function oldThreads(server: CodexAppServer, cutoffMs: number): Promise<string[]> {
  const out: string[] = [];
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
      const res = (await server.request('thread/list', {
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'asc',
        sourceKinds: SOURCE_KINDS,
        archived,
        ...(cursor ? { cursor } : {}),
      })) as { data?: ListedThread[]; nextCursor?: unknown } | null;
      const data = Array.isArray(res?.data) ? res!.data : [];
      let reachedNew = false;
      for (const t of data) {
        const updatedMs = typeof t.updatedAt === 'number' ? t.updatedAt * 1000 : null;
        if (updatedMs == null || updatedMs >= cutoffMs) {
          reachedNew = true;
          break;
        }
        if (typeof t.id === 'string' && THREAD_ID.test(t.id)) out.push(t.id);
      }
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
      if (reachedNew || !cursor) break;
    }
  }
  return out;
}

/**
 * Remove every thread older than `maxAgeMs` from Limn's Codex home (rows via the app-server, rollout
 * files, log rows). Returns how many threads Codex deleted.
 */
export async function sweepOldCodexThreads(
  home: string,
  opts: { maxAgeMs?: number; nowMs?: number; spawn?: AppServerSpawnOptions | null } = {},
): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? ROLLOUT_MAX_AGE_MS;
  const cutoffMs = (opts.nowMs ?? Date.now()) - maxAgeMs;
  let deleted = 0;
  const spawnOpts = opts.spawn === undefined ? limnAppServerOptions() : opts.spawn;
  if (spawnOpts) {
    try {
      deleted = await withCodexAppServer(async (s) => deleteOn(s, await oldThreads(s, cutoffMs)), spawnOpts, 60_000);
    } catch {
      /* best effort */
    }
  }
  sweepOldRollouts(home, maxAgeMs, opts.nowMs ?? Date.now());
  await purgeCodexLogs(home, { olderThanMs: cutoffMs });
  return deleted;
}

let swept: Promise<number> | null = null;
/** `sweepOldCodexThreads` once per process, in the background (the provider calls it before a run). */
export function sweepOldCodexThreadsOnce(home: string): void {
  if (swept) return;
  swept = sweepOldCodexThreads(home).catch(() => 0);
}
