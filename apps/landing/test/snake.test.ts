// The snake beside the review story (src/components/board/snake.ts): one unbroken line
// through boxes that stand apart, alternating sides, dropping from each far corner to
// the box below, every bend one radius.
import { describe, expect, it } from 'vitest';
import { snakeMask, snakePath } from '../src/components/board/snake';

// four boxes, 32 apart, in a column 400 wide; corner radius 14, stroke 2 → bends of 13
const boxes = [
  { top: 0, bottom: 100 },
  { top: 132, bottom: 232 },
  { top: 264, bottom: 364 },
  { top: 396, bottom: 496 },
];

describe('the snake', () => {
  const d = snakePath(boxes, 400, 14, 2);

  it('is ONE path: a single move, then only lines and arcs', () => {
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.replace(/^M[\d. ]+/, '')).toMatch(/^([LA][\d. -]+)+$/);
  });

  it('starts round the first box’s top-right corner, then along its top', () => {
    expect(d).toMatch(/^M399 14A13 13 0 0 0 386 1L14 1A13 13 0 0 0 1 14/);
  });

  it('bends with one radius everywhere: the boxes’ corners and each crossing', () => {
    const arcs = d.match(/A[\d.]+ [\d.]+/g) ?? [];
    // the first box's two top corners, a bottom corner per box, one drop per gap, the last far corner
    expect(arcs).toHaveLength(2 + boxes.length + (boxes.length - 1) + 1);
    expect(new Set(arcs)).toEqual(new Set(['A13 13']));
  });

  it('runs down alternate sides and ends round the last box’s far bottom corner', () => {
    expect(d).toContain('L1 86'); // box 1 down the left
    expect(d).toContain('L399 218'); // box 2 down the right
    expect(d.endsWith('L14 495A13 13 0 0 1 1 482')).toBe(true); // box 4 (right side) ends round its bottom-left
  });

  it('drops to the box below from the far corner of the box above', () => {
    // box 1 → 2: along the bottom to x = 399 − 13, bend down to the right edge, straight down
    expect(d).toContain('L386 99A13 13 0 0 1 399 112L399 218');
    // box 2 → 3: the same on the left
    expect(d).toContain('L14 231A13 13 0 0 0 1 244L1 350');
  });

  it('makes a mask the size of the column', () => {
    const m = snakeMask(boxes, 400, 520, 14, 2);
    expect(m.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(m)).toContain('viewBox="0 0 400 520"');
    expect(snakePath([], 400, 14, 2)).toBe('');
  });
});
