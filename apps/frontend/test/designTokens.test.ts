import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// THE REDESIGN'S TOKENS, MEASURED (docs/redesign/DESIGN.md § Colour, § Type).
//
// The `--ui-*` colour roles in src/index.css are read straight from the CSS (both themes), and every
// text ink is measured against every surface it can sit on. Change a value and this says whether the
// pairing still clears WCAG AA. It also holds the type floor: nothing under 11px anywhere in the SPA.

const CSS = readFileSync(join(__dirname, '../src/index.css'), 'utf8');

function block(selector: ':root' | '.dark'): Record<string, string> {
  const re = selector === ':root' ? /:root\s*\{([^}]*)\}/g : /\.dark\s*\{([^}]*)\}/g;
  for (const m of CSS.matchAll(re)) {
    const body = m[1] ?? '';
    if (!body.includes('--ui-bg')) continue;
    const out: Record<string, string> = {};
    for (const d of body.matchAll(/--ui-([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
      const hex = [d[2], d[3], d[4]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      out[d[1]!] = `#${hex}`;
    }
    return out;
  }
  throw new Error(`no --ui-* block for ${selector}`);
}

const THEMES = { light: block(':root'), dark: block('.dark') };
const SURFACES = ['bg', 'surface', 'raise', 'hover', 'sel'] as const;
const INKS = ['ink', 'mute', 'faint', 'accent', 'danger', 'success', 'warn'] as const;

describe('--ui-* colour roles', () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    it(`${theme}: every role is defined`, () => {
      for (const k of [...SURFACES, ...INKS, 'line', 'accent-fill', 'on-accent', 'scrim']) expect(t[k], k).toBeTruthy();
    });

    it(`${theme}: every text ink clears AA (4.5:1) on every surface`, () => {
      const fails: string[] = [];
      for (const ink of INKS)
        for (const s of SURFACES) {
          const r = contrastRatio(t[ink]!, t[s]!);
          if (r < 4.5) fails.push(`${ink} on ${s}: ${r.toFixed(2)}`);
        }
      expect(fails).toEqual([]);
    });

    it(`${theme}: text on the primary button clears AA`, () => {
      expect(contrastRatio(t['on-accent']!, t['accent-fill']!)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: the surfaces step in one direction (tone, not borders, separates them)`, () => {
      const lum = SURFACES.map((s) => contrastRatio(t[s]!, '#000000'));
      for (let i = 1; i < lum.length; i++) {
        if (theme === 'dark') expect(lum[i]!).toBeGreaterThan(lum[i - 1]!);
        else expect(lum[i]!).toBeLessThan(lum[i - 1]!);
      }
    });
  }
});

describe('the type floor', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(tsx?|css)$/.test(p)) out.push(p);
    }
    return out;
  }

  it('nothing in the SPA is set under 11px', () => {
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, '../src'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) if (Number(m[1]) < 11) offenders.push(`${file}: ${m[0]}`);
      for (const m of src.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) if (Number(m[1]) < 11) offenders.push(`${file}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the design scale is exactly four sizes: 12 / 13 / 15 / 22', () => {
    const cfg = readFileSync(join(__dirname, '../tailwind.config.ts'), 'utf8');
    const scale = cfg.match(/fontSize:\s*\{([\s\S]*?)\n\s{6}\},/)?.[1] ?? '';
    const sizes = [...scale.matchAll(/\[\s*'(\d+)px'/g)].map((m) => Number(m[1]));
    expect(sizes).toEqual([12, 13, 15, 22]);
  });
});
