import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './client.js';

// Apply pending migrations against the shared connection. The folder resolves next to the
// compiled output (dist/db/migrations). Safe at server startup — does not close the connection.
export async function runMigrations(): Promise<void> {
  migrate(db, { migrationsFolder: resolve(import.meta.dirname, 'migrations') });
}
