import { describe, expect, it } from 'vitest';
import {
  INTERRUPTED_SLEPT,
  INTERRUPTED_STALLED,
  SLEEP_GAP_SLACK_MS,
  STALL_MS,
  WAKE_GRACE_MS,
  WATCHDOG_TICK_MS,
  detectWake,
  runsToInterrupt,
} from './run-watchdog.js';
import { classifyAutoReviewFailure } from './auto-retry.js';

const T0 = 1_793_600_000_000;
const MIN = 60_000;

describe('detectWake (a late tick means the machine slept)', () => {
  it('an on-time or slightly late tick is not a wake', () => {
    expect(detectWake(null, T0)).toBeNull();
    expect(detectWake(T0, T0 + WATCHDOG_TICK_MS)).toBeNull();
    expect(detectWake(T0, T0 + WATCHDOG_TICK_MS + SLEEP_GAP_SLACK_MS)).toBeNull();
  });
  it('a tick late by more than the slack is a wake, at this tick', () => {
    expect(detectWake(T0, T0 + WATCHDOG_TICK_MS + SLEEP_GAP_SLACK_MS + 1)).toBe(T0 + WATCHDOG_TICK_MS + SLEEP_GAP_SLACK_MS + 1);
    expect(detectWake(T0, T0 + 3 * 60 * MIN)).toBe(T0 + 3 * 60 * MIN);
  });
});

describe('runsToInterrupt', () => {
  const woke = T0 + 60 * MIN;
  it('a run with no progress since the wake is interrupted once the grace has passed', () => {
    const run = { reviewId: 1, lastProgressMs: woke - 5 * MIN, wokeAtMs: woke };
    expect(runsToInterrupt([run], woke + WAKE_GRACE_MS - 1)).toEqual([]);
    expect(runsToInterrupt([run], woke + WAKE_GRACE_MS)).toEqual([{ reviewId: 1, reason: INTERRUPTED_SLEPT }]);
  });
  it('a LONG sleep is not a stall: the grace applies, not the stall clock the sleep ran down', () => {
    const run = { reviewId: 4, lastProgressMs: T0, wokeAtMs: T0 + 5 * 60 * MIN };
    expect(runsToInterrupt([run], T0 + 5 * 60 * MIN)).toEqual([]);
    expect(runsToInterrupt([run], T0 + 5 * 60 * MIN + WAKE_GRACE_MS)).toEqual([{ reviewId: 4, reason: INTERRUPTED_SLEPT }]);
  });
  it('a run that reported progress after the wake survived the sleep: left alone', () => {
    expect(runsToInterrupt([{ reviewId: 2, lastProgressMs: woke + 10_000, wokeAtMs: woke }], woke + 5 * MIN)).toEqual([]);
  });
  it('no sleep, but no progress for STALL_MS ⇒ stalled', () => {
    const run = { reviewId: 3, lastProgressMs: T0, wokeAtMs: null };
    expect(runsToInterrupt([run], T0 + STALL_MS - 1)).toEqual([]);
    expect(runsToInterrupt([run], T0 + STALL_MS)).toEqual([{ reviewId: 3, reason: INTERRUPTED_STALLED }]);
  });
});

describe('an interrupted run is a TRANSIENT failure (the auto-retry rule re-runs it when still due)', () => {
  it('both reasons classify transient; a Stop-like or unknown error stays final', () => {
    expect(classifyAutoReviewFailure(INTERRUPTED_SLEPT)).toBe('transient');
    expect(classifyAutoReviewFailure(INTERRUPTED_STALLED)).toBe('transient');
    expect(classifyAutoReviewFailure('The run was cancelled.')).toBe('final');
  });
});
