import { buildApp } from './app.js';
import { config } from './config.js';
import { cleanupRedundantReviewEvents } from './db/cleanup.js';
import { runMigrations } from './db/run-migrations.js';

async function main(): Promise<void> {
  // Apply any pending migrations before serving.
  runMigrations();

  // Drop redundant empty-review-wrapper timeline events left by older syncs.
  const removed = cleanupRedundantReviewEvents();
  if (removed > 0) console.log(`cleanup: removed ${removed} redundant review_submitted events`);

  // Cache the locally-authenticated GitHub user up front so triage ("my turn")
  // knows who "you" are. Non-fatal if gh isn't available.
  const { ensureLocalUser } = await import('./github/local-user.js');
  const me = ensureLocalUser();

  const app = await buildApp();
  if (me) app.log.info(`local user: ${me.login}`);
  else app.log.warn('local user unknown (gh api user failed) — "my turn" disabled');

  // Scheduler is wired in Phase 3; guarded so the skeleton runs without it.
  if (!config.disableScheduler) {
    try {
      const { startScheduler } = await import('./sync/scheduler.js');
      startScheduler(app.log);
    } catch (err) {
      app.log.warn({ err }, 'scheduler not started');
    }
  }

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('Failed to start backend:', err);
  process.exit(1);
});
