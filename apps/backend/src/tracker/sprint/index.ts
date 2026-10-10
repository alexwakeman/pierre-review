import type { TrackerContext } from '../context.js';
import { isSprintReadDue, readWorkspaceSprintOnce, type SprintReadOptions } from './read.js';

// The sprint read's entry points (./read.ts holds the rule change and the store rules). Registered
// by the integrator: `startSprintRead(ctx)` in `startTracker` (sets the GET's kick), and
// `registerSprintReadRoutes` in `registerTracker`. The tick needs no registration: the ticket
// worker's `runTrackerTick` calls `runSprintReadTick` at its end.

export { runSprintReadTick, sprintReadErrorMessage, readWorkspaceSprint, rereadForcedSprintTickets } from './read.js';
export { registerSprintReadRoutes } from './routes.js';
export { setAfterSprintRead } from './hooks.js';

/** Boot: the GET / Refresh kick reads a due workspace at once instead of waiting for the tick. */
export function startSprintRead(ctx: TrackerContext): void {
  // LAZY: db/sprint-store opens the core database at import; importing this module must not.
  void import('../../db/sprint-store.js').then(
    (m) =>
      m.setSprintReadKicker((accountId, workspaceId) => {
        void kickSprintReadNow(ctx, accountId, workspaceId);
      }),
    () => undefined,
  );
}

/** Read this workspace now IF it is due (viewed recently, `next_read_at` passed). One in flight per
 *  (account, workspace). Never throws. */
export async function kickSprintReadNow(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  opts: SprintReadOptions = {},
): Promise<void> {
  try {
    const now = (opts.now ?? Date.now)();
    if (!(await isSprintReadDue(ctx, accountId, workspaceId, now))) return;
    await readWorkspaceSprintOnce(ctx, accountId, workspaceId, opts);
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, route: 'tracker-sprint', code: err instanceof Error ? err.name : 'unknown' }, 'sprint kick failed (non-fatal)');
  }
}
