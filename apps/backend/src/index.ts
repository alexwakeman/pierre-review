import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { assertCloudConfig, config } from './config.js';
import { cleanupRedundantReviewEvents } from './db/cleanup.js';
import { runMigrations } from './db/run-migrations.js';

// Boot the server: migrate → cache the local user → build the Fastify app →
// start the scheduler → listen. Returns the listening Fastify instance and the
// resolved port so a caller (the CLI) can print the URL / open the browser.
export async function start(): Promise<{ app: FastifyInstance; port: number }> {
  // Cloud mode: fail loud if required env vars are missing/invalid before serving.
  if (config.isCloud) assertCloudConfig();

  // Apply any pending migrations before serving.
  await runMigrations();

  // Drop redundant empty-review-wrapper timeline events left by older syncs.
  const removed = await cleanupRedundantReviewEvents();
  if (removed > 0) console.log(`cleanup: removed ${removed} redundant review_submitted events`);

  // Local mode only: synthesize/refresh the single local account from `gh api
  // user` so triage ("my turn") knows who "you" are. Non-fatal if gh is missing.
  // In cloud mode accounts are created via OAuth sign-in instead.
  if (!config.isCloud) {
    const { ensureLocalAccount } = await import('./auth/account.js');
    const me = await ensureLocalAccount();
    if (me?.githubLogin) console.log(`local user: ${me.githubLogin}`);
    else console.warn('local user unknown (gh api user failed) — "my turn" disabled');
  }

  const app = await buildApp();

  // Heal any Claude review runs left mid-flight by a crash (their 'running'
  // status is persisted). Only relevant when the feature is enabled.
  if (config.claudeReviewEnabled) {
    const { reconcileReviewsOnStartup } = await import(
      './review/review-manager.js'
    );
    await reconcileReviewsOnStartup(app.log);
  }

  // Bind the optional Pro plugin (dynamic import; no-ops in OSS mode). Same
  // "optional subsystem, degrade gracefully" posture as the scheduler below.
  {
    const { bindProPlugin } = await import('./pro/bind.js');
    await bindProPlugin(app);
  }

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
