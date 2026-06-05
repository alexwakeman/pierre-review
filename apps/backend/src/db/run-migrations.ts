import { resolve } from 'node:path';
import { db, isPg } from './client.js';

// Apply pending migrations against the shared connection. Dialect-aware: the
// sqlite migrator is synchronous, the node-postgres migrator is async — so this
// is `async` either way and the caller (index.ts / migrate.ts) awaits it. Each
// dialect resolves its own migrations folder next to the compiled output
// (dist/db/migrations or dist/db/migrations-pg). Safe at server startup — does
// not close the connection.
export async function runMigrations(): Promise<void> {
  const migrationsFolder = resolve(
    import.meta.dirname,
    isPg ? 'migrations-pg' : 'migrations',
  );
  if (isPg) {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db as unknown as Parameters<typeof migrate>[0], {
      migrationsFolder,
    });
  } else {
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    // `db` is typed as the pg instance; at runtime here it's the better-sqlite3
    // one, which is what the sqlite migrator expects.
    migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  }
}
