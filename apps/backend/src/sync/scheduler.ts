import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { syncAllRepos } from './sync-manager.js';
import type { Logger } from './sync-repo.js';

let task: ScheduledTask | null = null;

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
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
}
