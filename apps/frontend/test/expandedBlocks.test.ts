// Who owns Escape while a block is expanded (lib/expandedBlocks.ts): the block, unless a modal stands
// over it; a layer that HOLDS the block (the PR drawer) steps aside.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/expandedBlocks.test.ts
import { describe, expect, it } from 'vitest';
import { escapeReachesBlock, expandedBlockTakesEscape, registerExpandedBlock } from '../src/lib/expandedBlocks.js';

const block = { id: 'block' };
const drawer = { contains: (o: unknown) => o === block };
const settings = { contains: () => false };

describe('escapeReachesBlock', () => {
  it('reaches a block with no modal open', () => {
    expect(escapeReachesBlock(block, [])).toBe(true);
  });
  it('reaches a block inside the only modal (the PR drawer holds it)', () => {
    expect(escapeReachesBlock(block, [drawer])).toBe(true);
  });
  it('not when a modal stands over it (Settings over the page or over the drawer)', () => {
    expect(escapeReachesBlock(block, [settings])).toBe(false);
    expect(escapeReachesBlock(block, [drawer, settings])).toBe(false);
  });
  it('not when the block element is unknown and a modal is open', () => {
    expect(escapeReachesBlock(null, [drawer])).toBe(false);
    expect(escapeReachesBlock(null, [])).toBe(true);
  });
});

describe('expandedBlockTakesEscape', () => {
  it('is false with no block expanded, true while one is, false again once released', () => {
    expect(expandedBlockTakesEscape([drawer])).toBe(false);
    const release = registerExpandedBlock(block);
    expect(expandedBlockTakesEscape([drawer])).toBe(true);
    expect(expandedBlockTakesEscape([])).toBe(true);
    release();
    expect(expandedBlockTakesEscape([drawer])).toBe(false);
  });
  it('a block on the page behind the drawer does not stop the drawer closing', () => {
    const behind = { id: 'behind' };
    const release = registerExpandedBlock(behind);
    expect(expandedBlockTakesEscape([drawer])).toBe(false);
    release();
  });
});
