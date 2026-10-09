import type { FastifyInstance } from 'fastify';
import { registerRepoSyncedHook } from '../sync/repo-synced-hooks.js';
import { registerTrackerRoutes } from './routes.js';
import { trackerContext } from './runtime.js';
import { enableTrackerWorker, kickTrackerSync } from './worker.js';
import { moveLegacyTrackerData } from './legacy-import.js';
import { checkReposGithubIssuesUsage } from './github/issues-usage.js';
import type { TrackerContext } from './context.js';

// THE ISSUE TRACKER — CORE, FREE, BOTH MODES (apiVersion 23; docs/TRACKERS.md). Two entry points:
//
//   registerTracker(app)  the routes (app.ts, unconditionally — no capability, no plugin).
//   startTracker(app)     the process half (index.ts, after the plugin binds): the one-time MOVE of
//                         the plugin's tracker data into core, the worker switched on, and its kick
//                         after every repo walk. The `*/2` tick is scheduled in sync/scheduler.ts.

export function registerTracker(app: FastifyInstance): void {
  registerTrackerRoutes(app, trackerContext());
}

let started = false;
let processCtx: TrackerContext | null = null;

/**
 * A repo JOINED a workspace (moved in, or re-homed to Default): ask GitHub whether it uses GitHub
 * Issues NOW, once, so the workspace's automatic default tracker is right straight away rather than
 * after the daily tick (./github/issues-usage.ts). A newly switched-on account gets a ticket pass.
 * Fire-and-forget, never throws; a no-op before `startTracker` (and in tests that never start it).
 */
export function kickGithubIssuesCheck(accountId: number, repoIds: readonly number[]): void {
  const ctx = processCtx;
  if (ctx == null || repoIds.length === 0) return;
  void checkReposGithubIssuesUsage(ctx, accountId, repoIds).then(({ switchedOn }) => {
    if (switchedOn) void kickTrackerSync(ctx, accountId);
  });
}

export async function startTracker(app: FastifyInstance): Promise<void> {
  if (started) return;
  started = true;
  const ctx = trackerContext(app.log);
  processCtx = ctx;
  // ⚠ AFTER the plugin's migrations (bindProPlugin), so a very old plugin's own 0031 backfill has
  // already landed in `pro_workspace_settings` before it is moved. Never fatal: a failure leaves the
  // source untouched and is retried on the next boot.
  try {
    const moved = await moveLegacyTrackerData();
    if (moved.trackers > 0 || moved.tickets > 0) {
      app.log.info(moved, 'tracker: moved the plugin-era tracker settings and stored tickets into core');
    }
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tracker: legacy move failed (retried next boot)');
  }
  enableTrackerWorker(true);
  // A KICK, NEVER A STEP: fire-and-forget after each completed repo walk, outside every transaction.
  registerRepoSyncedHook(({ accountId, repoId }) => {
    // A NEWLY ADDED repo lands in Default with no GitHub Issues answer: ask once, after its first walk.
    void checkReposGithubIssuesUsage(ctx, accountId, [repoId], { onlyUnasked: true }).then(({ switchedOn }) => {
      void kickTrackerSync(ctx, accountId, switchedOn ? {} : { repoId });
    });
  });
}
