// The per-account rate budget: when the gate waits, what it waits FOR, that a wait is
// cancellable in ≤1s slices, and that stale state clears on expiry (so a walk can never
// re-gate forever on numbers GitHub has already reset). Fake timers throughout — the gate
// is pure time arithmetic over an in-memory map.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RATE_BUDGET_FLOOR,
  __resetRateBudget,
  gateBudget,
  isLimited,
  noteBudget,
  noteLimited,
} from './rate-budget.js';

// The gate adds up to 2s of random jitter to every wait target; advancing by the target
// delta plus this slack always crosses it.
const JITTER_SLACK_MS = 3_000;

beforeEach(() => {
  vi.useFakeTimers();
  __resetRateBudget();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('gateBudget — the common (healthy) case', () => {
  it('returns ok immediately for an account never observed', async () => {
    const onWait = vi.fn();
    await expect(gateBudget(1, { onWait })).resolves.toBe('ok');
    expect(onWait).not.toHaveBeenCalled();
  });

  it('returns ok immediately while the budget is above the floor', async () => {
    noteBudget(1, { remaining: 4200, resetAt: new Date(Date.now() + 30 * 60_000) });
    const onWait = vi.fn();
    await expect(gateBudget(1, { onWait })).resolves.toBe('ok');
    expect(onWait).not.toHaveBeenCalled();
  });
});

describe('gateBudget — under the floor', () => {
  it('waits until the reported resetAt (calling onWait exactly once), then proceeds', async () => {
    const resetAt = new Date(Date.now() + 5 * 60_000);
    noteBudget(1, { remaining: RATE_BUDGET_FLOOR - 1, resetAt });
    const onWait = vi.fn();

    let result: 'ok' | 'cancelled' | null = null;
    const gate = gateBudget(1, { onWait }).then((r) => (result = r));

    // Not resolved well before the reset...
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(result).toBeNull();
    expect(onWait).toHaveBeenCalledTimes(1);
    const resumeAt = onWait.mock.calls[0]![0] as Date;
    expect(resumeAt.getTime()).toBeGreaterThanOrEqual(resetAt.getTime());

    // ...resolved once the window (plus jitter) has passed.
    await vi.advanceTimersByTimeAsync(60_000 + JITTER_SLACK_MS);
    await gate;
    expect(result).toBe('ok');

    // Stale state cleared on expiry: the next gate must NOT wait again on the same
    // (now presumed-reset) numbers.
    const onWait2 = vi.fn();
    await expect(gateBudget(1, { onWait: onWait2 })).resolves.toBe('ok');
    expect(onWait2).not.toHaveBeenCalled();
  });

  it('falls back to a ~minute wait when no resetAt was ever observed', async () => {
    noteBudget(1, { remaining: 3, resetAt: null });
    let result: string | null = null;
    void gateBudget(1).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(35_000 + JITTER_SLACK_MS);
    expect(result).toBe('ok');
  });
});

describe('gateBudget — a hard limit (noteLimited)', () => {
  it('waits out the limited window and clears it', async () => {
    noteLimited(1, new Date(Date.now() + 90_000));
    expect(isLimited(1)).toBe(true);

    let result: string | null = null;
    void gateBudget(1).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000 + JITTER_SLACK_MS);
    expect(result).toBe('ok');
    expect(isLimited(1)).toBe(false);
  });

  it('a limited error with no resume hint defaults to ~a minute', async () => {
    noteLimited(1, null);
    expect(isLimited(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(isLimited(1)).toBe(false);
  });

  it('a successful page observation (noteBudget) does NOT clear the limited flag', async () => {
    // The REST secondary/abuse limiter is independent of GraphQL: a GraphQL page landing
    // proves nothing about a REST-observed block, so it stays until the window expires.
    noteLimited(1, new Date(Date.now() + 90_000));
    expect(isLimited(1)).toBe(true);
    noteBudget(1, { remaining: 4900, resetAt: new Date(Date.now() + 30 * 60_000) });
    expect(isLimited(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(95_000);
    expect(isLimited(1)).toBe(false);
  });
});

describe('gateBudget — cancellation', () => {
  it('returns cancelled within a slice of shouldCancel flipping true', async () => {
    noteLimited(1, new Date(Date.now() + 10 * 60_000));
    let cancel = false;
    let result: string | null = null;
    void gateBudget(1, { shouldCancel: () => cancel }).then((r) => (result = r));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBeNull();
    cancel = true;
    // The sleep runs in ≤1s slices, each checking shouldCancel — one slice suffices.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(result).toBe('cancelled');
  });
});

describe('isLimited', () => {
  it('is scoped per account', () => {
    noteLimited(7, new Date(Date.now() + 60_000));
    expect(isLimited(7)).toBe(true);
    expect(isLimited(8)).toBe(false);
  });

  it('expires on its own', async () => {
    noteLimited(1, new Date(Date.now() + 5_000));
    expect(isLimited(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(isLimited(1)).toBe(false);
  });
});
