import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawSqlite } from '../db/client.js';

// The platform's migration runner. src/platform/ (formerly the @pierre/pro plugin) keeps its OWN
// *.sql migrations in platform/migrations, run here after core's, each file once by NAME — the
// `pro_migrations` bookkeeping existing installs already carry, so a file a plugin-era install
// applied is never re-run.
//
// ⚠ THIS IS THE ONLY PLACE the raw DB driver is used, and it is strictly DDL + bookkeeping
// (CREATE TABLE / INSERT into pro_migrations) — never a data query.

export async function runPluginMigrations(folder: string): Promise<void> {
  // The raw better-sqlite3 Database behind drizzle.
  const client = rawSqlite;

  // Bookkeeping table — which platform migrations have been applied.
  client.exec(
    'CREATE TABLE IF NOT EXISTS pro_migrations (name text PRIMARY KEY, applied_at integer NOT NULL)',
  );

  const files = readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const name of files) {
    try {
      const applied = !!client.prepare('SELECT 1 FROM pro_migrations WHERE name=?').get(name);
      if (applied) continue;
      // better-sqlite3's exec accepts several semicolon-separated statements in one call.
      client.exec(readFileSync(join(folder, name), 'utf8'));
      client.prepare('INSERT INTO pro_migrations(name,applied_at) VALUES(?,?)').run(name, Date.now());
    } catch (err) {
      throw new Error(
        `pro migration '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
