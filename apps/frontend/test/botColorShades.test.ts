import { describe, expect, it } from 'vitest';
import {
  BOT_VENDOR_META,
  brandShade,
  buildBotColorMap,
  contrastRatio,
  vendorInk,
} from '../src/lib/ui.js';
import { pageGrounds } from './schemeCss.js';

// ONE LINE PER ENSEMBLE POSTER. Every Ensemble write is a bot `limn:<login>` of kind `pierre`, so
// before this every poster drew in the same orange and the Bots page charts could not tell them
// apart. A second login of a branded kind now takes a SHADE of the brand colour.

const ENSEMBLE = BOT_VENDOR_META.pierre.color;
const AA = 4.5;

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

describe('brandShade', () => {
  it('index 0 is the brand colour itself', () => {
    expect(brandShade(ENSEMBLE, 0)).toBe(ENSEMBLE);
  });

  it('is deterministic and gives distinct shades', () => {
    const shades = Array.from({ length: 8 }, (_, i) => brandShade(ENSEMBLE, i));
    expect(shades).toEqual(Array.from({ length: 8 }, (_, i) => brandShade(ENSEMBLE, i)));
    expect(new Set(shades).size).toBe(shades.length);
  });

  it('stays in the brand hue family (recognisably Ensemble orange)', () => {
    const base = hue(ENSEMBLE);
    for (let i = 1; i < 8; i++) {
      expect(Math.abs(hue(brandShade(ENSEMBLE, i)) - base)).toBeLessThanOrEqual(35);
    }
  });

  it('every shade, as text through vendorInk, clears AA on every scheme’s page', () => {
    const failures: string[] = [];
    for (const [kind, meta] of Object.entries(BOT_VENDOR_META)) {
      for (let i = 1; i < 6; i++) {
        const ink = vendorInk(brandShade(meta.color, i));
        for (const [id, bg] of pageGrounds('light')) {
          const r = contrastRatio(ink['--ink-light']!, bg);
          if (r < AA) failures.push(`${kind}#${i} on ${id} ${r.toFixed(2)}:1`);
        }
        for (const [id, bg] of pageGrounds('dark')) {
          const r = contrastRatio(ink['--ink-dark']!, bg);
          if (r < AA) failures.push(`${kind}#${i} on ${id} ${r.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('buildBotColorMap — several logins of one branded kind', () => {
  const roster = [
    { login: 'limn:carol', kind: 'pierre' as const },
    { login: 'limn:alice', kind: 'pierre' as const },
    { login: 'limn:bob', kind: 'pierre' as const },
    { login: 'coderabbitai[bot]', kind: 'coderabbit' as const },
  ];

  it('gives each Ensemble poster its own shade, the first by login keeping the brand colour', () => {
    const map = buildBotColorMap(roster);
    expect(map.get('limn:alice')).toBe(ENSEMBLE);
    expect(map.get('limn:bob')).toBe(brandShade(ENSEMBLE, 1));
    expect(map.get('limn:carol')).toBe(brandShade(ENSEMBLE, 2));
    const colours = ['limn:alice', 'limn:bob', 'limn:carol'].map((l) => map.get(l));
    expect(new Set(colours).size).toBe(3);
  });

  it('is stable whatever order the roster arrives in', () => {
    const a = buildBotColorMap(roster);
    const b = buildBotColorMap([...roster].reverse());
    for (const r of roster) expect(a.get(r.login)).toBe(b.get(r.login));
  });

  it('leaves a lone branded bot on its brand colour', () => {
    const map = buildBotColorMap(roster);
    expect(map.get('coderabbitai[bot]')).toBe(BOT_VENDOR_META.coderabbit.color);
    expect(buildBotColorMap([{ login: 'limn:solo', kind: 'pierre' }]).get('limn:solo')).toBe(ENSEMBLE);
  });

  it('never hands an in-house bot a colour a shade already took', () => {
    const map = buildBotColorMap([...roster, { login: 'acme-bot', kind: 'in_house' }]);
    const shades = new Set(['limn:alice', 'limn:bob', 'limn:carol'].map((l) => map.get(l)!.toLowerCase()));
    expect(shades.has(map.get('acme-bot')!.toLowerCase())).toBe(false);
  });
});
