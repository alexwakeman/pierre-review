// The ring's ripple (src/components/arcs/ringWave.ts): when a scene's ring counts as closed,
// and the tiles' swell carried over as Web Animations keyframes.
import { describe, expect, it } from 'vitest';
import { RIPPLE_PEAKS } from '../src/components/arcs/cornerWave';
import { ARRIVE_VH, ringClosed, ringWhole, swellKeyframes } from '../src/components/arcs/ringWave';
import { ringLines, SITE_RING, SPECTRUM } from '../src/components/arcs/geometry';

describe('the ring ripple', () => {
  it('a forward ring closes once its last line has landed', () => {
    expect(ringClosed(129, 130, 1, false)).toBe(false);
    expect(ringClosed(130, 130, 1, false)).toBe(true);
    expect(ringClosed(80, 100, 0.8, false)).toBe(true);
  });

  it('a reverse ring is closed only before it starts to come apart', () => {
    expect(ringClosed(-20, 120, 1, true)).toBe(true);
    expect(ringClosed(0, 120, 1, true)).toBe(true);
    expect(ringClosed(1, 120, 1, true)).toBe(false);
  });

  it('a whole ring counts as arrived only once its scene is well onto the screen', () => {
    // the reverse ring scrolling in, whole: not yet, then arrived
    expect(ringWhole(ARRIVE_VH - 100 - 1, 120, 1, true)).toBe(false);
    expect(ringWhole(ARRIVE_VH - 100, 120, 1, true)).toBe(true);
    // coming apart: no longer whole
    expect(ringWhole(5, 120, 1, true)).toBe(false);
    // the forward ring: whole once closed
    expect(ringWhole(130, 130, 1, false)).toBe(true);
  });

  it('the ring has no blue, indigo or violet in it', () => {
    const { lines } = ringLines(100, SITE_RING.margin, SITE_RING.scatter, SITE_RING.spreadX);
    const used = new Set(lines.flatMap((l) => l.stops));
    for (const c of [SPECTRUM.azure, SPECTRUM.indigo, SPECTRUM.violet, SPECTRUM.plum, SPECTRUM.teal]) expect(used.has(c)).toBe(false);
    for (const c of [SPECTRUM.red, SPECTRUM.orange, SPECTRUM.green]) expect(used.has(c)).toBe(true);
  });

  it('swells like the tiles and settles back to the band width', () => {
    const { frames, ms } = swellKeyframes(2);
    expect(ms).toBeGreaterThan(0);
    expect(frames[0]!.offset).toBe(0);
    expect(frames[frames.length - 1]!.offset).toBe(1);
    expect(frames[0]!.strokeWidth).toBe('2.000px');
    expect(frames[frames.length - 1]!.strokeWidth).toBe('2.000px');
    const peak = Math.max(...frames.map((f) => parseFloat(String(f.strokeWidth))));
    expect(peak).toBeCloseTo(2 * RIPPLE_PEAKS[0], 1);
  });

  it('every ring line knows its band, innermost 0, for the ripple order', () => {
    const { lines } = ringLines(100, SITE_RING.margin, SITE_RING.scatter, SITE_RING.spreadX);
    expect(lines).toHaveLength(64);
    expect(Math.min(...lines.map((l) => l.b))).toBe(0);
    expect(Math.max(...lines.map((l) => l.b))).toBe(15);
    // the latest line lands by the end of the gather
    expect(Math.max(...lines.map((l) => l.e))).toBeLessThanOrEqual(1);
  });
});
