// Host-owned scheduled-job registry — the seam the private @pierre/pro plugin uses to run
// background work (the Slack digest cron, the AI-summary update policy) WITHOUT owning
// process/scheduler infra (the open-core rule: the host owns process lifecycle). The plugin
// calls ctx.registerScheduledJob(cron, handler, label) during register(); the core scheduler
// (startScheduler) reads this registry AFTER bind and cron.schedule()s each job, so registered
// jobs ride the same config.disableScheduler gate and are torn down with the app. Inert in OSS
// (no plugin → nothing registered → nothing scheduled). Mirrors review/events.ts.
export interface ScheduledJob {
  cron: string; // a node-cron expression (validated by the scheduler; invalid → skipped + warn)
  label: string; // human label for logs
  handler: () => Promise<void> | void; // fire-and-forget; the scheduler catches throws
}

const jobs: ScheduledJob[] = [];

export function registerScheduledJob(
  cron: string,
  handler: () => Promise<void> | void,
  label = 'pro-job',
): void {
  jobs.push({ cron, label, handler });
}

export function getScheduledJobs(): ScheduledJob[] {
  return jobs;
}

// Test/reset hook — registration is process-lifetime, but tests may want a clean slate.
export function clearScheduledJobs(): void {
  jobs.length = 0;
}
