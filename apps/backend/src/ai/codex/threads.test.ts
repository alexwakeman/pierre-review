// CODEX'S OWN THREAD ROWS (ai/codex/threads.ts), against a FAKE `codex app-server` (a node script that
// answers initialize, thread/list and thread/delete, logs every start and request, and refuses a
// `thread/delete` for any id listed in a "refuse" file) and a REAL logs database in Codex's 0.164 shape.
// What is pinned:
//   • a settled run's thread is QUEUED and deleted in the background through Codex's own
//     `thread/delete`, its rollout file goes, and its `logs` rows go (nobody else's);
//   • ids queued together share ONE app-server start (a batch per drain);
//   • a refused `thread/delete` keeps its id — and its rollout file — for the NEXT drain, which retries
//     it; after MAX_DELETE_ATTEMPTS the file goes anyway;
//   • with no app-server at all, the file and the logs still go and nothing is retried;
//   • the sweep lists EVERY source kind (exec runs are not "interactive"), archived or not, deletes only
//     threads last updated over a day ago, drops log rows older than a day, and shares a drain with
//     pending ids; armed, it runs again every SWEEP_INTERVAL_MS.
//
//   pnpm --filter @pierre-review/backend test ai/codex/threads
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServerSpawnOptions } from './app-server.js';
import {
  _setCodexCleanupForTest,
  armCodexThreadSweeps,
  drainCodexThreadCleanup,
  MAX_DELETE_ATTEMPTS,
  pendingCodexThreadIds,
  purgeCodexLogs,
  queueCodexThreadCleanup,
  sweepOldCodexThreads,
  SWEEP_INTERVAL_MS,
} from './threads.js';

const A = '01a173fb-6094-7113-bd54-691bb6d13631';
const B = '01a173fb-5228-7eb1-a959-e20bd3414337';
const C = '01a173fb-0000-7eb1-a959-e20bd3414337';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;

let home = '';
let log = '';
let fake = '';
let refuse = '';

function logsDb(rows: Array<{ thread: string | null; ts: number }>): string {
  const f = join(home, 'logs_2.sqlite');
  const db = new Database(f);
  db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0)',
  );
  const ins = db.prepare("INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id) VALUES (?, 0, 'INFO', 't', 'the PR text', ?)");
  for (const r of rows) ins.run(Math.floor(r.ts / 1000), r.thread);
  db.close();
  return f;
}
const logThreads = (): Array<string | null> => {
  const db = new Database(join(home, 'logs_2.sqlite'), { readonly: true });
  try {
    return (db.prepare('SELECT thread_id AS t FROM logs ORDER BY id').all() as Array<{ t: string | null }>).map((r) => r.t);
  } finally {
    db.close();
  }
};
const entries = (): Array<{ method: string; params?: Record<string, unknown> }> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const requests = () => entries().filter((e) => e.method !== 'START');
const starts = (): number => entries().filter((e) => e.method === 'START').length;
const deletes = (): string[] => requests().filter((r) => r.method === 'thread/delete').map((r) => String(r.params?.threadId));
const spawnOpts = (): AppServerSpawnOptions => ({ binary: fake, env: { PATH: process.env.PATH ?? '' }, cwd: home });
const rollout = (id: string): string => {
  const day = join(home, 'sessions', '2026', '10', '25');
  mkdirSync(day, { recursive: true });
  const f = join(day, `rollout-2026-10-25T10-00-00-${id}.jsonl`);
  writeFileSync(f, '{}');
  return f;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'limn-codex-threads-'));
  const base = join(home, '..', home.split('/').pop()!);
  log = `${base}-requests.jsonl`;
  fake = `${base}-fake-codex.mjs`;
  refuse = `${base}-refuse.txt`;
  // thread/list answers two threads: A updated 2 days ago (not archived), B an hour ago.
  writeFileSync(
    fake,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: 'START' }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method !== 'initialize') appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: m.method, params: m.params }) + '\\n');
  if (m.method === 'thread/list') {
    const data = m.params.archived ? [] : [
      { id: ${JSON.stringify(A)}, updatedAt: ${Math.floor((NOW - 2 * DAY) / 1000)} },
      { id: ${JSON.stringify(B)}, updatedAt: ${Math.floor((NOW - 60 * 60_000) / 1000)} },
    ];
    return out({ id: m.id, result: { data, nextCursor: null } });
  }
  if (m.method === 'thread/delete' && existsSync(${JSON.stringify(refuse)}) && readFileSync(${JSON.stringify(refuse)}, 'utf8').includes(m.params.threadId)) {
    return out({ id: m.id, error: { code: -32600, message: 'refused' } });
  }
  out({ id: m.id, result: {} });
});
`,
  );
  chmodSync(fake, 0o755);
  _setCodexCleanupForTest({ spawn: spawnOpts, now: () => NOW });
});
afterEach(async () => {
  await drainCodexThreadCleanup(home);
  _setCodexCleanupForTest(null);
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
  for (const f of [log, fake, refuse]) rmSync(f, { force: true });
});

describe('the cleanup queue', () => {
  it('queues a settled thread and deletes it in the background: thread/delete, its rollout, its log rows — nobody else’s', async () => {
    const mine = rollout(A);
    const other = rollout(B);
    logsDb([{ thread: A, ts: NOW }, { thread: B, ts: NOW }, { thread: null, ts: NOW }, { thread: A, ts: NOW }]);
    queueCodexThreadCleanup(home, A); // returns at once
    await drainCodexThreadCleanup(home);
    expect(requests()).toEqual([{ method: 'thread/delete', params: { threadId: A } }]);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(logThreads()).toEqual([B, null]);
    expect(pendingCodexThreadIds(home)).toEqual([]);
  });

  it('BATCHES: ids queued together share ONE app-server start', async () => {
    queueCodexThreadCleanup(home, A);
    queueCodexThreadCleanup(home, B);
    queueCodexThreadCleanup(home, C);
    await drainCodexThreadCleanup(home);
    expect(starts()).toBe(1);
    expect(deletes().sort()).toEqual([A, B, C].sort());
  });

  it('a refused thread/delete stays pending (its rollout kept for the retry) and the NEXT drain retries it', async () => {
    writeFileSync(refuse, A);
    const fileA = rollout(A);
    queueCodexThreadCleanup(home, A);
    await drainCodexThreadCleanup(home);
    expect(pendingCodexThreadIds(home)).toEqual([A]);
    expect(existsSync(fileA)).toBe(true);
    // Codex accepts it now: the next settled run's drain takes both, on ONE app-server.
    rmSync(refuse);
    const before = starts();
    queueCodexThreadCleanup(home, B);
    await drainCodexThreadCleanup(home);
    expect(starts() - before).toBe(1);
    expect(deletes()).toEqual([A, A, B]);
    expect(pendingCodexThreadIds(home)).toEqual([]);
    expect(existsSync(fileA)).toBe(false);
  });

  it(`gives up after ${MAX_DELETE_ATTEMPTS} refusals: the file goes, the row is left to the sweep`, async () => {
    writeFileSync(refuse, A);
    const fileA = rollout(A);
    for (let i = 0; i < MAX_DELETE_ATTEMPTS; i++) {
      queueCodexThreadCleanup(home, A);
      await drainCodexThreadCleanup(home);
    }
    expect(deletes()).toEqual(Array(MAX_DELETE_ATTEMPTS).fill(A));
    expect(pendingCodexThreadIds(home)).toEqual([]);
    expect(existsSync(fileA)).toBe(false);
  });

  it('with no app-server (Codex not installed), the file and the logs still go and nothing is retried; a bad id touches nothing', async () => {
    _setCodexCleanupForTest({ spawn: () => null });
    const fileA = rollout(A);
    logsDb([{ thread: A, ts: NOW }, { thread: B, ts: NOW }]);
    queueCodexThreadCleanup(home, A);
    await drainCodexThreadCleanup(home);
    expect(existsSync(fileA)).toBe(false);
    expect(logThreads()).toEqual([B]);
    expect(pendingCodexThreadIds(home)).toEqual([]);
    _setCodexCleanupForTest({ spawn: spawnOpts });
    queueCodexThreadCleanup(home, "x' OR 1=1 --");
    queueCodexThreadCleanup(home, null);
    await drainCodexThreadCleanup(home);
    expect(entries()).toEqual([]);
    expect(logThreads()).toEqual([B]);
  });
});

describe('the sweep', () => {
  it('lists every source kind, archived and not, deletes only threads older than a day, and old log rows', async () => {
    logsDb([{ thread: A, ts: NOW - 2 * DAY }, { thread: null, ts: NOW - 3 * DAY }, { thread: B, ts: NOW - 60_000 }]);
    expect(await sweepOldCodexThreads(home)).toBe(1);
    const reqs = requests();
    const lists = reqs.filter((r) => r.method === 'thread/list');
    expect(lists.map((r) => r.params!.archived)).toEqual([false, true]);
    expect(lists[0]!.params!.sourceKinds).toContain('exec');
    expect(lists[0]!.params).toMatchObject({ sortKey: 'updated_at', sortDirection: 'asc' });
    expect(deletes()).toEqual([A]);
    expect(logThreads()).toEqual([B]);
  });

  it('shares a drain with a pending id, and retries it', async () => {
    writeFileSync(refuse, C);
    queueCodexThreadCleanup(home, C);
    await drainCodexThreadCleanup(home);
    rmSync(refuse);
    const before = starts();
    await sweepOldCodexThreads(home);
    expect(starts() - before).toBe(1);
    expect(deletes()).toEqual([C, C, A]);
    expect(pendingCodexThreadIds(home)).toEqual([]);
  });

  it(`armed, it runs now and again every ${SWEEP_INTERVAL_MS / 3_600_000} hours (arming twice is a no-op)`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listCount = (): number => requests().filter((r) => r.method === 'thread/list').length;
    armCodexThreadSweeps(home);
    armCodexThreadSweeps(home);
    // The drain starts synchronously (vi.waitFor is not used: under fake timers it advances them).
    await drainCodexThreadCleanup(home);
    expect(listCount()).toBe(2);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS - 1);
    await drainCodexThreadCleanup(home);
    expect(listCount()).toBe(2);
    vi.advanceTimersByTime(1);
    await drainCodexThreadCleanup(home);
    expect(listCount()).toBe(4);
  });

  it('purgeCodexLogs with nothing to match deletes nothing, and a home without logs is fine', async () => {
    expect(await purgeCodexLogs(home, {})).toBe(0);
    expect(await purgeCodexLogs(join(home, 'missing'), { threadId: A })).toBe(0);
  });
});
