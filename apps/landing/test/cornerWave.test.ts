// The corner ripple (src/components/arcs/cornerWave.ts): the bands come from corner.svg, and each
// band's width swells three times, gentler each time, and ends exactly where it started.
import { describe, expect, it } from 'vitest';
import { cornerBands, RIPPLE_PEAKS, rippleSeconds, swellTimeline, waveSvg } from '../src/components/arcs/cornerWave';

describe('the corner ripple', () => {
  const bands = cornerBands();

  it('reads every band of corner.svg, corner first', () => {
    expect(bands).toHaveLength(14);
    expect(bands[0]!.w).toBe(1);
    expect(bands[13]!.w).toBe(4);
  });

  it('swells three times, each ripple gentler, and settles back to the band width', () => {
    const tl = swellTimeline(2);
    const v = tl.values.split(';').map(Number);
    expect(v[0]).toBe(2);
    expect(v[v.length - 1]).toBe(2);
    expect(Math.max(...v)).toBeCloseTo(2 * RIPPLE_PEAKS[0], 1);
    // local maxima: one per ripple, decreasing
    const peaks = v.filter((x, i) => i > 0 && i < v.length - 1 && x > v[i - 1]! && x >= v[i + 1]!);
    expect(peaks).toHaveLength(3);
    expect(peaks[0]! > peaks[1]! && peaks[1]! > peaks[2]!).toBe(true);
    const keys = tl.keyTimes.split(';').map(Number);
    expect(keys[0]).toBe(0);
    expect(keys[keys.length - 1]).toBe(1);
    expect(keys).toHaveLength(v.length);
  });

  it('starts each band a little after the one inside it, and each copy is its own image', () => {
    const a = waveSvg(1, bands);
    expect(a.match(/<animate /g)).toHaveLength(14);
    expect(a).toContain('begin="0.00s"');
    expect(a).toContain('begin="0.78s"');
    expect(waveSvg(2, bands)).not.toBe(a);
    expect(rippleSeconds(14)).toBeCloseTo(2.48, 2);
  });
});
