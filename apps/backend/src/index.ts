import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { config } from './config.js';
import { cleanupRedundantReviewEvents } from './db/cleanup.js';
import { runMigrations } from './db/run-migrations.js';

// Boot the server: migrate → cache the local user → build the Fastify app →
// start the scheduler → listen. Returns the listening Fastify instance and the
// resolved port so a caller (the CLI) can print the URL / open the browser.
export async function start(): Promise<{ app: FastifyInstance; port: number }> {
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
  return { app, port: config.port };
}

// Run-as-main guard: only auto-boot when this module is the process entrypoint
// (e.g. `node dist/index.js` via the `start` script). When the CLI imports
// `start()`, this stays dormant so the server boots exactly once.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  start().catch((err) => {
    console.error('Failed to start backend:', err);
    process.exit(1);
  });
}
