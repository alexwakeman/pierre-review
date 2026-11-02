// The agent's live log (components/AgentActivityLog.tsx): merging the server's rolling windows into one
// held log, and the follow-the-bottom rule.
import { describe, expect, it } from 'vitest';
import { expandedLogHeight, isScrolledToBottom, mergeActivityWindow } from '../src/lib/agentActivityLog.js';

describe('mergeActivityWindow', () => {
  it('takes the first window whole', () => {
    expect(mergeActivityWindow([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('appends only the lines after the overlap when the window slides', () => {
    expect(mergeActivityWindow(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps lines the window has dropped (the expanded log holds more than the window)', () => {
    let held: readonly string[] = [];
    const all = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    for (let end = 1; end <= all.length; end += 3) held = mergeActivityWindow(held, all.slice(Math.max(0, end - 25), end));
    held = mergeActivityWindow(held, all.slice(-25));
    expect(held).toEqual(all);
  });

  it('is idempotent and returns the same array when nothing is new', () => {
    const held = ['a', 'b', 'c'];
    expect(mergeActivityWindow(held, ['b', 'c'])).toBe(held);
    expect(mergeActivityWindow(held, [])).toBe(held);
    const once = mergeActivityWindow(held, ['c', 'd']);
    expect(mergeActivityWindow(once, ['c', 'd'])).toBe(once);
  });

  it('takes the LONGEST overlap when lines repeat', () => {
    expect(mergeActivityWindow(['x', 'y', 'x', 'y'], ['x', 'y', 'z'])).toEqual(['x', 'y', 'x', 'y', 'z']);
    expect(mergeActivityWindow(['a', 'a'], ['a', 'a', 'b'])).toEqual(['a', 'a', 'b']);
  });

  it('appends a window with no overlap whole (more than a window arrived between polls)', () => {
    expect(mergeActivityWindow(['a', 'b'], ['x', 'y'])).toEqual(['a', 'b', 'x', 'y']);
  });

  it('drops the oldest lines past the cap', () => {
    expect(mergeActivityWindow(['a', 'b', 'c'], ['c', 'd', 'e'], 4)).toEqual(['b', 'c', 'd', 'e']);
    expect(mergeActivityWindow([], ['a', 'b', 'c'], 2)).toEqual(['b', 'c']);
  });
});

describe('isScrolledToBottom', () => {
  it('follows at the bottom and within the slack', () => {
    expect(isScrolledToBottom(400, 100, 500)).toBe(true);
    expect(isScrolledToBottom(394, 100, 500)).toBe(true);
  });
  it('stops following once the reader scrolls up', () => {
    expect(isScrolledToBottom(300, 100, 500)).toBe(false);
  });
  it('a log shorter than its box is at the bottom', () => {
    expect(isScrolledToBottom(0, 128, 60)).toBe(true);
  });
});

describe('expandedLogHeight', () => {
  it('fills the room below it when that is most of the pane', () => {
    expect(expandedLogHeight(900, 700)).toBe(676);
  });
  it('takes at least 60% of the pane when opened low down', () => {
    expect(expandedLogHeight(900, 200)).toBe(540);
  });
  it('never taller than the pane less a margin, never below the floor, nothing without a pane', () => {
    expect(expandedLogHeight(900, 2000)).toBe(804);
    expect(expandedLogHeight(300, 100)).toBe(240);
    expect(expandedLogHeight(null, 500)).toBeNull();
  });
});
