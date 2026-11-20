import { describe, expect, it } from 'vitest';
import { applyIsolation, effectiveIsolated, isDimmed, toggleIsolated } from '../src/lib/botIsolate.js';

describe('toggleIsolated', () => {
  it('isolates a bot, switches to another, and clears on a second click', () => {
    expect(toggleIsolated(null, 'u1')).toBe('u1');
    expect(toggleIsolated('u1', 'u2')).toBe('u2');
    expect(toggleIsolated('u2', 'u2')).toBeNull();
  });
});

describe('effectiveIsolated / isDimmed', () => {
  it('isolates nothing in a chart the bot is not drawn in', () => {
    expect(effectiveIsolated('u9', ['u1', 'u2'])).toBeNull();
    expect(effectiveIsolated('u2', ['u1', 'u2'])).toBe('u2');
    expect(effectiveIsolated(null, ['u1'])).toBeNull();
  });
  it('dims every bot but the isolated one, and none when nothing is isolated', () => {
    expect(isDimmed(null, 'u1')).toBe(false);
    expect(isDimmed('u1', 'u1')).toBe(false);
    expect(isDimmed('u1', 'u2')).toBe(true);
  });
});

describe('applyIsolation', () => {
  const series = [
    { key: 'u1', label: 'A' },
    { key: 'u2', label: 'B' },
    { key: 'u3', label: 'C' },
    { key: '__trend__', label: 'Trend', dashed: true },
  ];

  it('returns the series unchanged with nothing isolated, or an absent bot isolated', () => {
    expect(applyIsolation(series, null)).toEqual(series);
    expect(applyIsolation(series, 'u9')).toEqual(series);
  });

  it('dims the others, paints the isolated bot last, and never dims a dashed overlay', () => {
    const out = applyIsolation(series, 'u1');
    expect(out.map((s) => s.key)).toEqual(['u2', 'u3', 'u1', '__trend__']);
    expect(out.find((s) => s.key === 'u1')!.dimmed).toBe(false);
    expect(out.find((s) => s.key === 'u2')!.dimmed).toBe(true);
    expect(out.find((s) => s.key === '__trend__')!.dimmed).toBeUndefined();
  });

  it('does not mutate its input', () => {
    applyIsolation(series, 'u2');
    expect(series.every((s) => !('dimmed' in s))).toBe(true);
  });
});
