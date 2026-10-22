import { rawSqlite } from '../db/client.js';
import { applyMigrationFiles } from './migration-files.js';

// The platform's migration runner. src/platform/ (formerly the @pierre/pro plugin) keeps its OWN
// *.sql migrations in platform/migrations, run here after core's, each file once by NAME — the
// `pro_migrations` bookkeeping existing installs already carry, so a file a plugin-era install
// applied is never re-run. Each file commits atomically with its bookkeeping row
// (migration-files.ts).
//
// ⚠ THIS IS THE ONLY PLACE the raw DB driver is used, and it is strictly DDL + bookkeeping
// (CREATE TABLE / INSERT into pro_migrations) — never a data query.

export async function runPluginMigrations(folder: string): Promise<void> {
  // The raw better-sqlite3 Database behind drizzle.
  applyMigrationFiles(rawSqlite, folder);
}
