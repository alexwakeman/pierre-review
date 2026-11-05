import { describe, expect, it } from 'vitest';
import { BOT_VENDOR_META, contrastRatio, readableInk, vendorInk } from '../src/lib/ui.js';
import { INK_GROUNDS } from '../src/lib/colorSchemes.js';
import { luminance, pageGrounds } from './schemeCss.js';

// BRAND INK — every vendor colour must be legible on BOTH page grounds.
//
// A reader reported the Cursor chip as unreadable in dark mode. Cursor's brand hex is #334155,
// which renders at 1.94:1 against the dark page. It was not one vendor: 40 of the 83 colours failed
// AA on dark and 43 failed on light, because a raw brand hex was being used directly as text colour
// on two opposite grounds.
//
// ⚠ THE TWO-VARIANT DESIGN IS FORCED, NOT CHOSEN — the first test below is the proof, and it is
// here so nobody "simplifies" this back to one stored colour per vendor.

const LIGHT_BG = '#ffffff';
const DARK_BG = '#191919';
const AA = 4.5;

describe('brand ink', () => {
  it('proves no single colour can clear AA on both grounds — the reason there are two', () => {
    // Clearing 4.5:1 against white requires a relative luminance ≤ 0.175; against the near-black
    // page it requires ≥ 0.184. The windows do not overlap, so the intersection is empty. Checked
    // by exhaustive sweep over the greyscale ramp rather than asserted from the algebra.
    const bothPass = [];
    for (let v = 0; v <= 255; v += 1) {
      const hex = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
      if (contrastRatio(hex, LIGHT_BG) >= AA && contrastRatio(hex, DARK_BG) >= AA) bothPass.push(hex);
    }
    expect(bothPass).toEqual([]);
  });

  it('makes every vendor colour legible on both grounds', () => {
    const failures: string[] = [];
    for (const [kind, meta] of Object.entries(BOT_VENDOR_META)) {
      const onLight = readableInk(meta.color, LIGHT_BG);
      const onDark = readableInk(meta.color, DARK_BG);
      const l = contrastRatio(onLight, LIGHT_BG);
      const d = contrastRatio(onDark, DARK_BG);
      if (l < AA) failures.push(`${kind} (${meta.color}) light ${l.toFixed(2)}:1`);
      if (d < AA) failures.push(`${kind} (${meta.color}) dark ${d.toFixed(2)}:1`);
    }
    expect(failures).toEqual([]);
  });

  it('leaves a colour that already passes exactly alone', () => {
    // CodeRabbit's orange clears both grounds unaided — the adjustment must be a no-op, or every
    // brand that was fine gets quietly shifted.
    expect(readableInk('#ff7a45', DARK_BG)).toBe('#ff7a45');
    expect(contrastRatio('#ff7a45', DARK_BG)).toBeGreaterThanOrEqual(AA);
  });

  it('fixes the reported case, and keeps its hue', () => {
    const cursor = BOT_VENDOR_META.cursor.color;
    expect(cursor).toBe('#334155');
    expect(contrastRatio(cursor, DARK_BG)).toBeLessThan(2); // 1.94:1 — what the reader saw
    const fixed = readableInk(cursor, DARK_BG);
    expect(contrastRatio(fixed, DARK_BG)).toBeGreaterThanOrEqual(AA);
    // Same hue family: still the blue-slate it is meant to be, not a generic grey.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fixed.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r!); // blue-dominant, as #334155 is
    expect(g!).toBeGreaterThan(r!);
  });

  it('hands the renderer both variants and NO color of its own', () => {
    const ink = vendorInk('#334155');
    expect(ink['--ink-light']).toBeDefined();
    expect(ink['--ink-dark']).toBeDefined();
    expect(ink['--ink-light']).not.toBe(ink['--ink-dark']);
    // ⚠ NO `color` KEY, AND THIS IS LOAD-BEARING. index.css applies the colour by matching
    // `[style*="--ink-light"]`; an inline `color` here would beat that rule and freeze whichever
    // variant was written. An earlier cut returned `color: 'var(--ink)'` with the pick made at
    // `:root` — which resolves against root's undefined `--ink-light`, dies there, and left every
    // chip on its inherited colour. It typechecked and rendered; only the screen showed it.
    expect(ink['color']).toBeUndefined();
    expect(Object.keys(ink).sort()).toEqual(['--ink-dark', '--ink-light']);
  });
});

// EVERY COLOUR SCHEME'S PAGE (docs/FRONTEND.md § Colour schemes). The CSS picks `--ink-light` or
// `--ink-dark` by `.dark` alone, so one pair must hold on every scheme of that mode. `vendorInk` fits
// each against the HARDEST page of its mode (lib/colorSchemes.ts `INK_GROUNDS`).
describe('brand ink on every colour scheme', () => {
  it('fits against the hardest page of each mode', () => {
    const darkestLight = pageGrounds('light').reduce((a, b) => (luminance(b[1]) < luminance(a[1]) ? b : a));
    const lightestDark = pageGrounds('dark').reduce((a, b) => (luminance(b[1]) > luminance(a[1]) ? b : a));
    expect(INK_GROUNDS.light).toBe(darkestLight[1]);
    expect(INK_GROUNDS.dark).toBe(lightestDark[1]);
  });

  it('every vendor clears AA on every scheme’s page', () => {
    const failures: string[] = [];
    for (const [kind, meta] of Object.entries(BOT_VENDOR_META)) {
      const ink = vendorInk(meta.color);
      for (const [id, bg] of pageGrounds('light')) {
        const r = contrastRatio(ink['--ink-light']!, bg);
        if (r < AA) failures.push(`${kind} on ${id} ${r.toFixed(2)}:1`);
      }
      for (const [id, bg] of pageGrounds('dark')) {
        const r = contrastRatio(ink['--ink-dark']!, bg);
        if (r < AA) failures.push(`${kind} on ${id} ${r.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });
});
