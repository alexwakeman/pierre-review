import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { assertCloudConfig, config } from './config.js';
import { cleanupRedundantReviewEvents } from './db/cleanup.js';
import { runMigrations } from './db/run-migrations.js';
import { sweepCloneCache } from './review/clone-hygiene.js';

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

  // Repair the clone cache before anything can hand a clone out: strip credentials an older
  // build left in `.git/config`, tighten permissions, and collect orphaned worktrees. AWAITED
  // — bindProPlugin can start a fix that reuses a clone — but BOUNDED: a sweep that cannot
  // finish must not be the reason the server never listens.
  await Promise.race([
    sweepCloneCache().then((r) => {
      if (r.credentialsRepaired > 0 || r.clonesRemoved > 0) {
        console.log(
          `clones: repaired ${r.credentialsRepaired} and deleted ${r.clonesRemoved} of ${r.scanned} — a GitHub token was stored on disk. Run \`gh auth refresh\`: deleting the clone does not reach a backup the token is already in.`,
        );
      }
      if (r.worktreeDirsRemoved > 0 || r.worktreeRecordsPruned > 0) {
        console.log(
          `clones: removed ${r.worktreeDirsRemoved} stale worktrees and ${r.worktreeRecordsPruned} dead records`,
        );
      }
    }),
    new Promise<void>((resolve) => setTimeout(resolve, config.cloneSweepMaxMs).unref?.()),
  ]).catch(() => {
    /* the sweep is repair, not a precondition — never block the boot on it */
  });

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

  // Backfill the cross-team search index from already-stored data (PRs that predate the feature),
  // in the BACKGROUND so it never delays serving. Idempotent + batched; a cheap no-op once caught
  // up. New/updated PRs are indexed live by persistPr, so this only closes the historical gap.
  void import('./db/search.js')
    .then(({ backfillSearchIndex }) => backfillSearchIndex())
    .then((n) => {
      if (n > 0) console.log(`search: backfilled ${n} PRs into the search index`);
    })
    .catch((err) => app.log.warn({ err }, 'search index backfill failed'));

  // (Claude Review moved into @pierre/pro — its crash-orphan reconcile now runs inside
  // plugin.register during bindProPlugin below, alongside the AI-Fix reconcile.)

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
