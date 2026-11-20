// The named log y-axis (lib/logAxis.ts) — Bots Monitoring's "Time to first review" chart.
// Run: ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { HOUR_FLOOR, HOUR_TICKS, logAxis } from '../src/lib/logAxis.js';

const labels = (vs: (number | null)[]): string[] =>
  logAxis(vs, HOUR_TICKS, HOUR_FLOOR)?.ticks.map((t) => t.label) ?? [];

describe('logAxis', () => {
  it('is null with nothing to scale', () => {
    expect(logAxis([], HOUR_TICKS, HOUR_FLOOR)).toBeNull();
    expect(logAxis([null, null], HOUR_TICKS, HOUR_FLOOR)).toBeNull();
  });

  it('draws only the ticks that bracket the data', () => {
    // 2 hours to 5 hours: 1h below, 6h above.
    expect(labels([2, null, 5])).toEqual(['1h', '6h']);
    // 5 minutes to 2 days.
    expect(labels([5 / 60, 48])).toEqual(['1m', '10m', '1h', '6h', '1d', '3d']);
  });

  it('clamps a zero or sub-minute median to the 1-minute floor', () => {
    const a = logAxis([0, 0.001, 3], HOUR_TICKS, HOUR_FLOOR)!;
    expect(a.lo).toBe(HOUR_FLOOR);
    expect(a.ticks.map((t) => t.label)).toEqual(['1m', '10m', '1h', '6h']);
  });

  it('opens a one-value axis to the next tick', () => {
    expect(labels([1, 1])).toEqual(['1h', '6h']);
  });

  it('runs past the last tick to the data’s own end', () => {
    const a = logAxis([2, 1000], HOUR_TICKS, HOUR_FLOOR)!;
    expect(a.hi).toBe(1000);
    expect(a.ticks.at(-1)?.label).toBe('4w');
  });
});
