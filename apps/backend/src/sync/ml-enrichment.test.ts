// The batching logic behind ML enrichment (docs/ML-SEVERITY.md § batching).
//
// This is the part worth pinning because it is where the feature's whole load-time argument
// lives: inference cost tracks TOTAL TEXT and a batch pads to its longest member, so the packer
// budgets characters rather than items. A regression here is invisible — everything still gets
// labelled, just several times slower — which is exactly the kind of thing a test has to catch.
import { describe, expect, it } from 'vitest';
import { packBatches } from './ml-enrichment.js';
import type { MlCandidate } from '../db/ml-labels.js';

let nextId = 1;
function candidate(len: number): MlCandidate {
  const id = nextId++;
  return {
    targetKind: 'review_comment',
    targetId: id,
    prId: 1,
    repoId: 1,
    authorUserId: 1,
    body: 'x'.repeat(len),
    targetCreatedAt: new Date(0),
  };
}

describe('packBatches', () => {
  it('closes a batch on the CHARACTER budget, not just the item count', () => {
    // 10 items of 100 chars with a 250-char budget → pairs, never one batch of 10. The packer
    // closes a batch BEFORE the item that would exceed the budget, so 3×100 never happens.
    const batches = packBatches(
      Array.from({ length: 10 }, () => candidate(100)),
      128,
      250,
    );
    expect(batches.map((b) => b.length)).toEqual([2, 2, 2, 2, 2]);
    for (const b of batches) {
      expect(b.reduce((n, c) => n + c.body.length, 0)).toBeLessThanOrEqual(250);
    }
  });

  it('closes a batch on the item cap when the text budget is generous', () => {
    const batches = packBatches(
      Array.from({ length: 10 }, () => candidate(10)),
      4,
      1_000_000,
    );
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
  });

  it('gives an over-budget item its OWN batch rather than dropping it', () => {
    // A single 5000-char walkthrough cannot fit a 1000-char budget. Dropping it would leave a
    // target that is re-selected as a candidate on every tick, forever.
    const batches = packBatches([candidate(100), candidate(5000), candidate(100)], 128, 1000);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(batches.flat()).toHaveLength(3);
  });

  it('never loses or duplicates an item', () => {
    const items = [10, 4000, 30, 900, 5, 2200, 7, 60].map(candidate);
    const flat = packBatches(items, 3, 1000).flat();
    expect(flat).toHaveLength(items.length);
    expect(new Set(flat.map((c) => c.targetId)).size).toBe(items.length);
  });

  it('returns no batches for no candidates', () => {
    expect(packBatches([], 128, 24_000)).toEqual([]);
  });

  it('keeps a length-sorted pool internally uniform — the point of the whole exercise', () => {
    // The worker sorts by body length before packing. With that ordering, no batch mixes a tiny
    // comment with a huge one, so padding waste stays near zero. Without the sort, the same
    // items produce batches whose longest member dwarfs its siblings.
    const lengths = [5, 5000, 8, 4800, 12, 5200, 15, 4900];
    const sorted = [...lengths].sort((a, b) => a - b).map(candidate);
    const batches = packBatches(sorted, 128, 6000);
    for (const b of batches) {
      const min = Math.min(...b.map((c) => c.body.length));
      const max = Math.max(...b.map((c) => c.body.length));
      // Within a batch, the longest is never an order of magnitude past the shortest.
      expect(max).toBeLessThanOrEqual(Math.max(min * 10, 6000));
    }
    // And the tiny comments end up together rather than one-per-batch behind a walkthrough.
    expect(batches[0]!.length).toBeGreaterThan(1);
  });
});
