import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCKOUT_DEFAULT_MS,
  anyUsageLockout,
  automaticRunProviders,
  clearUsageLockout,
  isLockedOut,
  isUsageLockoutError,
  lockoutUntilFromError,
  noteProviderFailure,
  restoreUsageLockouts,
  usageLockedUntilIso,
  usageLockout,
} from './usage-lockout.js';
import { autoReviewDue } from '../review/claude-review/auto.js';
import { automaticRunAllowed } from '../review/budget-gate.js';

// The real incident's error (PR 199965, runs 1056–1058).
const CODEX =
  'Codex could not finish: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 8:54 PM.';
// 2026-11-02 20:03:00 local time.
const FAILED = new Date(2026, 10, 2, 20, 3, 0).getTime();
const MIN = 60_000;

afterEach(() => clearUsageLockout());

describe('what a lockout is', () => {
  it('a usage limit is; a plain rate limit, a 429 or an overload is not', () => {
    expect(isUsageLockoutError(CODEX)).toBe(true);
    expect(isUsageLockoutError("You've hit your session limit · resets 3pm (Europe/London)")).toBe(true);
    expect(isUsageLockoutError('You’re out of usage credits · resets 5pm')).toBe(true);
    expect(isUsageLockoutError('rate limit exceeded')).toBe(false);
    expect(isUsageLockoutError("You've hit your rate limit, slow down")).toBe(false);
    expect(isUsageLockoutError('HTTP 429 Too Many Requests')).toBe(false);
    expect(isUsageLockoutError('API error: 529 overloaded')).toBe(false);
    expect(isUsageLockoutError('')).toBe(false);
    expect(isUsageLockoutError(null)).toBe(false);
  });
});

describe('when it ends (the parse)', () => {
  it('"try again at 8:54 PM" — the next such local time', () => {
    expect(lockoutUntilFromError(CODEX, FAILED)).toBe(new Date(2026, 10, 2, 20, 54, 0).getTime());
  });
  it('a time already past today is tomorrow', () => {
    const late = new Date(2026, 10, 2, 21, 0, 0).getTime();
    expect(lockoutUntilFromError(CODEX, late)).toBe(new Date(2026, 10, 3, 20, 54, 0).getTime());
  });
  it('"try again in 45 minutes" and "in 2 hours 5 minutes"', () => {
    expect(lockoutUntilFromError('You’ve hit your usage limit, try again in 45 minutes.', FAILED)).toBe(FAILED + 45 * MIN);
    expect(lockoutUntilFromError('Usage limit reached. Try again in 2 hours 5 minutes', FAILED)).toBe(FAILED + 125 * MIN);
  });
  it('an epoch ("usage limit reached|<seconds>")', () => {
    const at = Math.floor((FAILED + 3 * 60 * MIN) / 1000);
    expect(lockoutUntilFromError(`Claude AI usage limit reached|${at}`, FAILED)).toBe(at * 1000);
  });
  it('a dated time ("try again at Nov 3rd, 2026 9:15 AM")', () => {
    expect(lockoutUntilFromError('You’ve hit your usage limit. Try again at Nov 3rd, 2026 9:15 AM.', FAILED)).toBe(
      new Date(2026, 10, 3, 9, 15, 0).getTime(),
    );
  });
  it('an ISO-8601 time ("try again at 2026-11-02T20:54:00Z", and a local one)', () => {
    expect(lockoutUntilFromError('You’ve hit your usage limit. Try again at 2026-11-02T22:54:00Z.', FAILED)).toBe(
      Date.parse('2026-11-02T22:54:00Z'),
    );
    expect(lockoutUntilFromError('Usage limit reached; resets at 2026-11-02 21:10', FAILED)).toBe(
      new Date(2026, 10, 2, 21, 10, 0).getTime(),
    );
  });
  it('no time named ⇒ the default hour', () => {
    expect(lockoutUntilFromError('You’ve hit your usage limit.', FAILED)).toBe(FAILED + LOCKOUT_DEFAULT_MS);
  });
  it('not a usage limit ⇒ null', () => {
    expect(lockoutUntilFromError('rate limit, try again in 5 minutes', FAILED)).toBeNull();
  });
});

describe('the lock', () => {
  it('holds until the reset, then is forgotten', () => {
    noteProviderFailure('codex', CODEX, FAILED);
    const until = new Date(2026, 10, 2, 20, 54, 0).getTime();
    expect(usageLockout('codex', FAILED + MIN)).toEqual({ untilMs: until });
    expect(isLockedOut('claude', FAILED + MIN)).toBe(false);
    expect(usageLockedUntilIso('codex', FAILED + MIN)).toBe(new Date(until).toISOString());
    expect(anyUsageLockout(FAILED + MIN)).toBe(true);
    expect(isLockedOut('codex', until)).toBe(false);
    expect(anyUsageLockout(until)).toBe(false);
  });
  it('another kind of failure never locks', () => {
    noteProviderFailure('codex', 'Codex stopped with an error (exit 1).', FAILED);
    expect(isLockedOut('codex', FAILED)).toBe(false);
  });
  it('an earlier reset never shortens a longer lock', () => {
    noteProviderFailure('codex', 'usage limit, try again in 3 hours', FAILED);
    noteProviderFailure('codex', 'usage limit, try again in 10 minutes', FAILED);
    expect(usageLockout('codex', FAILED)?.untilMs).toBe(FAILED + 180 * MIN);
  });
  it('the boot re-derives it from stored failures, and drops one already over', async () => {
    const now = Date.now();
    await restoreUsageLockouts(async () => [
      { provider: 'codex', error: 'You’ve hit your usage limit. Try again in 30 minutes', finishedAtMs: now - 5 * MIN },
      { provider: 'claude', error: 'You’ve hit your usage limit. Try again in 10 minutes', finishedAtMs: now - 60 * MIN },
    ]);
    expect(isLockedOut('codex', now)).toBe(true);
    expect(isLockedOut('claude', now)).toBe(false);
  });
});

describe('which providers an AUTOMATIC run uses', () => {
  const ready = () => true;
  const lockedCodex = (p: string) => p === 'codex';
  const none = () => false;
  it('a pair with Codex locked out runs Claude alone', () => {
    expect(automaticRunProviders({ defaultProvider: 'claude', pair: true, order: ['claude', 'codex'], ready, locked: lockedCodex })).toEqual(['claude']);
  });
  it('a pair with nothing locked runs both', () => {
    expect(automaticRunProviders({ defaultProvider: 'claude', pair: true, order: ['claude', 'codex'], ready, locked: none })).toEqual(['claude', 'codex']);
  });
  it('a single run on a locked Codex default moves to Claude when Claude is ready', () => {
    expect(automaticRunProviders({ defaultProvider: 'codex', pair: false, order: ['claude', 'codex'], ready, locked: lockedCodex })).toEqual(['claude']);
  });
  it('…and is skipped when Claude is not ready, or locked too', () => {
    expect(
      automaticRunProviders({ defaultProvider: 'codex', pair: false, order: ['claude', 'codex'], ready: (p) => p === 'codex', locked: lockedCodex }),
    ).toEqual([]);
    expect(automaticRunProviders({ defaultProvider: 'codex', pair: false, order: ['claude', 'codex'], ready, locked: () => true })).toEqual([]);
    expect(automaticRunProviders({ defaultProvider: 'claude', pair: true, order: ['claude', 'codex'], ready, locked: () => true })).toEqual([]);
  });
  it('an unlocked default runs as before', () => {
    expect(automaticRunProviders({ defaultProvider: 'codex', pair: false, order: ['claude', 'codex'], ready, locked: none })).toEqual(['codex']);
  });
});

describe('the gates read it', () => {
  it('the automatic-run gate refuses a locked provider, allows the other', async () => {
    noteProviderFailure('codex', 'You’ve hit your usage limit. Try again in 30 minutes', Date.now());
    expect(await automaticRunAllowed({}, 1, 'test', 'codex')).toBe(false);
    expect(await automaticRunAllowed({}, 1, 'test', 'claude')).toBe(true);
    // null: the caller (the auto-review sweep) picks the provider later — only the budget is asked,
    // or a locked DEFAULT would stop the whole sweep and its items could never move to Claude.
    expect(await automaticRunAllowed({}, 1, 'test', null)).toBe(true);
  });
  it('the retry rule does not retry a usage limit while its provider is locked out — even when the default changed', () => {
    const until = FAILED + 51 * MIN;
    const base = { attempts: 1, failedAtMs: FAILED, error: CODEX, failedProvider: 'codex' as const, currentProvider: 'claude' as const };
    expect(autoReviewDue({ nowMs: FAILED + MIN, settle: null, retry: { ...base, lockedUntilMs: until } })).toEqual({
      due: false,
      reason: 'retry_wait',
      retryAtMs: until,
    });
    // Once the lock is over, the existing rules decide (here: the default changed ⇒ due).
    expect(autoReviewDue({ nowMs: until + 1, settle: null, retry: { ...base, lockedUntilMs: null } })).toEqual({ due: true });
    // A reader's press is never held.
    expect(autoReviewDue({ nowMs: FAILED + MIN, settle: null, retry: { ...base, lockedUntilMs: until }, pressed: true })).toEqual({ due: true });
  });
});
