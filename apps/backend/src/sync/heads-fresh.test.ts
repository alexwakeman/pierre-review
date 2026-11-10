// THE CATCH-UP GATE'S FOLD (sync/heads-fresh.ts): every repo checked since the gap, no change left
// unwalked (adaptive polling), or synced since the gap (a pinned SYNC_CRON).
//
//   pnpm --filter @pierre-review/backend test sync/heads-fresh
import { describe, expect, it } from 'vitest';
import { headsFresh } from './heads-fresh.js';

describe('headsFresh', () => {
  const SINCE = 1_000;
  it('adaptive: every repo must have been checked clean since the gap', () => {
    const clean = new Set([1, 2]);
    const isClean = (id: number, since: number) => since === SINCE && clean.has(id);
    expect(headsFresh([1, 2], SINCE, true, isClean, new Map())).toBe(true);
    expect(headsFresh([1, 2, 3], SINCE, true, isClean, new Map())).toBe(false);
    expect(headsFresh([], SINCE, true, isClean, new Map())).toBe(true);
  });
  it('a pinned SYNC_CRON: the last completed sync must be at or after the gap', () => {
    const never = () => false;
    expect(headsFresh([1, 2], SINCE, false, never, new Map([[1, SINCE], [2, SINCE + 5]]))).toBe(true);
    expect(headsFresh([1, 2], SINCE, false, never, new Map([[1, SINCE - 1], [2, SINCE + 5]]))).toBe(false);
    expect(headsFresh([1], SINCE, false, never, new Map())).toBe(false);
  });
});
