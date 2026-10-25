// CODEX'S OWN THREAD ROWS (ai/codex/threads.ts), against a FAKE `codex app-server` (a node script that
// answers initialize, thread/list and thread/delete and logs every request) and a REAL logs database
// in Codex's 0.164 shape. What is pinned:
//   • a settled run's thread is deleted through Codex's own `thread/delete`, its rollout file goes, and
//     its `logs` rows go (nobody else's);
//   • the sweep lists EVERY source kind (exec runs are not "interactive"), archived or not, deletes only
//     threads last updated over a day ago, and drops log rows older than a day;
//   • with no app-server at all, the file and the logs still go.
//
//   pnpm --filter @pierre-review/backend test ai/codex/threads
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServerSpawnOptions } from './app-server.js';
import { forgetCodexThread, purgeCodexLogs, sweepOldCodexThreads } from './threads.js';

const A = '01a173fb-6094-7113-bd54-691bb6d13631';
const B = '01a173fb-5228-7eb1-a959-e20bd3414337';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;

let home = '';
let log = '';
let fake = '';

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
const requests = (): Array<{ method: string; params: Record<string, unknown> }> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const spawnOpts = (): AppServerSpawnOptions => ({ binary: fake, env: { PATH: process.env.PATH ?? '' }, cwd: home });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'limn-codex-threads-'));
  log = join(home, '..', `${home.split('/').pop()}-requests.jsonl`);
  fake = join(home, '..', `${home.split('/').pop()}-fake-codex.mjs`);
  // thread/list answers two threads: A updated 2 days ago (archived or not), B an hour ago.
  writeFileSync(
    fake,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
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
  out({ id: m.id, result: {} });
});
`,
  );
  chmodSync(fake, 0o755);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(log, { force: true });
  rmSync(fake, { force: true });
});

describe('forgetCodexThread', () => {
  it('deletes the thread through thread/delete, its rollout file and its log rows — nobody else’s', async () => {
    const day = join(home, 'sessions', '2026', '10', '25');
    mkdirSync(day, { recursive: true });
    const mine = join(day, `rollout-2026-10-25T10-00-00-${A}.jsonl`);
    const other = join(day, `rollout-2026-10-25T10-00-00-${B}.jsonl`);
    writeFileSync(mine, '{}');
    writeFileSync(other, '{}');
    logsDb([{ thread: A, ts: NOW }, { thread: B, ts: NOW }, { thread: null, ts: NOW }, { thread: A, ts: NOW }]);
    await forgetCodexThread(home, A, { spawn: spawnOpts() });
    expect(requests()).toEqual([{ method: 'thread/delete', params: { threadId: A } }]);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(logThreads()).toEqual([B, null]);
  });

  it('with no app-server (Codex not installed), the file and the logs still go; a bad id touches nothing', async () => {
    logsDb([{ thread: A, ts: NOW }, { thread: B, ts: NOW }]);
    await forgetCodexThread(home, A, { spawn: null });
    expect(logThreads()).toEqual([B]);
    await forgetCodexThread(home, "x' OR 1=1 --", { spawn: spawnOpts() });
    await forgetCodexThread(home, null, { spawn: spawnOpts() });
    expect(requests()).toEqual([]);
    expect(logThreads()).toEqual([B]);
  });
});

describe('sweepOldCodexThreads', () => {
  it('lists every source kind, archived and not, deletes only threads older than a day, and old log rows', async () => {
    logsDb([{ thread: A, ts: NOW - 2 * DAY }, { thread: null, ts: NOW - 3 * DAY }, { thread: B, ts: NOW - 60_000 }]);
    expect(await sweepOldCodexThreads(home, { nowMs: NOW, spawn: spawnOpts() })).toBe(1);
    const reqs = requests();
    const lists = reqs.filter((r) => r.method === 'thread/list');
    expect(lists.map((r) => r.params.archived)).toEqual([false, true]);
    expect(lists[0]!.params.sourceKinds).toContain('exec');
    expect(lists[0]!.params).toMatchObject({ sortKey: 'updated_at', sortDirection: 'asc' });
    expect(reqs.filter((r) => r.method === 'thread/delete')).toEqual([{ method: 'thread/delete', params: { threadId: A } }]);
    expect(logThreads()).toEqual([B]);
  });

  it('purgeCodexLogs with nothing to match deletes nothing, and a home without logs is fine', async () => {
    expect(await purgeCodexLogs(home, {})).toBe(0);
    expect(await purgeCodexLogs(join(home, 'missing'), { threadId: A })).toBe(0);
  });
});
