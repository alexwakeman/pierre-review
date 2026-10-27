// THE AUTO-REVIEW RETRY RULE — `autoReviewDue`'s retry branch (auto.ts) and its pure inputs
// (auto-retry.ts). Every branch:
//   • a FINAL failure (unknown, a budget or turn cap, a 406 diff) is never retried by itself;
//   • a TRANSIENT one waits 1 h after the first failure, 4 h after later ones;
//   • a USAGE LIMIT waits for the reset the error (or the usage reading) names, not the backoff;
//   • a change of DEFAULT provider makes it due at once;
//   • at most AUTO_RETRY_MAX_ATTEMPTS auto rows per (PR, head);
//   • a reader's PRESS waives all of it, except a run in flight.
//
//   pnpm --filter @pierre-review/backend test claude-review/auto-retry
import { describe, expect, it, vi } from 'vitest';

vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  dropAutoReviews: () => 0,
  autoLaneRoom: () => 20,
  autoPendingPrIds: () => new Set(),
  enqueueAutoReview: () => 'queued',
}));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));
vi.mock('./auto-settings.js', () => ({ listAutoReviewWorkspaces: async () => [] }));

const { autoReviewDue } = await import('./auto.js');
const {
  AUTO_RETRY_BACKOFF_FIRST_MS,
  AUTO_RETRY_BACKOFF_LATER_MS,
  AUTO_RETRY_MAX_ATTEMPTS,
  classifyAutoReviewFailure,
  parseRetryAtMs,
  usageResetFromReading,
} = await import('./auto-retry.js');

const HOUR = 3_600_000;
// A local-time anchor, so "5:04 PM" means the same on every machine running the suite.
const FAILED = new Date(2026, 9, 27, 16, 0, 0, 0).getTime();
const CODEX_LIMIT =
  'Codex could not finish: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:04 PM.';

describe('classifyAutoReviewFailure', () => {
  it.each([
    [CODEX_LIMIT, 'usage_limit'],
    ['Claude AI usage limit reached|1793040000', 'usage_limit'],
    ['API Error: 429 rate_limit_error', 'usage_limit'],
    ['API Error: 529 {"type":"overloaded_error"}', 'transient'],
    ['API Error: 503 Service Unavailable', 'transient'],
    ['interrupted by restart', 'transient'],
    ['Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed', 'transient'],
    ['request timed out', 'transient'],
    ['fetch failed: ECONNRESET', 'transient'],
    ['Codex is not signed in.', 'transient'],
    ['Claude Code returned an error result: Reached maximum budget ($1.5)', 'final'],
    ['Claude Code returned an error result: Reached maximum number of turns (30)', 'final'],
    ['Command failed: gh pr diff 131\ncould not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum', 'final'],
    ['The review did not match the schema after a retry.', 'final'],
    ['review failed', 'final'],
    ['', 'final'],
    [null, 'final'],
  ] as const)('%s → %s', (error, kind) => {
    expect(classifyAutoReviewFailure(error)).toBe(kind);
  });

  it('does not read a dollar figure as a 5xx', () => {
    expect(classifyAutoReviewFailure('Reached maximum budget ($500)')).toBe('final');
  });
});

describe('parseRetryAtMs', () => {
  it('reads Codex’s "try again at 5:04 PM" as the next 5:04 PM after the failure, local time', () => {
    expect(parseRetryAtMs(CODEX_LIMIT, FAILED)).toBe(new Date(2026, 9, 27, 17, 4).getTime());
  });
  it('rolls a time already past on the failure’s day to the next day', () => {
    expect(parseRetryAtMs('try again at 9:15 AM.', FAILED)).toBe(new Date(2026, 9, 28, 9, 15).getTime());
  });
  it('reads a dated reset', () => {
    expect(parseRetryAtMs('try again at Oct 29th, 2026 5:04 PM.', FAILED)).toBe(new Date(2026, 9, 29, 17, 4).getTime());
  });
  it('reads Claude’s epoch suffix (seconds)', () => {
    expect(parseRetryAtMs('Claude AI usage limit reached|1793040000', FAILED)).toBe(1793040000 * 1000);
  });
  it('reads "resets 3pm" and "resets at 17:30"', () => {
    expect(parseRetryAtMs('5-hour limit reached · resets 3pm', FAILED)).toBe(new Date(2026, 9, 28, 15, 0).getTime());
    expect(parseRetryAtMs('limit reached, resets at 17:30', FAILED)).toBe(new Date(2026, 9, 27, 17, 30).getTime());
  });
  it('reads a relative wait', () => {
    expect(parseRetryAtMs('rate limited, try again in 2 hours 5 minutes', FAILED)).toBe(FAILED + 2 * HOUR + 5 * 60_000);
  });
  it('names nothing when the error names no time', () => {
    expect(parseRetryAtMs('You’ve hit your usage limit.', FAILED)).toBeNull();
    expect(parseRetryAtMs('resets 3', FAILED)).toBeNull();
    expect(parseRetryAtMs(null, FAILED)).toBeNull();
  });
});

describe('usageResetFromReading', () => {
  const w = (utilization: number | null, resetsAtMs: number | null, observedAtMs = FAILED - HOUR) => ({
    utilization,
    resetsAtMs,
    observedAtMs,
  });
  it('waits for the LATEST reset of the exhausted windows', () => {
    expect(
      usageResetFromReading({ fiveHour: w(100, FAILED + HOUR), week: w(100, FAILED + 48 * HOUR) }, FAILED),
    ).toBe(FAILED + 48 * HOUR);
  });
  it('a reading after the failure with nothing exhausted says the limit had lifted by then', () => {
    expect(usageResetFromReading({ fiveHour: w(12, FAILED + 5 * HOUR, FAILED + 2 * HOUR) }, FAILED)).toBe(
      FAILED + 2 * HOUR,
    );
  });
  it('null when it cannot tell', () => {
    expect(usageResetFromReading(null, FAILED)).toBeNull();
    expect(usageResetFromReading({ fiveHour: w(40, FAILED + HOUR) }, FAILED)).toBeNull();
  });
});

describe('autoReviewDue — the retry branch', () => {
  const retry = (over: Partial<Parameters<typeof autoReviewDue>[0]['retry'] & object> = {}) => ({
    attempts: 1,
    failedAtMs: FAILED,
    error: 'API Error: 529 overloaded',
    failedProvider: 'claude' as const,
    currentProvider: 'claude' as const,
    usageResetAtMs: null,
    ...over,
  });
  const due = (nowMs: number, r = retry(), extra: { inFlight?: boolean; pressed?: boolean } = {}) =>
    autoReviewDue({ nowMs, settle: null, retry: r, ...extra });

  it('a transient failure waits 1 h after the first failure', () => {
    expect(due(FAILED + AUTO_RETRY_BACKOFF_FIRST_MS - 1)).toEqual({
      due: false,
      reason: 'retry_wait',
      retryAtMs: FAILED + AUTO_RETRY_BACKOFF_FIRST_MS,
    });
    expect(due(FAILED + AUTO_RETRY_BACKOFF_FIRST_MS)).toEqual({ due: true });
  });
  it('and 4 h after a later one', () => {
    const r = retry({ attempts: 2 });
    expect(due(FAILED + AUTO_RETRY_BACKOFF_FIRST_MS, r)).toMatchObject({ due: false, reason: 'retry_wait' });
    expect(due(FAILED + AUTO_RETRY_BACKOFF_LATER_MS, r)).toEqual({ due: true });
  });
  it('a final failure is never retried by itself', () => {
    expect(due(FAILED + 100 * HOUR, retry({ error: 'Reached maximum budget ($1.5)' }))).toEqual({
      due: false,
      reason: 'not_retryable',
    });
  });
  it('stops at the attempt cap', () => {
    expect(due(FAILED + 100 * HOUR, retry({ attempts: AUTO_RETRY_MAX_ATTEMPTS }))).toEqual({
      due: false,
      reason: 'attempts_used',
    });
  });
  it('a usage limit waits for the reset the error names — not the 1 h backoff', () => {
    const r = retry({ error: CODEX_LIMIT, failedProvider: 'codex', currentProvider: 'codex' });
    const reset = new Date(2026, 9, 27, 17, 4).getTime();
    expect(due(FAILED + AUTO_RETRY_BACKOFF_FIRST_MS, r)).toEqual({ due: false, reason: 'retry_wait', retryAtMs: reset });
    expect(due(reset, r)).toEqual({ due: true });
  });
  it('a usage limit with no time in the error takes the usage reading’s reset', () => {
    const r = retry({ error: 'You’ve hit your usage limit.', usageResetAtMs: FAILED + 3 * HOUR });
    expect(due(FAILED + 2 * HOUR, r)).toMatchObject({ due: false, retryAtMs: FAILED + 3 * HOUR });
    expect(due(FAILED + 3 * HOUR, r)).toEqual({ due: true });
  });
  it('a usage limit with no known reset falls back to the backoff', () => {
    const r = retry({ error: 'You’ve hit your usage limit.' });
    expect(due(FAILED + AUTO_RETRY_BACKOFF_FIRST_MS, r)).toEqual({ due: true });
  });
  it('a change of default provider is due at once (still under the cap, still transient)', () => {
    const r = retry({ error: CODEX_LIMIT, failedProvider: 'codex', currentProvider: 'claude' });
    expect(due(FAILED + 1, r)).toEqual({ due: true });
    expect(due(FAILED + 1, { ...r, attempts: AUTO_RETRY_MAX_ATTEMPTS })).toMatchObject({ due: false });
  });
  it('a reader’s press waives the backoff, the cap and the transient test — never a run in flight', () => {
    const r = retry({ attempts: 9, error: 'Reached maximum budget ($1.5)' });
    expect(due(FAILED + 1, r, { pressed: true })).toEqual({ due: true });
    expect(due(FAILED + 1, r, { pressed: true, inFlight: true })).toEqual({ due: false, reason: 'retry_wait' });
  });
});

describe('autoReviewDue — a press on a settle wait', () => {
  it('waives the settle wait but never a run in flight', () => {
    const settle = { quietSinceMs: FAILED, burstStartMs: FAILED, reason: 'comments' as const };
    expect(autoReviewDue({ nowMs: FAILED + 1, settle })).toEqual({ due: false, reason: 'comments' });
    expect(autoReviewDue({ nowMs: FAILED + 1, settle, pressed: true })).toEqual({ due: true });
    expect(autoReviewDue({ nowMs: FAILED + 1, settle, pressed: true, inFlight: true })).toEqual({
      due: false,
      reason: 'comments',
    });
  });
});
