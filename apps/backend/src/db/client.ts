// The database client: better-sqlite3 (a synchronous engine) + the sqlite-core schema.
//
// The app talks to `db` through the async surface only (`await builder` / `.execute()` /
// `.returning().execute()` / runTransaction). Postgres support is gone; the query layer keeps
// that style because nothing gains from rewriting it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as sqliteSchema from './schema.sqlite.js';

export type Schema = typeof sqliteSchema;
export type DB = BetterSQLite3Database<Schema>;
// The executor a runTransaction callback receives (the db itself on sqlite).
export type Executor = DB;

// Owner-only on the DIRECTORY as well as the file: WAL mode creates two siblings
// (`-wal`, `-shm`) that hold the same data and are created by SQLite with the process
// umask, so locking down only the main file would leave the write-ahead log readable.
mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
const sqliteConn = new Database(config.dbPath);
sqliteConn.pragma('journal_mode = WAL');
sqliteConn.pragma('foreign_keys = ON');
// The local database holds every synced PR body, review comment and GitHub login the user
// can see — on a shared or multi-user machine the default 0644 made all of that readable by
// any other local account. 0600 it (and the WAL siblings, which the pragma above has just
// created). Best-effort: chmod is not meaningful on Windows, and a failure here must never
// stop the app from starting.
for (const suffix of ['', '-wal', '-shm']) {
  try {
    chmodSync(`${config.dbPath}${suffix}`, 0o600);
  } catch {
    /* missing sibling (non-WAL platform) or an unsupported filesystem — not fatal */
  }
}

export const db: DB = drizzle(sqliteConn, { schema: sqliteSchema });
// The raw better-sqlite3 handle, for DDL-only paths (platform/migrate.ts). Data queries go through `db`.
export const rawSqlite = sqliteConn;
export const schema: Schema = sqliteSchema;

// Close the underlying connection. Used by the one-shot migrate CLI; the long-running server
// never calls it.
export async function closeDb(): Promise<void> {
  sqliteConn.close();
}

// The one transaction entry. better-sqlite3 rejects async transaction callbacks ("Transaction
// function cannot return a promise"), so this wraps a manual BEGIN/COMMIT around the awaited
// (synchronously-resolving) drizzle ops. The callback only awaits in-process sqlite work, so no
// MACROtask interleaves — but MICROtasks do: two runTransaction calls started by separate async
// chains in the same tick both reached BEGIN, and the second threw "cannot start a transaction
// within a transaction" (two ticket runs started in the same second, 2026-10-28). So callers queue
// on ONE in-process lock, in call order.
// ⚠ A NESTED call (runTransaction inside a runTransaction callback) would wait on itself for ever;
// it throws instead, as the bare BEGIN always did. Detected by the holder's token in async context,
// so work the callback merely STARTED (fire-and-forget) that runs a transaction after the commit
// waits its turn rather than throwing.
let txTail: Promise<void> = Promise.resolve();
let txHolder: symbol | null = null;
const txContext = new AsyncLocalStorage<symbol>();

export async function runTransaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  const outer = txContext.getStore();
  if (outer != null && outer === txHolder) {
    throw new Error('runTransaction: a nested transaction is not supported');
  }
  const prev = txTail;
  let release!: () => void;
  txTail = new Promise<void>((resolve) => (release = resolve));
  await prev;
  const token = Symbol('tx');
  txHolder = token;
  try {
    return await txContext.run(token, async () => {
      sqliteConn.exec('BEGIN');
      try {
        const result = await fn(db);
        sqliteConn.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          sqliteConn.exec('ROLLBACK');
        } catch {
          /* rollback best-effort */
        }
        throw err;
      }
    });
  } finally {
    txHolder = null;
    release();
  }
}
