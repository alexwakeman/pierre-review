// THE OPEN PRs WINDOW — the pure half (lib/openPrsWindow.ts): how many cards are drawn, how the
// ticket stacks are cut (whole stacks only), how a jump grows the window, and WHEN it resets.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/openPrsWindow.test.ts

import { describe, expect, it } from 'vitest';
import {
  OPEN_PRS_PAGE,
  limitFor,
  limitToInclude,
  nextLimit,
  openPrsWindowKey,
  settleMemo,
  stacksWithin,
} from '../src/lib/openPrsWindow.js';

describe('the page', () => {
  it('is ten cards', () => {
    expect(OPEN_PRS_PAGE).toBe(10);
  });

  it('grows by one page and never past the total', () => {
    expect(nextLimit(10, 739)).toBe(20);
    expect(nextLimit(20, 739)).toBe(30);
    expect(nextLimit(730, 739)).toBe(739);
    expect(nextLimit(739, 739)).toBe(739);
  });

  it('a short list stays at one page', () => {
    expect(nextLimit(10, 4)).toBe(10);
  });
});

describe('ticket stacks are cut whole', () => {
  it('draws whole stacks until the cards reach the limit', () => {
    // 3 + 4 = 7 < 10, so the third stack is drawn too (12 cards): a stack never shows part of its list.
    expect(stacksWithin([3, 4, 5, 6], 10)).toBe(3);
    expect(stacksWithin([3, 4, 5, 6], 20)).toBe(4);
  });

  it('stops as soon as the limit is reached', () => {
    expect(stacksWithin([5, 5, 5], 10)).toBe(2);
  });

  it('always draws the first stack, however large', () => {
    expect(stacksWithin([40, 1], 10)).toBe(1);
  });

  it('draws nothing when there are no stacks', () => {
    expect(stacksWithin([], 10)).toBe(0);
  });
});

describe('a jump past the window grows it', () => {
  it('a list row: whole pages up to and including it', () => {
    expect(limitToInclude(34, 10)).toBe(40);
    expect(limitToInclude(9, 10)).toBe(10);
    expect(limitToInclude(10, 10)).toBe(20);
  });

  it('a stack: every card before it plus one', () => {
    // Stack 3 starts after 3 + 4 + 5 = 12 cards.
    const sizes = [3, 4, 5, 6];
    const limit = limitToInclude(3, 10, sizes);
    expect(limit).toBe(20);
    expect(stacksWithin(sizes, limit)).toBeGreaterThanOrEqual(4);
  });

  it('never shrinks the window, and a missing target changes nothing', () => {
    expect(limitToInclude(2, 50)).toBe(50);
    expect(limitToInclude(-1, 30)).toBe(30);
  });
});

describe('the reset rules', () => {
  const scope = { workspaceId: 6, repoIds: null };
  const key = openPrsWindowKey(scope, null, false);

  it('a remembered window is kept for the same list (coming back from a PR tab)', () => {
    expect(limitFor({ key, limit: 40 }, key)).toBe(40);
  });

  it('a different list starts at one page', () => {
    const other = openPrsWindowKey({ workspaceId: 7, repoIds: null }, null, false);
    expect(limitFor({ key, limit: 40 }, other)).toBe(10);
    expect(limitFor(null, key)).toBe(10);
  });

  it('settling on a new list forgets the old one, so going back starts at one page', () => {
    const bySize = openPrsWindowKey(scope, { key: 'size', dir: 'desc' }, false);
    const settled = settleMemo({ key, limit: 40 }, bySize);
    expect(settled).toEqual({ key: bySize, limit: 10 });
    expect(limitFor(settled, key)).toBe(10);
  });

  it('settling on the same list keeps the memo object', () => {
    const memo = { key, limit: 40 };
    expect(settleMemo(memo, key)).toBe(memo);
  });

  it('the workspace, repo filter, sort, direction and layout each change the identity', () => {
    const keys = [
      key,
      openPrsWindowKey({ workspaceId: 7, repoIds: null }, null, false),
      openPrsWindowKey({ workspaceId: 6, repoIds: [3] }, null, false),
      openPrsWindowKey(scope, { key: 'size', dir: 'desc' }, false),
      openPrsWindowKey(scope, { key: 'size', dir: 'asc' }, false),
      openPrsWindowKey(scope, null, true),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the repo filter is order-free', () => {
    expect(openPrsWindowKey({ workspaceId: 6, repoIds: [5, 2, 9] }, null, false)).toBe(
      openPrsWindowKey({ workspaceId: 6, repoIds: [9, 5, 2] }, null, false),
    );
  });

  it('an empty repo filter is not "every repo"', () => {
    expect(openPrsWindowKey({ workspaceId: 6, repoIds: [] }, null, false)).not.toBe(key);
  });
});
