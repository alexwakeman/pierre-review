// The PURE folds over `codex app-server`'s answers (ai/codex/readings.ts), against the shapes the
// spike recorded from 0.164.0 (docs/CODEX-SPIKE.md § 6) — never a live process.
//
//   pnpm --filter @pierre-review/backend test ai/codex/readings
import { describe, expect, it } from 'vitest';
import {
  accountTokensInWindow,
  parseBucketStart,
  parseCodexAccount,
  parseCodexTokenUsage,
  readingFromCodexRateLimits,
} from './readings.js';

// Recorded from the spike's `account/rateLimits/read` (rl-0.txt), with usedPercent moved off 0.
const RATE_LIMITS = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1792939601 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1793526401 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'plus',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {},
  rateLimitResetCredits: { availableCount: 0, credits: [] },
  accountId: 'x',
  rateLimitUpsell: null,
};

describe('account/read', () => {
  it('a ChatGPT account is signed in, with its plan', () => {
    expect(parseCodexAccount({ account: { type: 'chatgpt', email: 'a@b', planType: 'plus' }, requiresOpenaiAuth: true })).toEqual({
      signedIn: true,
      type: 'chatgpt',
      plan: 'plus',
    });
  });
  it('`account: null` is the ONE signed-out answer (a dead January sign-in read this way)', () => {
    expect(parseCodexAccount({ account: null, requiresOpenaiAuth: true })).toEqual({ signedIn: false, type: null, plan: null });
  });
  it('an API key stored in the home is signed in with no plan; an unknown plan is no plan', () => {
    expect(parseCodexAccount({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toEqual({ signedIn: true, type: 'apiKey', plan: null });
    expect(parseCodexAccount({ account: { type: 'chatgpt', email: null, planType: 'unknown' } })?.plan).toBeNull();
  });
  it('an unrecognised shape is no reading, never a throw', () => {
    for (const raw of [null, 7, 'x', [], {}, { account: 'nope' }, { account: { planType: 'plus' } }]) {
      expect(parseCodexAccount(raw)).toBeNull();
    }
  });
});

describe('account/rateLimits/read → one AiUsageReading', () => {
  it('maps the 300-minute window to fiveHour and the 10080-minute one to week, resets in ms', () => {
    expect(readingFromCodexRateLimits(RATE_LIMITS, 1000)).toEqual({
      fiveHour: { utilization: 1, resetsAtMs: 1792939601000, observedAtMs: 1000 },
      week: { utilization: 0, resetsAtMs: 1793526401000, observedAtMs: 1000 },
      subscriptionType: 'plus',
    });
  });
  it('maps by LENGTH, not by the primary/secondary naming', () => {
    const swapped = {
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2 },
        secondary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1 },
        planType: 'pro',
      },
    };
    const r = readingFromCodexRateLimits(swapped, 0);
    expect(r?.week?.utilization).toBe(40);
    expect(r?.fiveHour?.utilization).toBe(3);
  });
  it('no window it knows ⇒ no reading', () => {
    expect(readingFromCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 60 } } }, 0)).toBeNull();
    expect(readingFromCodexRateLimits({}, 0)).toBeNull();
    expect(readingFromCodexRateLimits(null, 0)).toBeNull();
  });
});

describe('account/usage/read', () => {
  it('reads the lifetime count and the daily buckets (a bare date is that UTC day)', () => {
    expect(
      parseCodexTokenUsage({
        summary: { lifetimeTokens: 420000, currentStreakDays: 1 },
        dailyUsageBuckets: [{ startDate: '2026-10-25', tokens: 9000 }, { startDate: 'garbage', tokens: 1 }, { tokens: 3 }],
      }),
    ).toEqual({ lifetimeTokens: 420000, daily: [{ startMs: Date.UTC(2026, 9, 25), tokens: 9000 }] });
    expect(parseBucketStart('2026-10-25T00:00:00-07:00')).toBe(Date.UTC(2026, 9, 25, 7));
  });
  it('missing pieces are null, an unknown shape is no reading', () => {
    expect(parseCodexTokenUsage({ summary: {} })).toEqual({ lifetimeTokens: null, daily: null });
    expect(parseCodexTokenUsage({})).toBeNull();
  });
});

describe("the account's tokens in a window — WITH the span they cover", () => {
  const H = 3600_000;
  const D = 24 * H;
  const M = 60_000;
  const T0 = Date.UTC(2026, 9, 20);
  it('EXACT from a sample taken just before the window opened (within the probe interval + slack)', () => {
    const samples = [
      { atMs: T0 - 4 * M, lifetimeTokens: 1000 },
      { atMs: T0 + H, lifetimeTokens: 1300 },
      { atMs: T0 + 3 * H, lifetimeTokens: 1600 },
    ];
    expect(accountTokensInWindow(samples, null, T0, T0 + 4 * H)).toEqual({ tokens: 600, fromMs: T0 - 4 * M, inclusive: false });
    // The newest sample at or before the window's END: one taken later is not counted.
    expect(accountTokensInWindow(samples, null, T0, T0 + 2 * H)).toEqual({ tokens: 300, fromMs: T0 - 4 * M, inclusive: false });
  });
  it('a start sample OLDER than the limit is not the window’s start: the inside samples give a shorter span', () => {
    // The sample days before the window would count the account's use before it (Limn's share too small).
    const samples = [
      { atMs: T0 - 2 * D, lifetimeTokens: 0 },
      { atMs: T0 + H, lifetimeTokens: 50_000 },
      { atMs: T0 + 2 * H, lifetimeTokens: 50_080 },
    ];
    expect(accountTokensInWindow(samples, null, T0, T0 + 3 * H)).toEqual({ tokens: 80, fromMs: T0 + H, inclusive: false });
    // With a single inside sample there is nothing to say: unknown.
    expect(accountTokensInWindow(samples.slice(0, 2), null, T0, T0 + 3 * H)).toBeNull();
  });
  it('a 5-hour window with no sample before it is UNKNOWN — never a whole day from the buckets', () => {
    const daily = [{ startMs: T0, tokens: 99_999 }];
    expect(accountTokensInWindow([{ atMs: T0 + 2 * H, lifetimeTokens: 5 }], daily, T0 + H, T0 + 6 * H)).toBeNull();
  });
  it('a week with no early sample falls back to the daily buckets that overlap it, from the first bucket’s start', () => {
    const daily = [
      { startMs: T0 - 8 * D, tokens: 1 }, // before the week
      { startMs: T0 - D, tokens: 10 }, // overlaps its first hours
      { startMs: T0 + 3 * D, tokens: 100 },
    ];
    expect(accountTokensInWindow([], daily, T0 - 12 * H, T0 + 7 * D - 12 * H)).toEqual({ tokens: 110, fromMs: T0 - D, inclusive: true });
  });
  it('EMPTY daily buckets are unknown, not zero (a Plus account answered [] while it had used tokens)', () => {
    expect(accountTokensInWindow([], [], T0, T0 + 7 * D)).toBeNull();
  });
  it('nothing known ⇒ null', () => {
    expect(accountTokensInWindow([], null, T0, T0 + 7 * D)).toBeNull();
    expect(accountTokensInWindow([], [], T0, T0)).toBeNull();
  });
});

