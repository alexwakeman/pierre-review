import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { syncAllRepos } from './sync-manager.js';
import { pruneOldData } from '../db/retention.js';
import { getScheduledJobs } from './scheduled-jobs.js';
import { runBenchmarkRollup } from './benchmark-rollup.js';
import { AUTO_MERGE_CRON, runAutoMergeTick } from '../merge/auto-merge-runner.js';
import type { Logger } from './sync-repo.js';

let task: ScheduledTask | null = null;
let retentionTask: ScheduledTask | null = null;
let benchmarkTask: ScheduledTask | null = null;
let autoMergeTask: ScheduledTask | null = null;
// node-cron handles for plugin-registered background jobs (Slack digest cron, AI update policy).
let proJobTasks: ScheduledTask[] = [];

// node-cron incremental sync loop. Idempotent upserts make overlapping windows
// safe; syncAllRepos skips any repo already mid-sync.
export function startScheduler(log: FastifyBaseLogger): void {
  if (task) return;
  if (!cron.validate(config.syncCron)) {
    log.warn(`invalid SYNC_CRON "${config.syncCron}"; scheduler disabled`);
    return;
  }

  const logger: Logger = {
    info: (m, ...a) => log.info(a.length ? { a } : {}, m),
    warn: (m, ...a) => log.warn(a.length ? { a } : {}, m),
    error: (m, ...a) => log.error(a.length ? { a } : {}, m),
  };

  task = cron.schedule(config.syncCron, () => {
    void syncAllRepos(logger);
  });
  log.info(`scheduler started (cron "${config.syncCron}")`);

  // Retention sweep: a SEPARATE (typically daily) cron so old data is pruned off-peak,
  // independent of the sync loop. Shares the same disableScheduler gate as the sync task.
  if (config.retentionDays > 0) {
    if (cron.validate(config.retentionCron)) {
      retentionTask = cron.schedule(config.retentionCron, () => {
        void pruneOldData(log).catch((err) =>
          log.error({ err }, 'retention sweep failed'),
        );
      });
      log.info(
        `retention started (cron "${config.retentionCron}", ${config.retentionDays}d window)`,
      );
    } else {
      log.warn(`invalid RETENTION_CRON "${config.retentionCron}"; retention disabled`);
    }
  }

  // Cross-org benchmark rollup (CORE, CLOUD-ONLY, opt-in). Weekly; INERT unless an account has
  // consented (accounts.benchmark_opt_in) — the sweep returns early with zero opted-in accounts,
  // and never runs at all in local mode (runBenchmarkRollup gates on config.isCloud). Rides the
  // same disableScheduler gate. A throw in a tick is caught so a bad tenant never crashes the loop.
  if (config.isCloud && cron.validate(config.benchmarkRollupCron)) {
    benchmarkTask = cron.schedule(config.benchmarkRollupCron, () => {
      void runBenchmarkRollup(log).catch((err) =>
        log.error({ err }, 'benchmark rollup sweep failed'),
      );
    });
    log.info(`benchmark rollup started (cron "${config.benchmarkRollupCron}")`);
  }

  // Armed-merge watcher ("merge when ready"). Rides the same disableScheduler gate as sync —
  // which is exactly why the UI must say auto-merge only lands while the app is running: with
  // the server down there is nothing to re-evaluate the intent. Its own tick is bounded and
  // catches internally, so a bad tenant never crashes the loop. Runs in BOTH modes: local is
  // the common case (the app is open on the developer's machine) and cloud arms per account.
  if (cron.validate(AUTO_MERGE_CRON)) {
    autoMergeTask = cron.schedule(AUTO_MERGE_CRON, () => {
      void runAutoMergeTick(log);
    });
    log.info(`auto-merge watcher started (cron "${AUTO_MERGE_CRON}")`);
  }

  // Plugin-registered background jobs (the @pierre/pro Slack digest cron + AI update policy).
  // Registered during bindProPlugin (which runs BEFORE startScheduler), so the registry is
  // populated here. Each rides the same disableScheduler gate as sync/retention and is torn
  // down with the app. A throw in a handler is caught so a bad tick never crashes the process.
  for (const job of getScheduledJobs()) {
    if (!cron.validate(job.cron)) {
      log.warn(`invalid cron "${job.cron}" for pro job "${job.label}"; skipped`);
      continue;
    }
    proJobTasks.push(
      cron.schedule(job.cron, () => {
        void Promise.resolve()
          .then(job.handler)
          .catch((err) => log.error({ err }, `pro job "${job.label}" failed`));
      }),
    );
    log.info(`pro job "${job.label}" started (cron "${job.cron}")`);
  }
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
  retentionTask?.stop();
  retentionTask = null;
  benchmarkTask?.stop();
  benchmarkTask = null;
  autoMergeTask?.stop();
  autoMergeTask = null;
  for (const t of proJobTasks) t.stop();
  proJobTasks = [];
}
