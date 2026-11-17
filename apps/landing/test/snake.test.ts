// The snake beside the review story (src/components/board/snake.ts): one unbroken line down
// through the boxes, alternating sides, with the same rounded turn everywhere.
import { describe, expect, it } from 'vitest';
import { snakeMask, snakePath } from '../src/components/board/snake';

const boxes = [
  { top: 0, bottom: 100 },
  { top: 116, bottom: 216 },
  { top: 232, bottom: 332 },
  { top: 348, bottom: 448 },
];

describe('the snake', () => {
  const d = snakePath(boxes, 400, 14, 2);

  it('is ONE path: a single move, then only lines and arcs', () => {
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d).toMatch(/^M1 0L1 /);
    expect(d.replace(/^M[\d. ]+/, '')).toMatch(/^([LA][\d. -]+)+$/);
  });

  it('turns with the same radius every time: one corner per box, one drop into each gap', () => {
    const arcs = d.match(/A[\d.]+ [\d.]+/g) ?? [];
    expect(arcs).toHaveLength(boxes.length + (boxes.length - 1));
    expect(new Set(arcs)).toEqual(new Set(['A14 14']));
  });

  it('alternates sides, and ends across the bottom of the last box on its far side', () => {
    // box 1 runs down the left (x = 1), box 2 down the right (x = 399)
    expect(d).toContain('L1 85');
    expect(d).toContain('L399 201');
    expect(d.endsWith('L1 447')).toBe(true); // box 4 runs down the right, ends bottom-left
  });

  it('makes a mask the size of the column', () => {
    const m = snakeMask(boxes, 400, 470, 14, 2);
    expect(m.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(m)).toContain('viewBox="0 0 400 470"');
    expect(snakePath([], 400, 14, 2)).toBe('');
  });
});
