// THE RUN WATCHDOG (docs/CLAUDE-REVIEW.md § Auto review → Sleep and stalled runs). Pure halves; the
// manager (manager.ts `watchdogTick`) owns the timer and the runs.
//
// A laptop that sleeps mid-review leaves the agent's connection dead or hung: the run either dies
// with a confusing error or never ends, and a run that never ends holds its PR's seat and a review
// slot for good. The watchdog ticks every WATCHDOG_TICK_MS:
//   • A TICK THAT CAME LATE BY MORE THAN SLEEP_GAP_SLACK_MS means the machine slept (timers do not
//     fire while it sleeps). Every run then in flight is a SUSPECT, woken at that tick.
//   • A suspect that has made NO PROGRESS since the wake, WAKE_GRACE_MS after it, is interrupted
//     with INTERRUPTED_SLEPT (a run that survived the sleep reports progress and is left alone).
//   • Any run with no progress for STALL_MS is interrupted with INTERRUPTED_STALLED.
// An interrupted run is FAILED, never cancelled, with a reason the auto-retry rule reads as
// TRANSIENT (auto-retry.ts), so the ordinary retry rule re-runs it ONLY when still required (the head
// unchanged, nothing succeeded there, the PR open, under the per-head and daily caps). A run that
// ignores the abort is released FORCE_RELEASE_MS later, so it never blocks the queue.

export const WATCHDOG_TICK_MS = 30_000;
/** A tick this much later than due ⇒ the machine slept. */
export const SLEEP_GAP_SLACK_MS = 90_000;
/** After a wake, how long a run has to show it is still alive. */
export const WAKE_GRACE_MS = 2 * 60_000;
/** No progress for this long ⇒ the run is stuck (agents report progress every tool call). */
export const STALL_MS = 30 * 60_000;
/** An interrupted run that has not ended this long after the abort is released anyway. */
export const FORCE_RELEASE_MS = 2 * 60_000;

export const INTERRUPTED_SLEPT = 'Interrupted: the computer slept';
export const INTERRUPTED_STALLED = 'Interrupted: the run stopped making progress';

/** The wake time when this tick came late enough to mean the machine slept, else null. */
export function detectWake(prevTickMs: number | null, nowMs: number, tickMs: number = WATCHDOG_TICK_MS): number | null {
  if (prevTickMs == null) return null;
  return nowMs - prevTickMs > tickMs + SLEEP_GAP_SLACK_MS ? nowMs : null;
}

export interface WatchedRun {
  reviewId: number;
  /** The run's newest progress (its start when it reported none). */
  lastProgressMs: number;
  /** Set when the machine woke while this run was in flight. */
  wokeAtMs: number | null;
}

/** The runs to interrupt now, each with its reason. Pure. */
export function runsToInterrupt(runs: readonly WatchedRun[], nowMs: number): Array<{ reviewId: number; reason: string }> {
  const out: Array<{ reviewId: number; reason: string }> = [];
  for (const r of runs) {
    // A suspect (no progress since the wake) gets the grace — never the stall test, whose clock the
    // sleep itself ran down (a long sleep must not read as a stuck run the moment the lid opens).
    if (r.wokeAtMs != null && r.lastProgressMs < r.wokeAtMs) {
      if (nowMs - r.wokeAtMs >= WAKE_GRACE_MS) out.push({ reviewId: r.reviewId, reason: INTERRUPTED_SLEPT });
      continue;
    }
    if (nowMs - Math.max(r.lastProgressMs, r.wokeAtMs ?? 0) >= STALL_MS) {
      out.push({ reviewId: r.reviewId, reason: INTERRUPTED_STALLED });
    }
  }
  return out;
}
