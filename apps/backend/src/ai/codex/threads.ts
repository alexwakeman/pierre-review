// CODEX'S OWN RECORD OF A RUN, IN LIMN'S CODEX HOME — and how Limn removes it. Codex 0.164 keeps every
// thread TWICE: the rollout file (`sessions/…/rollout-<time>-<threadId>.jsonl`, ai/codex/rollouts.ts)
// AND rows in its own sqlite state in the home — `state_<n>.sqlite` (`threads`: the first user message,
// the cwd, the title…), `thread_history_<n>.sqlite` (`thread_turns`, `thread_items`: the turns
// themselves) and `logs_<n>.sqlite` (`logs`, keyed by `thread_id`). Every one holds pull-request text.
//
// ONE PER-HOME QUEUE, drained serially in the background (docs/CODEX-PLAN.md, review fixes round 3):
//   • `queueCodexThreadCleanup(home, threadId)` — after a run SETTLES and its usage is RECORDED (never
//     before: the cleanup is an app-server start, up to THREAD_CLEANUP_TIMEOUT_MS, and must not sit on
//     the run's path or cost the ledger row if Limn dies meanwhile). Returns at once.
//   • A drain takes EVERY pending id (and the sweep, when one is due) and uses ONE app-server for all
//     of them: `thread/delete` (its `threads` row, its history rows and its rollout file — measured on
//     0.164), then the rollout file again, then the thread's `logs` rows (`thread/delete` leaves those;
//     Limn deletes them by `thread_id` with better-sqlite3 under a short busy timeout).
//   • A `thread/delete` that fails keeps its id (and its rollout file, which the retry needs) pending
//     for the NEXT drain — the next settled run or the next sweep; after MAX_DELETE_ATTEMPTS the file
//     and the log rows go anyway and the row is left to the day-old sweep.
//   • `armCodexThreadSweeps(home)` — the sweep now and then every SWEEP_INTERVAL_MS (a quarter of a
//     day) while Limn runs: every thread last updated over a day ago (a run cut off by a crash or a
//     killed Limn) through `thread/list` + `thread/delete`, every rollout file and `logs` row over a day.
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
/** One drain's whole budget (spawn + the deletes), without the sweep. */
export const THREAD_CLEANUP_TIMEOUT_MS = 20_000;
/** A drain that includes the sweep gets this long. */
const SWEEP_DRAIN_TIMEOUT_MS = 60_000;
/** Codex's logs databases: `logs_<n>.sqlite`. */
const LOGS_DB = /^logs_\d+\.sqlite$/;
/** At most this many pages of `thread/list` per sweep (a page is 100). */
const MAX_SWEEP_PAGES = 20;
/** Attempts at `thread/delete` before an id is left to the day-old sweep. */
export const MAX_DELETE_ATTEMPTS = 3;
/** The periodic sweep's interval: a quarter of the age it removes. */
export const SWEEP_INTERVAL_MS = Math.floor(ROLLOUT_MAX_AGE_MS / 4);

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

// ---- the per-home queue ---------------------------------------------------------------------------

interface HomeQueue {
  /** Thread id → failed `thread/delete` attempts so far. */
  pending: Map<string, number>;
  /** A sweep is due on the next drain. */
  sweep: boolean;
  /** The drain in progress, if any. */
  running: Promise<void> | null;
  /** Work arrived while a drain ran: drain once more after it. */
  again: boolean;
  /** Threads the last sweep deleted (the tests). */
  lastSweepDeleted: number;
}

type SpawnResolver = () => AppServerSpawnOptions | null;
let resolveSpawn: SpawnResolver = () => limnAppServerOptions();
let now: () => number = Date.now;
const queues = new Map<string, HomeQueue>();

function queueFor(home: string): HomeQueue {
  let q = queues.get(home);
  if (!q) queues.set(home, (q = { pending: new Map(), sweep: false, running: null, again: false, lastSweepDeleted: 0 }));
  return q;
}

/** One drain: ONE app-server for every pending id (and the sweep, when due), then files and logs. */
async function drainOnce(home: string, q: HomeQueue): Promise<void> {
  const ids = [...q.pending.keys()];
  const sweep = q.sweep;
  q.sweep = false;
  if (ids.length === 0 && !sweep) return;
  const nowMs = now();
  const cutoffMs = nowMs - ROLLOUT_MAX_AGE_MS;
  const deleted = new Set<string>();
  let swept = 0;
  const spawnOpts = resolveSpawn();
  if (spawnOpts) {
    try {
      await withCodexAppServer(
        async (s) => {
          for (const threadId of ids) {
            try {
              await s.request('thread/delete', { threadId });
              deleted.add(threadId);
            } catch {
              /* refused: retried on the next drain */
            }
          }
          if (!sweep) return;
          for (const threadId of await oldThreads(s, cutoffMs)) {
            if (deleted.has(threadId)) continue;
            try {
              await s.request('thread/delete', { threadId });
              swept++;
            } catch {
              /* the next sweep tries again */
            }
          }
        },
        spawnOpts,
        sweep ? SWEEP_DRAIN_TIMEOUT_MS : THREAD_CLEANUP_TIMEOUT_MS,
      );
    } catch {
      /* the app-server could not start, or timed out: the undeleted ids stay pending */
    }
  }
  for (const threadId of ids) {
    const attempts = (q.pending.get(threadId) ?? 0) + 1;
    // No Codex program (spawnOpts null) ⇒ nothing will ever delete the row: no retry.
    if (deleted.has(threadId) || !spawnOpts || attempts >= MAX_DELETE_ATTEMPTS) {
      q.pending.delete(threadId);
      deleteThreadRollouts(home, threadId);
    } else {
      q.pending.set(threadId, attempts); // its rollout stays for the retry's `thread/delete`
    }
    // The log rows go every time (`thread/delete` never reaches them).
    await purgeCodexLogs(home, { threadId });
  }
  if (sweep) {
    q.lastSweepDeleted = swept;
    sweepOldRollouts(home, ROLLOUT_MAX_AGE_MS, nowMs);
    await purgeCodexLogs(home, { olderThanMs: cutoffMs });
  }
}

/** Start a drain, or mark one more as needed. Never rejects. */
function kick(home: string): Promise<void> {
  const q = queueFor(home);
  if (q.running) {
    q.again = true;
    return q.running;
  }
  q.running = (async () => {
    // One turn of the event loop first, so ids settled together share the drain.
    await new Promise<void>((r) => setImmediate(r));
    try {
      do {
        q.again = false;
        try {
          await drainOnce(home, q);
        } catch {
          /* best effort */
        }
      } while (q.again);
    } finally {
      q.running = null;
    }
  })();
  return q.running;
}

/**
 * Queue one SETTLED run's thread for removal from Limn's Codex home — its rows (`thread/delete`), its
 * rollout file, its log rows — and start a drain in the background. Returns at once; never throws.
 */
export function queueCodexThreadCleanup(home: string, threadId: string | null | undefined): void {
  if (!threadId || !THREAD_ID.test(threadId)) return;
  const q = queueFor(home);
  if (!q.pending.has(threadId)) q.pending.set(threadId, 0);
  void kick(home);
}

/** Wait until the home's queue is idle (the live test, the tests). Never rejects. */
export async function drainCodexThreadCleanup(home: string): Promise<void> {
  const q = queueFor(home);
  while (q.running) await q.running;
}

/** Ids still waiting for a `thread/delete` (the tests). */
export function pendingCodexThreadIds(home: string): string[] {
  return [...queueFor(home).pending.keys()];
}

/**
 * Sweep now, on the SAME queue — so it shares a drain (and its app-server) with any pending ids, which
 * it retries. Resolves with how many old threads Codex deleted; never rejects.
 */
export async function sweepOldCodexThreads(home: string): Promise<number> {
  const q = queueFor(home);
  q.sweep = true;
  q.lastSweepDeleted = 0;
  await kick(home);
  await drainCodexThreadCleanup(home);
  return q.lastSweepDeleted;
}

const armed = new Map<string, NodeJS.Timeout | null>();
/**
 * The sweep now and then every SWEEP_INTERVAL_MS while Limn runs (the provider arms it before a run;
 * arming again is a no-op). The timer never keeps the process alive.
 */
export function armCodexThreadSweeps(home: string): void {
  if (armed.has(home)) return;
  armed.set(home, null);
  const tick = (): void => {
    void sweepOldCodexThreads(home);
    const t = setTimeout(tick, SWEEP_INTERVAL_MS);
    t.unref?.();
    armed.set(home, t);
  };
  tick();
}

/** Test hooks: the app-server and the clock; `null` restores the real ones and clears every queue. */
export function _setCodexCleanupForTest(opts: { spawn?: SpawnResolver; now?: () => number } | null): void {
  if (opts === null) {
    resolveSpawn = () => limnAppServerOptions();
    now = Date.now;
    for (const t of armed.values()) if (t) clearTimeout(t);
    armed.clear();
    queues.clear();
    return;
  }
  if (opts.spawn) resolveSpawn = opts.spawn;
  if (opts.now) now = opts.now;
}
