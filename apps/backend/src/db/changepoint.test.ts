// detectChangepoints — pure series cases, no DB (the bot-behaviour-anomaly.test.ts precedent).
// The advisor's unattributed verification mode leans on exactly these properties: a clean step
// is found at the right index, noise and thin data produce NO claim, nulls (no-data weeks) are
// skipped rather than imputed, and anchors evaluate only the asked-about splits.
import { describe, expect, it } from 'vitest';
import { detectChangepoints, MIN_BASELINE_POINTS } from './changepoint.js';

describe('detectChangepoints (scan mode)', () => {
  it('finds a clean step change at the index where the after-segment begins', () => {
    const cps = detectChangepoints([10, 10, 10, 10, 50, 50, 50, 50], { minScale: 2 });
    expect(cps).toHaveLength(1);
    expect(cps[0]!.index).toBe(4);
    expect(cps[0]!.direction).toBe('up');
    expect(cps[0]!.beforeMedian).toBe(10);
    expect(cps[0]!.afterMedian).toBe(50);
  });

  it('a downward step reports direction down', () => {
    const cps = detectChangepoints([8, 8, 8, 8, 8, 2, 2, 2, 2], { minScale: 2 });
    expect(cps).toHaveLength(1);
    expect(cps[0]!.direction).toBe('down');
  });

  it('a flat series makes no claim', () => {
    expect(detectChangepoints([5, 5, 5, 5, 5, 5, 5, 5], { minScale: 2 })).toEqual([]);
  });

  it('thin data makes no claim (fewer than MIN_BASELINE_POINTS per side everywhere)', () => {
    // 6 points: every split leaves one side under the 4-point floor.
    expect(MIN_BASELINE_POINTS).toBe(4);
    expect(detectChangepoints([10, 10, 10, 50, 50, 50], { minScale: 2 })).toEqual([]);
  });

  it('nulls are skipped, not imputed — a step across null weeks is still found', () => {
    const cps = detectChangepoints(
      [10, null, 10, 10, 10, 50, null, 50, 50, 50],
      { minScale: 2 },
    );
    expect(cps).toHaveLength(1);
    expect(cps[0]!.index).toBe(5);
    expect(cps[0]!.direction).toBe('up');
  });

  it('noisy spread swallows a small shift (robust sigma, not minScale, dominates)', () => {
    // Medians differ by ~4 but the within-segment spread is large — no claim.
    const cps = detectChangepoints([2, 30, 5, 22, 9, 26, 6, 33], { minScale: 2 });
    expect(cps).toEqual([]);
  });

  it('returns at most ONE changepoint in scan mode (the strongest split, not every index over the bar)', () => {
    // A long plateau change scores at several adjacent splits; only the best may come back.
    const cps = detectChangepoints([10, 10, 10, 10, 10, 90, 90, 90, 90, 90], { minScale: 2 });
    expect(cps).toHaveLength(1);
  });
});

describe('detectChangepoints (anchors mode)', () => {
  it('evaluates only the asked-about splits', () => {
    const series = [10, 10, 10, 10, 50, 50, 50, 50, 50];
    // The true step is at 4; anchor 5 still shows a significant difference (median 10 vs 50),
    // but anchor 2 has a thin before-segment and must be silently skipped.
    const cps = detectChangepoints(series, { anchors: [2, 5], minScale: 2 });
    expect(cps.map((c) => c.index)).toEqual([5]);
  });

  it('a non-significant anchor returns nothing rather than a weak claim', () => {
    expect(
      detectChangepoints([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], { anchors: [5], minScale: 2 }),
    ).toEqual([]);
  });

  it('out-of-range anchors are ignored', () => {
    expect(
      detectChangepoints([10, 10, 10, 10, 50, 50, 50, 50], { anchors: [0, 99], minScale: 2 }),
    ).toEqual([]);
  });
});
