// Applies pending drizzle migrations, then exits. Run via `pnpm db:migrate`.
import { sqlite } from './client.js';
import { runMigrations } from './run-migrations.js';

try {
  runMigrations();
  console.log('Migrations applied.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
