import { describe, expect, it } from 'vitest';
import {
  addStoryBuildDismissal,
  pruneStoryBuildDismissals,
  STORY_BUILD_DISMISS_MAX,
  visibleStoryBuilds,
} from '../src/lib/storyBuildDismiss.js';

const row = (id: number, gate: 'plan' | 'push' | 'paused' | 'failed' | 'ticket' | null) => ({ id, gate });

describe('the builds toast: dismissing a failed build', () => {
  it('hides a dismissed failed build, and only that one', () => {
    const builds = [row(3, 'failed'), row(2, 'failed'), row(1, null)];
    expect(visibleStoryBuilds(builds, [3]).map((b) => b.id)).toEqual([2, 1]);
    expect(visibleStoryBuilds(builds, []).map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it('never hides a build that is not failed, even with its id dismissed', () => {
    expect(visibleStoryBuilds([row(4, 'plan'), row(5, null)], [4, 5]).map((b) => b.id)).toEqual([4, 5]);
  });

  it('a new failure of the same story is a new build id, so it shows', () => {
    // Build 7 failed and was dismissed; the next attempt of the story (build 9) failed too.
    expect(visibleStoryBuilds([row(9, 'failed'), row(7, 'failed')], [7]).map((b) => b.id)).toEqual([9]);
  });

  it('drops a dismissal once its build is listed NOT failed, so a later failure shows', () => {
    expect(pruneStoryBuildDismissals([7, 8], [row(7, null), row(8, 'failed')])).toEqual([8]);
    // An id not listed (the server lists the newest 25) is kept.
    expect(pruneStoryBuildDismissals([1, 2], [])).toEqual([1, 2]);
  });

  it('adds without duplicates and stays bounded', () => {
    expect(addStoryBuildDismissal([1, 2], 2)).toEqual([1, 2]);
    expect(addStoryBuildDismissal([1], 3)).toEqual([1, 3]);
    const many = Array.from({ length: STORY_BUILD_DISMISS_MAX }, (_, i) => i);
    const next = addStoryBuildDismissal(many, 9999);
    expect(next).toHaveLength(STORY_BUILD_DISMISS_MAX);
    expect(next[0]).toBe(1);
    expect(next.at(-1)).toBe(9999);
  });
});
