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

  installShutdownHandler(app);

  await app.listen({ port: config.port, host: config.host });
  return { app, port: config.port };
}

/* ═════════════════════════════ shutting down ═════════════════════════════ */

/**
 * THE PROCESS'S ONE SIGTERM HANDLER — and it exists for exactly one thing: letting an IN-FLIGHT
 * PUSH finish.
 *
 * ⚠ IT DOES NOT PRESERVE SESSIONS, AND IT MUST NOT GROW INTO SOMETHING THAT DOES. A restart loses
 * every conflict-resolver session and that is the correct behaviour, argued at length in
 * conflict/session.ts: the model is pinned to `(headSha, baseSha, modelHash)`, so a session that
 * survived a restart would survive into a world where the push it describes may be wrong. The
 * reader's DECISIONS are in the SPA's own store under that pinned key and outlive the deploy
 * already.
 *
 * What a redeploy must NOT do is kill a `git push` the resolver has already started. GitHub may
 * have taken the ref; the reader would be left with a landed commit and a screen that never said
 * so — the exact state the repo's `visible` copy contract exists to prevent. So: refuse new jobs,
 * wait for the running ones, then close.
 *
 * ⚠ IT CANNOT HANG. Two bounds, not one: the drain gives up at `config.shutdownGraceMs` (120s, the
 * timeout on a single git subprocess, which is the longest step a job can be inside), and
 * `app.close()` gets its own short deadline because the resolver's SSE streams are HIJACKED
 * sockets — Fastify's close does not force those shut, so a reader with an overlay open could
 * otherwise hold the process past whatever the platform's SIGKILL is.
 *
 * ⚠ IDEMPOTENT. A second SIGTERM is logged and ignored rather than escalating to an immediate
 * exit: escalating would kill the push this whole handler exists to protect, and the platform's
 * own SIGKILL is already the hard backstop.
 */
let shutdownStarted = false;
let handlerInstalled = false;

function installShutdownHandler(app: FastifyInstance): void {
  // ⚠ TWO FLAGS, NOT ONE. This one is "have we subscribed"; `shutdownStarted` is "has a signal
  // arrived". Collapsing them adds a second listener every time `start()` runs (the CLI imports
  // it), and `process.on` has no idea they are the same handler.
  if (handlerInstalled) return;
  handlerInstalled = true;
  process.on('SIGTERM', () => {
    if (shutdownStarted) {
      app.log.warn('SIGTERM again — already draining, waiting for the work in flight');
      return;
    }
    shutdownStarted = true;
    void drainAndClose(app);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function drainAndClose(app: FastifyInstance): Promise<void> {
  // ⚠ ONE try/finally AROUND EVERYTHING, AND THE EXIT IS IN THE FINALLY. This is fired with
  // `void` from a signal handler, so an escaping rejection is an UNHANDLED one — and the process
  // it was meant to shut down would then sit there until the platform's SIGKILL, with no log
  // line saying why.
  try {
    // Refuse new claims FIRST: from here a resolver open or commit is a 503 telling the reader to
    // try again in a moment, not a job started against a process that is going away.
    const { beginShutdown, runningJobCount } = await import('./conflict/session.js');
    beginShutdown();

    try {
      const { stopScheduler } = await import('./sync/scheduler.js');
      stopScheduler();
    } catch {
      /* the scheduler may never have started — nothing to stop */
    }

    const deadline = Date.now() + config.shutdownGraceMs;
    let announced = false;
    while (runningJobCount() > 0 && Date.now() < deadline) {
      if (!announced) {
        announced = true;
        app.log.info(`SIGTERM: waiting for ${runningJobCount()} resolver job(s) to finish`);
      }
      await sleep(250);
    }
    const left = runningJobCount();
    if (left > 0) {
      app.log.warn(`SIGTERM: closing with ${left} resolver job(s) still running`);
    }

    await Promise.race([app.close(), sleep(5_000)]);
  } catch (err) {
    app.log.warn({ err }, 'SIGTERM: shutdown did not finish cleanly');
  } finally {
    process.exit(0);
  }
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
