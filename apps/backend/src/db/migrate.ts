// Applies pending drizzle migrations, then exits. Run via `pnpm db:migrate`.
// Dialect-aware via config: set DEPLOYMENT_MODE=cloud + DATABASE_URL to apply the
// Postgres migrations instead of the SQLite ones.
import { closeDb } from './client.js';
import { runMigrations } from './run-migrations.js';

try {
  await runMigrations();
  console.log('Migrations applied.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
