import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// Applies the platform's *.sql migrations to a raw better-sqlite3 handle, each file once by NAME,
// recorded in `pro_migrations`. Kept apart from migrate.ts (which binds the app's own connection)
// so a test can hand it a scratch database without opening the real one at import time.
//
// ⚠ EACH FILE AND ITS `pro_migrations` ROW COMMIT TOGETHER, in ONE immediate transaction. A failure
// here stops the whole boot (in the plugin era it only switched the plugin off), so a file that
// half-applied — its first CREATE TABLE committed, a later statement failed, no bookkeeping row —
// would re-run on the next boot, hit "table already exists" and block every boot after it. SQLite
// DDL is transactional and no file carries its own BEGIN/COMMIT, so nothing nests.
export function applyMigrationFiles(client: Database.Database, folder: string): void {
  // Bookkeeping table — which platform migrations have been applied.
  client.exec(
    'CREATE TABLE IF NOT EXISTS pro_migrations (name text PRIMARY KEY, applied_at integer NOT NULL)',
  );

  const isApplied = client.prepare('SELECT 1 FROM pro_migrations WHERE name=?');
  const record = client.prepare('INSERT INTO pro_migrations(name,applied_at) VALUES(?,?)');
  const apply = client.transaction((sql: string, name: string) => {
    // better-sqlite3's exec accepts several semicolon-separated statements in one call.
    client.exec(sql);
    record.run(name, Date.now());
  });

  const files = readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const name of files) {
    try {
      if (isApplied.get(name)) continue;
      apply.immediate(readFileSync(join(folder, name), 'utf8'), name);
    } catch (err) {
      throw new Error(
        `pro migration '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
