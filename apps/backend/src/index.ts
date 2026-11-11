import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { config } from './config.js';
import { cleanupRedundantReviewEvents } from './db/cleanup.js';
import { runMigrations } from './db/run-migrations.js';
import { bindPlatform } from './platform/context.js';
import { sweepCloneCache } from './review/clone-hygiene.js';

// Boot the server: migrate → cache the local user → build the Fastify app →
// start the scheduler → listen → (background) the first-boot AI download. Returns the listening Fastify instance and the
// resolved port so a caller (the CLI) can print the URL / open the browser.
export async function start(): Promise<{ app: FastifyInstance; port: number }> {
  // The one-time ~/.pierre-review → ~/.limn move already ran: config.ts does it on import, before it
  // resolves any path inside the data directory (data-dir.ts).

  // ONE BACKEND PER DATA DIRECTORY (instance-lock.ts), before ANY sweep below: the clone, worktree and
  // sandbox sweeps are keyed on the data directory, so a second backend on it would delete the first
  // one's live work. A live holder refuses this start; a dead one's lock is taken over.
  {
    const { acquireInstanceLock } = await import('./instance-lock.js');
    const lock = acquireInstanceLock(config.dataDir, { port: config.port, dbPath: config.dbPath });
    if (lock.tookOverFrom) {
      console.log(`lock: took over the lock of process ${lock.tookOverFrom.pid}, which is no longer running`);
    }
    process.once('exit', lock.release);
  }

  // Apply any pending migrations before serving.
  await runMigrations();

  // Drop redundant empty-review-wrapper timeline events left by older syncs.
  const removed = await cleanupRedundantReviewEvents();
  if (removed > 0) console.log(`cleanup: removed ${removed} redundant review_submitted events`);

  // Repair the clone cache before anything can hand a clone out: strip credentials an older
  // build left in `.git/config`, tighten permissions, and prune dead worktree records. AWAITED
  // — bindPlatform can start a fix that reuses a clone — but BOUNDED: a sweep that cannot
  // finish must not be the reason the server never listens.
  await Promise.race([
    sweepCloneCache().then((r) => {
      if (r.credentialsRepaired > 0 || r.clonesRemoved > 0) {
        console.log(
          `clones: repaired ${r.credentialsRepaired} and deleted ${r.clonesRemoved} of ${r.scanned} — a GitHub token was stored on disk. Run \`gh auth refresh\`: deleting the clone does not reach a backup the token is already in.`,
        );
      }
      if (r.worktreeRecordsPruned > 0) {
        console.log(`clones: pruned ${r.worktreeRecordsPruned} dead worktree records`);
      }
    }),
    new Promise<void>((resolve) => setTimeout(resolve, config.cloneSweepMaxMs).unref?.()),
  ]).catch(() => {
    /* the sweep is repair, not a precondition — never block the boot on it */
  });

  // Synthesize/refresh the single local account from `gh api user` so triage ("my turn") knows
  // who "you" are. Non-fatal if gh is missing.
  let localAccountId: number | null = null;
  {
    const { ensureLocalAccount } = await import('./auth/account.js');
    const me = await ensureLocalAccount();
    localAccountId = me?.id ?? null;
    if (me?.githubLogin) console.log(`local user: ${me.githubLogin}`);
    else console.warn('local user unknown (gh api user failed) — "my turn" disabled');
    // The Settings → AI provider choice, into memory before any run can start (LIMN_AI_PROVIDER, when
    // set, still wins). Never fails the boot: a read error means "not chosen" (auto).
    // The Effort level beside it (REVIEW_EFFORT, when set, wins); a read error means Default.
    // And "Use my API keys first" (LIMN_AI_USE_API_KEY, when set, wins); a read error means off.
    const { loadStoredAiEffort, loadStoredAiProvider, loadStoredPrefersApiKey } = await import('./ai/provider-store.js');
    await loadStoredAiProvider(me?.id);
    await loadStoredAiEffort(me?.id);
    await loadStoredPrefersApiKey(me?.id);
    // LIMN FINDINGS ARE BOTS (db/limn-bots.ts): stored finding comments go to their poster's
    // `limn:` bot (and edited-away ones back to their person) before anything reads them. DB only,
    // idempotent; a no-op pass is one indexed scan. Never fails the boot.
    if (me?.id != null) {
      try {
        const { reconcileLimnFindingAuthors } = await import('./db/limn-bots.js');
        const r = await reconcileLimnFindingAuthors(me.id);
        if (r.comments > 0 || r.repairedReviewerRows > 0) {
          console.log(`limn: re-attributed ${r.comments} finding comment(s), repaired ${r.repairedReviewerRows} reviewer row(s)`);
        }
      } catch (err) {
        console.warn('limn: finding re-attribution failed', err);
      }
    }
  }

  const app = await buildApp();

  // The worktree ledger (review/worktree-gc.ts): every per-run checkout made from here on is
  // recorded with its owner. Before anything below can start a run.
  const { installWorktreeLedger, kickWorktreeSweep } = await import('./review/worktree-gc.js');
  installWorktreeLedger();

  // Backfill the cross-team search index from already-stored data (PRs that predate the feature),
  // in the BACKGROUND so it never delays serving. Idempotent + batched; a cheap no-op once caught
  // up. New/updated PRs are indexed live by persistPr, so this only closes the historical gap.
  void import('./db/search.js')
    .then(({ backfillSearchIndex }) => backfillSearchIndex())
    .then((n) => {
      if (n > 0) console.log(`search: backfilled ${n} PRs into the search index`);
    })
    .catch((err) => app.log.warn({ err }, 'search index backfill failed'));

  // The agentic features' process-level half: the auto-review sweeper (scheduled below with every
  // other job) and the crash-orphan reconciles for Claude Review and AI Fix runs. A no-op under
  // LIMN_AI_DISABLED.
  {
    const { startAgenticBackground } = await import('./review/agentic.js');
    await startAgenticBackground(app);
  }

  // Register the platform (reporting, Bots Monitoring, Slack, settings — src/platform/). Static,
  // always on; its own migrations run here, after core's.
  await bindPlatform(app);

  // The issue tracker's process half: the one-time move of the plugin-era tracker
  // data into core — AFTER the plugin's own migrations ran — then the ticket worker and its
  // post-walk kick. Its `*/2` tick is scheduled with every other job below.
  {
    const { startTracker } = await import('./tracker/index.js');
    await startTracker(app);
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
  // LIMN'S HISTORY (db/limn-history-backfill.ts): the rows Limn wrote before its ledger existed move
  // to the poster's `limn:` bot, ONCE per account (a flag in `instance_meta`), in PR batches. Only
  // with LIMN_ATTRIBUTE_ALL on; after listen, never awaited, bounded, never fatal.
  void import('./db/limn-history-backfill.js')
    .then(({ kickLimnHistoryBackfill }) => kickLimnHistoryBackfill(localAccountId, app.log))
    .catch((err: unknown) => app.log.warn({ err }, 'limn: history re-attribution not started'));

  // Remove the per-run checkouts nothing needs any more — in the background, bounded by
  // WORKTREE_SWEEP_MAX_MS, after listen so it never delays serving.
  kickWorktreeSweep('boot');

  // The one-off cleanup of the transcripts older Limn agent runs left under ~/.claude/projects
  // (ai/session-litter.ts): once per machine (a flag in the data dir), only Limn-named directories,
  // in the background, bounded. After listen, never awaited. Never from a scratch backend: the folder
  // it cleans is the machine's, not the scratch data folder's.
  if (!config.scratch) void import('./ai/session-litter.js')
    .then(({ defaultSessionCleanupPlaces, runBootSessionCleanup }) =>
      runBootSessionCleanup({ ...defaultSessionCleanupPlaces(), dataDir: config.dataDir }),
    )
    .then((r) => {
      if (r && r.removed > 0) {
        console.log(
          `claude sessions: removed ${r.removed} old Limn session folders from ~/.claude/projects` +
            (r.timedOut ? ' (stopped at the time limit; the next start carries on)' : ''),
        );
      }
    })
    .catch(() => {
      /* repair, never a precondition */
    });

  // THE SANDBOX BOOT SWEEP (docs/SANDBOX.md § Labels and the sweep): every container, network and
  // volume this Limn labelled (`limn.managed`, keyed on the data dir) belongs to a session that died
  // with the last process (the session manager marks those failed on restart), so all are removed.
  // Free when no container CLI is installed; after listen, never awaited, never fatal.
  void import('./sandbox/runtime/index.js')
    .then(({ sweepSandboxesAtBoot }) => sweepSandboxesAtBoot())
    .then((r) => {
      const n = r ? r.containers.length + r.networks.length + r.volumes.length : 0;
      if (n > 0) console.log(`sandbox: removed ${n} leftover sandbox resources`);
      if (r && r.errors.length > 0) app.log.warn({ errors: r.errors.slice(0, 5) }, 'sandbox: some leftovers could not be removed');
    })
    .catch(() => {
      /* repair, never a precondition */
    });

  // THE PERIODIC SANDBOX SWEEP (sandbox/session/janitor.ts): while a session has made resources since the
  // last clean sweep, every few minutes, whatever a session's own close could not remove goes. This
  // process holds the data dir's lock (above), so the sweep is this install's alone.
  if (config.aiEnabled) {
    void import('./sandbox/session/janitor.js')
      .then(({ startSandboxJanitor }) => startSandboxJanitor(app.log))
      .catch((err: unknown) => app.log.warn({ err }, 'sandbox: the periodic sweep did not start'));
  }

  // A CI-history backfill a restart left OWED (its parked follow-on job lived only in memory):
  // queue each such repo's walk, whose follow-ons run it. After listen, never awaited.
  if (!config.disableScheduler) {
    void import('./sync/sync-manager.js')
      .then(({ resumePendingCiHistory }) => resumePendingCiHistory(app.log))
      .catch((err: unknown) => app.log.warn({ err }, 'ci-history resume not started'));
  }

  // Claude and Codex come with Limn: a boot that finds either runtime missing downloads both in the
  // BACKGROUND (ai/auto-install.ts). After listen and never awaited, so it cannot slow the boot; a
  // no-op under LIMN_AI_DISABLED / LIMN_AI_AUTO_INSTALL=false or when both are already there.
  void import('./ai/auto-install.js')
    .then(({ startAiAutoInstall }) => startAiAutoInstall(app.log))
    .catch((err) => app.log.warn({ err }, 'ai: background download not started'));

  return { app, port: config.port };
}

/* ═════════════════════════════ shutting down ═════════════════════════════ */

/**
 * THE PROCESS'S ONE SIGTERM HANDLER — and it exists for two things: letting an IN-FLIGHT PUSH
 * finish, then removing the running SANDBOXES (a container or microVM outlives the process otherwise;
 * docs/SANDBOX.md § Every end removes the sandbox). SIGINT and SIGHUP remove the sandboxes only.
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
  // Ctrl-C and a closed terminal: no drain (a person is in front of it), but the SANDBOXES go first —
  // without this a container or microVM kept running until the next start's sweep. A second signal
  // exits at once.
  for (const sig of ['SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (shutdownStarted) process.exit(sig === 'SIGINT' ? 130 : 129);
      shutdownStarted = true;
      void (async () => {
        try {
          await teardownSandboxes(app);
        } finally {
          process.exit(sig === 'SIGINT' ? 130 : 129);
        }
      })();
    });
  }
}

/**
 * Remove every live sandbox before the process ends (sandbox/session/manager.ts
 * `teardownSandboxesForShutdown`, bounded). Never throws. Free when agentic AI is off (no session exists).
 */
async function teardownSandboxes(app: FastifyInstance): Promise<void> {
  if (!config.aiEnabled) return;
  try {
    const { stopSandboxJanitor } = await import('./sandbox/session/janitor.js');
    stopSandboxJanitor();
    const { teardownSandboxesForShutdown } = await import('./sandbox/session/manager.js');
    const n = await teardownSandboxesForShutdown(SANDBOX_TEARDOWN_MS);
    if (n > 0) app.log.info(`shutdown: removed ${n} running sandbox${n === 1 ? '' : 'es'}`);
  } catch (err) {
    app.log.warn({ err }, 'shutdown: the sandboxes could not all be removed; the next start removes them');
  }
}

/** How long a shutdown waits for the sandboxes to be removed before it force-removes them. */
const SANDBOX_TEARDOWN_MS = 10_000;

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

    // The sandboxes go before the process: a container or microVM outlives Limn otherwise.
    await teardownSandboxes(app);

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
