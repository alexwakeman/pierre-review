// THE CI REVIEW'S KEY AND CURRENCY (currency.ts) — pure. What this pins:
//   1. The failing-set key ignores order, blanks and duplicates; nothing failing has no key.
//   2. Currency reads the SYNCED head and failing set, and accepts EITHER of a run's keys (the live
//      set it read, the synced set that started it), so a lagging sync never reads as stale.
//   3. ⚠ Due = something failing and no run already took exactly this head + set (a refusal and a
//      cancelled run count — they would only stop the same way again); a run in flight WAITS.
//
//   pnpm --filter @pierre-review/backend test ci-review/currency
import { describe, expect, it } from 'vitest';
import { ciReviewDue, countItems, deriveCiReviewState, failingKey, normaliseFailingNames, type CiStateInputs, type SyncedCi } from './currency.js';

const K = failingKey(['test', 'lint'])!;
const synced = (over: Partial<SyncedCi> = {}): SyncedCi => ({
  headSha: 'h1',
  failingKey: K,
  failingChecks: ['lint', 'test'],
  passing: false,
  ...over,
});
const counts = { failing: 2, explained: 1, fixableInPr: 1, notChecked: 1 };
const inputs = (over: Partial<CiStateInputs> = {}): CiStateInputs => ({
  latest: { id: 5, headSha: 'h1', failingKey: K, triggerKey: null, counts, completedAt: new Date('2026-10-05T10:00:00Z') },
  runningRunId: null,
  latestAttempt: { id: 5, headSha: 'h1', failingKey: K, triggerKey: null, status: 'succeeded', refused: null },
  ...over,
});

describe('failingKey', () => {
  it('is order-, blank- and duplicate-insensitive; empty has no key', () => {
    expect(failingKey(['lint', 'test'])).toBe(K);
    expect(failingKey([' test ', 'lint', 'lint', '', null])).toBe(K);
    expect(failingKey([])).toBeNull();
    expect(failingKey(['test'])).not.toBe(K);
    expect(normaliseFailingNames(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('counts explained and fixable items', () => {
    expect(
      countItems([
        { status: 'diagnosed', fixableInPr: true },
        { status: 'diagnosed', fixableInPr: false },
        { status: 'not_checked', fixableInPr: null },
      ]),
    ).toEqual({ failing: 3, explained: 2, fixableInPr: 1, notChecked: 1 });
  });
});

describe('deriveCiReviewState', () => {
  it('current for the same head and set; stale when pushed, changed or now passing', () => {
    expect(deriveCiReviewState(1, inputs(), synced()).status).toBe('current');
    expect(deriveCiReviewState(1, inputs(), synced({ headSha: 'h2' }))).toMatchObject({ status: 'stale', staleBecause: 'pushed' });
    expect(deriveCiReviewState(1, inputs(), synced({ failingKey: failingKey(['test']) }))).toMatchObject({
      status: 'stale',
      staleBecause: 'checks_changed',
    });
    expect(deriveCiReviewState(1, inputs(), synced({ failingKey: null, passing: true }))).toMatchObject({
      status: 'stale',
      staleBecause: 'now_passing',
    });
    // Re-running (nothing failing, not green yet): nothing shows the run moved.
    expect(deriveCiReviewState(1, inputs(), synced({ failingKey: null })).status).toBe('current');
  });

  it('accepts the trigger key: a lagging sync never reads as stale', () => {
    const lag = failingKey(['test'])!;
    const inp = inputs({ latest: { ...inputs().latest!, triggerKey: lag } });
    expect(deriveCiReviewState(1, inp, synced({ failingKey: lag })).status).toBe('current');
  });

  it('running wins; none without a success; a refusal at the current head is said', () => {
    expect(deriveCiReviewState(1, inputs({ runningRunId: 9 }), synced()).status).toBe('running');
    const refused = inputs({
      latest: null,
      latestAttempt: { id: 6, headSha: 'h1', failingKey: K, triggerKey: K, status: 'failed', refused: 'no_logs' },
    });
    expect(deriveCiReviewState(1, refused, synced())).toMatchObject({ status: 'none', refused: 'no_logs', counts: null });
    expect(deriveCiReviewState(1, refused, synced({ headSha: 'h2' })).refused).toBeNull();
    expect(deriveCiReviewState(1, undefined, undefined)).toMatchObject({ prId: 1, status: 'none', latestRunId: null });
    expect(deriveCiReviewState(1, inputs(), synced()).checkedAt).toBe('2026-10-05T10:00:00.000Z');
  });
});

describe('ciReviewDue', () => {
  it('not due when nothing fails, a run is in flight, or a run already took this head + set', () => {
    expect(ciReviewDue(inputs(), synced())).toBe(false);
    expect(ciReviewDue(inputs(), synced({ failingKey: null }))).toBe(false);
    expect(ciReviewDue(inputs({ runningRunId: 3 }), synced({ headSha: 'h2' }))).toBe(false);
  });

  it('⚠ due at once on a new head or a changed set — no settle, no CI hold', () => {
    expect(ciReviewDue(inputs(), synced({ headSha: 'h2' }))).toBe(true);
    expect(ciReviewDue(inputs(), synced({ failingKey: failingKey(['test', 'lint', 'e2e']) }))).toBe(true);
    expect(ciReviewDue(undefined, synced())).toBe(true);
  });

  it('a refusal or a cancel on exactly these inputs is not retried; a THROWN run (no keys) is', () => {
    const at = (status: 'failed' | 'cancelled', key: string | null) =>
      inputs({ latest: null, latestAttempt: { id: 7, headSha: 'h1', failingKey: key, triggerKey: null, status, refused: null } });
    expect(ciReviewDue(at('failed', K), synced())).toBe(false);
    expect(ciReviewDue(at('cancelled', K), synced())).toBe(false);
    expect(ciReviewDue(at('failed', null), synced())).toBe(true);
  });
});
