// The "sprint has changed" rule behind This Sprint's quiet Refresh line.
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { sprintTokenChanged } from '../src/lib/sprintChangeToken.js';

const base = { seed: 'a', token: 'a', tokenUpdatedAt: 2_000, graphUpdatedAt: 1_000, graphFetching: false };

describe('sprintTokenChanged', () => {
  it('the same token says nothing', () => expect(sprintTokenChanged(base)).toBe(false));
  it('a newer, different token suggests a refresh', () => expect(sprintTokenChanged({ ...base, token: 'b' })).toBe(true));
  it('a token older than a refetched graph says nothing (right after the reader’s own Refresh)', () =>
    expect(sprintTokenChanged({ ...base, token: 'b', tokenUpdatedAt: 500 })).toBe(false));
  it('a token read at the same moment as the graph (the seed) says nothing', () =>
    expect(sprintTokenChanged({ ...base, token: 'b', tokenUpdatedAt: 1_000 })).toBe(false));
  it('a missing token (an older server answers {}) says nothing', () =>
    expect(sprintTokenChanged({ ...base, token: undefined })).toBe(false));
  it('a graph with no token says nothing', () => expect(sprintTokenChanged({ ...base, seed: undefined, token: 'b' })).toBe(false));
  it('says nothing while the graph is being refetched (no flash on a remount)', () =>
    expect(sprintTokenChanged({ ...base, token: 'b', graphFetching: true })).toBe(false));
});
