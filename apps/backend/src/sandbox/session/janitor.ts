// THE PERIODIC SWEEP (docs/SANDBOX.md § Every end removes the sandbox). Every session's close removes
// its own sandbox; this catches what a close could not (a daemon that refused, a removal that timed out,
// a boot cut off between two creates). Every SANDBOX_SWEEP_INTERVAL_MS, while a session has made
// resources since the last clean sweep, every Limn-labelled resource of THIS data dir whose session is
// not live is removed (runtime/index.ts `sweepSandboxesNow`: the session list is read in the same tick
// the sweep gate is set, so a session booted meanwhile waits for it).
//
// ⚠ Only the backend that holds the data dir's lock runs it (index.ts starts it after taking the lock).
// It never touches another data dir's resources (`limn.managed` is this data dir's hash) or anything
// unlabelled. A machine that never starts a sandbox never starts a container CLI for it.
import type { SandboxRunningStatus, SandboxStopAllResult } from '@pierre-review/shared';
import { listRunningSandboxes, sweepSandboxesNow } from '../runtime/index.js';
import type { SandboxRuntime, SweepResult } from '../runtime/types.js';
import { liveSandboxIds, noteSweptClean, sandboxesNeedSweep, stopAllSessions } from './manager.js';

export const SANDBOX_SWEEP_INTERVAL_MS = 5 * 60_000;

interface JanitorLog {
  info: (msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<SweepResult | null> | null = null;

/** One sweep now, when one is due (a session made resources since the last clean sweep). */
export async function sandboxJanitorTick(o: { log?: JanitorLog; backends?: SandboxRuntime[]; force?: boolean } = {}): Promise<SweepResult | null> {
  // A forced sweep ("Stop all") never answers with one that started before the sessions closed.
  if (o.force) while (running) await running;
  if (running) return running;
  if (!o.force && !sandboxesNeedSweep()) return null;
  running = (async () => {
    await Promise.resolve(); // `running` is set before the `finally` below can clear it
    try {
      const r = await sweepSandboxesNow({ liveSessionIds: liveSandboxIds, ...(o.backends ? { backends: o.backends } : {}) });
      if (!r) return null;
      const n = r.result.containers.length + r.result.networks.length + r.result.volumes.length + r.result.images.length;
      if (n > 0) o.log?.info(`sandbox: the periodic sweep removed ${n} leftover sandbox resources`);
      if (r.result.errors.length > 0) o.log?.warn({ errors: r.result.errors.slice(0, 5) }, 'sandbox: some leftovers could not be removed');
      else if (r.swept.length > 0) noteSweptClean();
      return r.result;
    } catch (err) {
      o.log?.warn({ err }, 'sandbox: the periodic sweep failed');
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function startSandboxJanitor(log?: JanitorLog): void {
  if (timer) return;
  timer = setInterval(() => void sandboxJanitorTick(log ? { log } : {}), SANDBOX_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopSandboxJanitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---- Settings → Sandbox: the count and "Stop all" -------------------------------------------------------------

const NO_RUNTIME = 'No container runtime answers.';

/** How many sandboxes of this Limn run now, read from the runtime (every installed backend that answers). */
export async function runningSandboxes(o: { backends?: SandboxRuntime[] } = {}): Promise<SandboxRunningStatus> {
  try {
    const list = await listRunningSandboxes(o.backends ? { backends: o.backends } : {});
    return list == null ? { running: null, problem: NO_RUNTIME } : { running: list.length, problem: null };
  } catch (err) {
    return { running: null, problem: err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : NO_RUNTIME };
  }
}

/**
 * "Stop all": close every live session (manager.ts `stopAllSessions`: a manual one keeps its stored
 * changes, an unattended fix is cancelled), then sweep every leftover of this data dir.
 */
export async function stopAllSandboxes(o: { backends?: SandboxRuntime[] } = {}): Promise<SandboxStopAllResult> {
  const before = await runningSandboxes(o);
  const closed = await stopAllSessions();
  const swept = await sandboxJanitorTick({ force: true, ...(o.backends ? { backends: o.backends } : {}) });
  const after = await runningSandboxes(o);
  const removedByRuntime = before.running != null && after.running != null ? Math.max(0, before.running - after.running) : 0;
  const errors = swept?.errors ?? [];
  return {
    stopped: Math.max(closed, removedByRuntime),
    running: after.running,
    problem: errors.length > 0 ? `${errors.length === 1 ? 'One resource' : `${errors.length} resources`} could not be removed: ${errors[0]}` : after.problem,
  };
}
