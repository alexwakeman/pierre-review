import { describe, expect, it } from 'vitest';
import {
  ARROW,
  arrowHeadPath,
  blockReason,
  clampToBand,
  curvePath,
  defaultSelectedRepo,
  draftChanges,
  pendingLine,
  sharesOneOwner,
} from '../src/components/settings/relatedReposGeometry.js';

describe('curvePath', () => {
  it('leaves and arrives flat, ending at the arrowhead base', () => {
    // gap to the base = 100 - 7 = 93 → pull 46.5
    expect(curvePath({ x: 0, y: 10 }, { x: 100, y: 50 })).toBe('M0 10 C46.5 10 46.5 50 93 50');
  });

  it('keeps a minimum pull when the gutter is tiny', () => {
    expect(curvePath({ x: 0, y: 0 }, { x: 10, y: 20 }, 0)).toBe('M0 0 C16 0 -6 20 10 20');
  });

  it('rounds to one decimal', () => {
    expect(curvePath({ x: 0.123, y: 1.06 }, { x: 64.56, y: 2.04 }, 0)).toBe('M0.1 1.1 C32.3 1.1 32.3 2 64.6 2');
  });
});

describe('arrowHeadPath', () => {
  it('points right with its tip on the target', () => {
    expect(arrowHeadPath({ x: 100, y: 50 })).toBe(
      `M${100 - ARROW.length} ${50 - ARROW.halfWidth} L100 50 L${100 - ARROW.length} ${50 + ARROW.halfWidth} Z`,
    );
  });
});

describe('clampToBand', () => {
  it('keeps a visible anchor where it is', () => {
    expect(clampToBand(50, 0, 100, 5)).toEqual({ y: 50, outside: false });
  });
  it('pins a row scrolled above or below to the nearer edge', () => {
    expect(clampToBand(-30, 0, 100, 5)).toEqual({ y: 5, outside: true });
    expect(clampToBand(130, 0, 100, 5)).toEqual({ y: 95, outside: true });
  });
  it('never inverts a band thinner than the inset', () => {
    expect(clampToBand(50, 0, 4, 5)).toEqual({ y: 5, outside: true });
  });
});

describe('draftChanges and pendingLine', () => {
  it('splits the draft into additions and removals', () => {
    expect(draftChanges([1, 2, 3], [3, 4, 1])).toEqual({ added: [4], removed: [2] });
    expect(draftChanges([1], [1])).toEqual({ added: [], removed: [] });
  });
  it('says what is unsaved in one line', () => {
    expect(pendingLine(0, 0)).toBeNull();
    expect(pendingLine(1, 0)).toBe('Not saved: 1 to add.');
    expect(pendingLine(2, 1)).toBe('Not saved: 2 to add, 1 to remove.');
    expect(pendingLine(0, 3)).toBe('Not saved: 3 to remove.');
  });
});

describe('defaultSelectedRepo', () => {
  it('picks the first repo in list order that has a relation', () => {
    expect(defaultSelectedRepo([5, 6, 7], [{ repoId: 7, relatedRepoId: 6 }])).toBe(6);
  });
  it('falls back to the first repo, or null when there are none', () => {
    expect(defaultSelectedRepo([5, 6], [])).toBe(5);
    expect(defaultSelectedRepo([], [])).toBeNull();
  });
});

describe('sharesOneOwner', () => {
  it('is true only when every repo has the same owner', () => {
    expect(sharesOneOwner(['a/x', 'a/y'])).toBe(true);
    expect(sharesOneOwner(['a/x', 'b/y'])).toBe(false);
    expect(sharesOneOwner(['x'])).toBe(false);
  });
});

describe('blockReason', () => {
  it('blocks the selected repo itself', () => {
    expect(blockReason(1, 1, [], false, 8)).toBe('self');
  });
  it('labels only a full PARTNER as full; a full selected repo is the cap', () => {
    expect(blockReason(2, 1, [], true, 8)).toBe('full');
    expect(blockReason(2, 1, [3, 4], false, 2)).toBe('cap');
    expect(blockReason(2, 1, [3, 4], true, 2)).toBe('full');
  });
  it('always lets a linked repo be removed', () => {
    expect(blockReason(3, 1, [3, 4], true, 2)).toBeNull();
    expect(blockReason(2, 1, [3], false, 8)).toBeNull();
  });
});
