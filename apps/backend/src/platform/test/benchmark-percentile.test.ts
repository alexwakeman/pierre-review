// The percentile lookups, pinned against GOLDEN VECTORS produced by the Python reference.
//
// ⚠ WHY GOLDEN VECTORS AND NOT HAND-PICKED NUMBERS. `bot_monitor.panel.fit` calls its
// `percentile_of` / `value_at_percentile` "the reference implementation the serving side must
// match". Two implementations of one lookup diverge silently — the failure mode is a percentile
// that is plausible and wrong, which no smoke test catches. Every expectation below was produced
// by running the Python on THE SAME grid this fixture carries:
//
//   fit._fit_values([0.0]*8 + [0.02*i for i in 1..22], FitParams())
//   → grid v = [0,0,0,0,0, 0.005, 0.034, … 0.44]  (21 knots, p = 0,5,…,100)
//
// ⚠ AND THE FIXTURE IS SHAPED FOR THE BUG. Eight of its thirty repositories sit on EXACTLY 0.0, so
// the first five knots are flat — the tied region where the mid-rank convention is load-bearing. A
// customer at 0.0 is not "worse than everyone" (0, what `value <= v[0] -> 0` returns) and not
// "better than a quarter of them" (25, what the last matching knot returns): they are TIED, and
// the honest answer is 10 — the middle of the tie. Both wrong answers are plausible numbers, and
// neither shows up in a fixture with distinct values at every knot.
//
// Runs from the backend workspace (@pierre/pro ships no vitest devDep):
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BotBenchmarkMetric } from '@pierre-review/shared';
import { mapMetric } from '../bots/benchmark/map.js';
import { percentileOf, valueAtPercentile } from '../bots/benchmark/percentile.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/benchmark-fit-smoke.json', import.meta.url)), 'utf8'),
) as any;

const FITTED: BotBenchmarkMetric = mapMetric(raw.cells.coderabbit['5'].metrics.acted_on_rate);
const REFUSED: BotBenchmarkMetric = mapMetric(
  raw.cells.coderabbit['5'].metrics.human_reply_rate,
);

describe('percentileOf — the golden vectors', () => {
  it('agrees with the Python reference at every probe', () => {
    // value → percentile, straight from fit.percentile_of.
    const golden: Array<[number, number]> = [
      [-1.0, 0],
      // ⚠ THE TIED BOTTOM EDGE. Not 0, not 20 — the middle of the tie.
      [0.0, 10],
      [0.01, 25.8621],
      [0.02, 27.5862],
      [0.05, 32.7586],
      [0.11, 43.1034],
      [0.2, 58.6207],
      [0.25, 67.2414],
      [0.3, 75.8621],
      [0.4399, 99.9828],
      // At and above the top knot the answer saturates at 100.
      [0.44, 100],
      [0.5, 100],
      [1.0, 100],
    ];
    for (const [value, expected] of golden) {
      expect(percentileOf(FITTED, value), `value=${value}`).toBe(expected);
    }
  });

  it('never claims a rank on a refused metric', () => {
    // ⚠ `null`, NEVER 0 and never a plausible small number. This is the whole payoff of the
    // discriminated union: a mapper that had normalised the refusal into `{ grid: [] }` would make
    // this return a number, and a chart would draw it.
    expect(percentileOf(REFUSED, 0.4)).toBeNull();
    expect(valueAtPercentile(REFUSED, 50)).toBeNull();
  });
});

describe('valueAtPercentile — the inverse lookup', () => {
  it('agrees with numpy.interp on the grid, including its clamping', () => {
    const golden: Array<[number, number]> = [
      [0, 0],
      [5, 0],
      [12.5, 0],
      [25, 0.005],
      [50, 0.15],
      [75, 0.295],
      [90, 0.382],
      [100, 0.44],
    ];
    for (const [p, expected] of golden) {
      expect(valueAtPercentile(FITTED, p), `p=${p}`).toBeCloseTo(expected, 9);
    }
    // Outside the knot range numpy.interp returns the nearest endpoint rather than extrapolating.
    expect(valueAtPercentile(FITTED, -10)).toBe(0);
    expect(valueAtPercentile(FITTED, 250)).toBe(0.44);
  });

  it('round-trips the headline percentiles the artifact publishes', () => {
    if (FITTED.status !== 'fitted') throw new Error('fixture metric is not fitted');
    // The headline five are read OUT of the grid by the fitter, so interpolating the grid at those
    // percentiles must land on the published numbers exactly — if it does not, the artifact
    // contradicts itself and one of the two readers is lying.
    for (const [key, value] of Object.entries(FITTED.quantiles)) {
      const p = Number(key.slice(1));
      expect(valueAtPercentile(FITTED, p), key).toBeCloseTo(value, 9);
    }
  });
});
