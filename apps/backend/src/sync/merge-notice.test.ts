import { beforeEach, describe, expect, it } from 'vitest';
import {
  MERGE_NOTICE_WINDOW_MS,
  isLiveMergeObservation,
  noteLiveMergeTransition,
  resetMergeNoticesForTest,
} from './merge-notice.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW - ms);

describe('isLiveMergeObservation — the merge event hook fires only for merges SEEN live', () => {
  beforeEach(() => resetMergeNoticesForTest());

  it('an open row coming back merged, recently, is live', () => {
    expect(
      isLiveMergeObservation({ accountId: 1, prId: 5, prevState: 'open', mergedAt: ago(60_000), nowMs: NOW }),
    ).toBe(true);
  });

  it('a first sighting (first sync / deep backfill) is never live', () => {
    expect(
      isLiveMergeObservation({ accountId: 1, prId: 5, prevState: null, mergedAt: ago(60_000), nowMs: NOW }),
    ).toBe(false);
  });

  it('a re-walk of an already-merged row is silent', () => {
    expect(
      isLiveMergeObservation({ accountId: 1, prId: 5, prevState: 'merged', mergedAt: ago(60_000), nowMs: NOW }),
    ).toBe(false);
  });

  it('an old merge (an outage, then a re-walk) is silent', () => {
    expect(
      isLiveMergeObservation({
        accountId: 1, prId: 5, prevState: 'open', mergedAt: ago(MERGE_NOTICE_WINDOW_MS + 1), nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('the liveness sweep flipped it first: the walk still announces it, once', () => {
    noteLiveMergeTransition(1, 5, NOW - 1000);
    const args = { accountId: 1, prId: 5, prevState: 'merged', mergedAt: ago(60_000), nowMs: NOW };
    expect(isLiveMergeObservation(args)).toBe(true);
    expect(isLiveMergeObservation(args)).toBe(false);
    // Another account's same PR id is a different key.
    noteLiveMergeTransition(2, 5, NOW - 1000);
    expect(isLiveMergeObservation({ ...args, accountId: 1 })).toBe(false);
  });
});
