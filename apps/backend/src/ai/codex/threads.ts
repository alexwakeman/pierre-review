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
//   • ⚠ THE ROLLOUT FILE GOES IN THAT DRAIN WHATEVER `thread/delete` ANSWERS — it is the whole prompt
//     and every diff. Only the ID stays pending, for the ROW retry: measured on 0.164, `thread/delete`
//     does NOT need the file (with the rollout gone it still deleted the `threads` row and the history
//     rows, answering `{}`), and a thread already gone answers "no rollout found for thread id …",
//     which counts as DONE — so a delete that timed out but went through is fine.
//   • While ids are pending, a short unref'd timer drains again after 1, then 5, then 15 minutes
//     (DELETE_RETRY_DELAYS_MS); after MAX_DELETE_ATTEMPTS the id is dropped and the row is left to the
//     day-old sweep. Pending ids live in memory only: after a restart the boot sweep finds the rows.
//   • `armCodexThreadSweeps(home)` — the sweep now and then every SWEEP_INTERVAL_MS (a quarter of a
//     day) while Limn runs: every thread last updated over a day ago (a run cut off by a crash or a
//     killed Limn) through `thread/list` + `thread/delete`, every rollout file and `logs` row over a day.
//     Armed at BOOT when Limn's Codex home exists (`armCodexThreadSweepsAtBoot`), and before a run.
//   • FEWER APP-SERVERS: a drain whose app-server is up anyway also takes the account probe's reads when
//     one is due (app-server.ts `shareCodexProbe`), so the probe does not start a second process.
//   • Erasure removes the sqlite FILES themselves (rollouts.ts `eraseCodexHistory`).
//
// Rows are deleted through Codex's own API wherever one exists, never by writing Codex's tables
// directly — except `logs`, which no API reaches. Everything here is best-effort and never throws: a
// cleanup failure must not fail the run it follows.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { codexBinaryPath } from '../runtime.js';
import {
  APP_SERVER_PROBE_TIMEOUT_MS,
  limnAppServerOptions,
  shareCodexProbe,
  withCodexAppServer,
  type AppServerSpawnOptions,
  type CodexAppServer,
} from './app-server.js';
import { codexHome } from './home.js';
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
/** After a failed `thread/delete`, drain again after these delays (1, then 5, then 15 minutes). */
export const DELETE_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
/** Attempts at `thread/delete` before an id is left to the day-old sweep: the first + one per delay. */
export const MAX_DELETE_ATTEMPTS = DELETE_RETRY_DELAYS_MS.length + 1;
/** Codex 0.164's answer for a thread that is not there (no row and no rollout): already gone = done. */
const ALREADY_GONE = /no rollout found/i;
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
  /** The armed retry drain while ids are pending (unref'd). */
  retry: NodeJS.Timeout | null;
}

type SpawnResolver = () => AppServerSpawnOptions | null;
let resolveSpawn: SpawnResolver = () => limnAppServerOptions();
/** A drain takes the account probe's reads on its own app-server when one is due (off in the tests). */
let shareProbe = true;
let now: () => number = Date.now;
const queues = new Map<string, HomeQueue>();

function queueFor(home: string): HomeQueue {
  let q = queues.get(home);
  if (!q) queues.set(home, (q = { pending: new Map(), sweep: false, running: null, again: false, lastSweepDeleted: 0, retry: null }));
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
            } catch (err) {
              // Already gone (an earlier delete went through): done. Anything else: retried.
              if (ALREADY_GONE.test((err as Error).message)) deleted.add(threadId);
            }
          }
          if (sweep) {
            for (const threadId of await oldThreads(s, cutoffMs)) {
              if (deleted.has(threadId)) continue;
              try {
                await s.request('thread/delete', { threadId });
                swept++;
              } catch {
                /* the next sweep tries again */
              }
            }
          }
          // The process is up anyway: a DUE account probe reads on it instead of starting another.
          if (shareProbe) await shareCodexProbe(s);
        },
        spawnOpts,
        (sweep ? SWEEP_DRAIN_TIMEOUT_MS : THREAD_CLEANUP_TIMEOUT_MS) + (shareProbe ? APP_SERVER_PROBE_TIMEOUT_MS : 0),
      );
    } catch {
      /* the app-server could not start, or timed out: the undeleted ids stay pending */
    }
  }
  for (const threadId of ids) {
    const attempts = (q.pending.get(threadId) ?? 0) + 1;
    // ⚠ The rollout file goes EVERY time, whatever `thread/delete` answered (the row retry needs only
    // the id — see the header).
    deleteThreadRollouts(home, threadId);
    // No Codex program (spawnOpts null) ⇒ nothing will ever delete the row: no retry.
    if (deleted.has(threadId) || !spawnOpts || attempts >= MAX_DELETE_ATTEMPTS) q.pending.delete(threadId);
    else q.pending.set(threadId, attempts);
    // The log rows go every time (`thread/delete` never reaches them).
    await purgeCodexLogs(home, { threadId });
  }
  if (sweep) {
    q.lastSweepDeleted = swept;
    sweepOldRollouts(home, ROLLOUT_MAX_AGE_MS, nowMs);
    await purgeCodexLogs(home, { olderThanMs: cutoffMs });
  }
}

/**
 * While ids are pending, drain again after a short delay (1, then 5, then 15 minutes — by the most
 * attempts any pending id has had). Unref'd: it never keeps Limn alive. Cleared when nothing is pending.
 */
function armRetry(home: string, q: HomeQueue): void {
  if (q.retry) {
    clearTimeout(q.retry);
    q.retry = null;
  }
  if (q.pending.size === 0) return;
  const most = Math.max(...q.pending.values());
  const delay = DELETE_RETRY_DELAYS_MS[Math.min(Math.max(most, 1), DELETE_RETRY_DELAYS_MS.length) - 1]!;
  const t = setTimeout(() => {
    q.retry = null;
    void kick(home);
  }, delay);
  t.unref?.();
  q.retry = t;
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
      armRetry(home, q);
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

/**
 * AT BOOT: arm the sweep when Limn's Codex home EXISTS (and Codex is installed, and AI is on) — so a
 * row or rollout a previous process left behind (a crash, a kill, a pending retry lost with it) is
 * swept without waiting for the next Codex run. Nothing is created: no home, no sweep.
 */
export function armCodexThreadSweepsAtBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!config.aiEnabled) return false;
  const home = codexHome(env);
  if (!existsSync(home) || !codexBinaryPath()) return false;
  armCodexThreadSweeps(home);
  return true;
}

/** Test hooks: the app-server and the clock; `null` restores the real ones and clears every queue. */
export function _setCodexCleanupForTest(opts: { spawn?: SpawnResolver; now?: () => number; shareProbe?: boolean } | null): void {
  if (opts === null) {
    resolveSpawn = () => limnAppServerOptions();
    now = Date.now;
    shareProbe = true;
    for (const t of armed.values()) if (t) clearTimeout(t);
    armed.clear();
    for (const q of queues.values()) if (q.retry) clearTimeout(q.retry);
    queues.clear();
    return;
  }
  // A test's own app-server is not Limn's: it shares the probe only when asked to.
  if (opts.spawn) {
    resolveSpawn = opts.spawn;
    shareProbe = false;
  }
  if (opts.now) now = opts.now;
  if (opts.shareProbe !== undefined) shareProbe = opts.shareProbe;
}
