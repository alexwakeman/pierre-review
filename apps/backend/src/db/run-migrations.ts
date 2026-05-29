import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './client.js';

const migrationsFolder = resolve(import.meta.dirname, 'migrations');

// Apply pending migrations against the shared connection. Safe to call at
// server startup -- does not close the connection.
export function runMigrations(): void {
  migrate(db, { migrationsFolder });
}
