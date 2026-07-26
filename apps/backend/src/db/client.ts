// Mode-aware database client.
//
//   local  → better-sqlite3 (synchronous engine) + the sqlite-core schema
//   cloud  → node-postgres Pool + the pg-core schema
//
// The whole app talks to `db` through the PORTABLE async surface only
// (`await builder` / `.execute()` / `.returning().execute()` / runTransaction) —
// the empirically-verified subset that behaves identically on both drivers (see
// the probe in the cloud-refactor notes). `db` is TYPED as the Postgres drizzle
// instance so any stray `.get()/.all()/.run()` (better-sqlite3-only) is a compile
// error; at runtime the better-sqlite3 instance supports that same subset.
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { config } from '../config.js';
import * as sqliteSchema from './schema.sqlite.js';
import * as pgSchema from './schema.pg.js';

// The canonical schema TYPE is the pg one; the active schema VALUE is selected by
// mode and cast to it. The two modules are structurally identical (same table +
// column names + `$type`s) — guarded by the schema-parity test — so the cast is
// sound.
export type Schema = typeof pgSchema;
export type DB = NodePgDatabase<Schema>;
// The executor a runTransaction callback receives (a tx on pg; the db on sqlite).
export type Executor = DB;

export const isPg = config.dbDialect === 'postgres';

let dbInstance: DB;
let schemaValue: Schema;
let closeFn: () => Promise<void>;
// Kept for the sqlite-only manual transaction path; null in cloud mode.
let sqliteConn: import('better-sqlite3').Database | null = null;

if (isPg) {
  // Dynamic import so the unused native driver isn't loaded in the other mode.
  const pg = await import('pg');
  const Pool = pg.Pool ?? (pg as unknown as { default: typeof pg }).default.Pool;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new Pool({ connectionString: config.databaseUrl });
  schemaValue = pgSchema;
  dbInstance = drizzle(pool, { schema: pgSchema });
  closeFn = async () => {
    await pool.end();
  };
} else {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  // Owner-only on the DIRECTORY as well as the file: WAL mode creates two siblings
  // (`-wal`, `-shm`) that hold the same data and are created by SQLite with the process
  // umask, so locking down only the main file would leave the write-ahead log readable.
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  sqliteConn = new Database(config.dbPath);
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
  schemaValue = sqliteSchema as unknown as Schema;
  dbInstance = drizzle(sqliteConn, {
    schema: sqliteSchema,
  }) as unknown as DB;
  closeFn = async () => {
    sqliteConn?.close();
  };
}

export const db = dbInstance;
export const schema = schemaValue;

// Close the underlying connection (pool.end() / better-sqlite3 .close()). Used by
// the one-shot migrate CLI; the long-running server never calls it.
export async function closeDb(): Promise<void> {
  await closeFn();
}

// Dialect-aware transaction. better-sqlite3 rejects async transaction callbacks
// ("Transaction function cannot return a promise"), so the sqlite path wraps a
// manual BEGIN/COMMIT around the awaited (synchronously-resolving) drizzle ops —
// no other macrotask interleaves between BEGIN and COMMIT because the callback
// only awaits in-process sqlite work (no real I/O). The pg path uses a real
// async transaction. Either way the callback uses the same portable `tx` surface.
export async function runTransaction<T>(
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  if (isPg) {
    return dbInstance.transaction(async (tx) => fn(tx as unknown as Executor));
  }
  const conn = sqliteConn;
  if (!conn) throw new Error('sqlite connection not initialised');
  conn.exec('BEGIN');
  try {
    const result = await fn(dbInstance);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* rollback best-effort */
    }
    throw err;
  }
}
