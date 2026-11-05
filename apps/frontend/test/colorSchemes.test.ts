import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COLOR_SCHEMES,
  DEFAULT_SCHEME,
  SCHEME_STORAGE,
  currentScheme,
  readSchemeState,
  toggledMode,
  withScheme,
  writeSchemeState,
} from '../src/lib/colorSchemes.js';
import { SCHEMES, SCHEME_CSS, contrast, luminance } from './schemeCss.js';

// EVERY COLOUR SCHEME, MEASURED (docs/FRONTEND.md § Colour schemes).
//
// The same floors `designTokens.test.ts` holds the two defaults to, applied to every scheme in
// lib/colorSchemes.ts, read from index.css: each of the seven text inks clears AA on each of the five
// surfaces, the primary button's text clears AA, the surfaces step one way, and the AI family's inks
// clear AA on the AI surfaces (and its signal on every row a mark can sit on). A scheme that keeps a
// canonical hex that fails one of these does not ship; move its lightness, keep its hue.

const UI = ['bg', 'surface', 'raise', 'hover', 'sel', 'line', 'ink', 'mute', 'faint', 'accent', 'accent-fill', 'on-accent', 'danger', 'success', 'warn', 'scrim'];
const AI = ['surface', 'surface-2', 'border', 'hairline', 'ink', 'muted', 'signal', 'signal-fill'];
const SURFACES = ['bg', 'surface', 'raise', 'hover', 'sel'] as const;
const INKS = ['ink', 'mute', 'faint', 'accent', 'danger', 'success', 'warn'] as const;
const AA = 4.5;

describe('the scheme list and the CSS agree', () => {
  it('has unique ids and the two defaults', () => {
    const ids = COLOR_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_SCHEME.light);
    expect(ids).toContain(DEFAULT_SCHEME.dark);
  });

  it('every [data-scheme] block in index.css is a listed scheme', () => {
    const inCss = new Set([...SCHEME_CSS.matchAll(/^\[data-scheme='([a-z-]+)'\]/gm)].map((m) => m[1]!));
    expect([...inCss].sort()).toEqual(COLOR_SCHEMES.map((s) => s.id).sort());
  });
});

describe.each(SCHEMES)('$label ($mode)', (s) => {
  it('defines every --ui-* and --ai-* role, as space-separated channels', () => {
    for (const k of UI) expect(s.ui[k], `--ui-${k}`).toMatch(/^#[0-9a-f]{6}$/);
    for (const k of AI) expect(s.ai[k], `--ai-${k}`).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('every text ink clears AA on every surface', () => {
    const fails: string[] = [];
    for (const ink of INKS)
      for (const g of SURFACES) {
        const r = contrast(s.ui[ink]!, s.ui[g]!);
        if (r < AA) fails.push(`${ink} on ${g}: ${r.toFixed(2)}`);
      }
    expect(fails).toEqual([]);
  });

  it('text on the primary button clears AA', () => {
    expect(contrast(s.ui['on-accent']!, s.ui['accent-fill']!)).toBeGreaterThanOrEqual(AA);
  });

  it('the surfaces step in one direction', () => {
    const lum = SURFACES.map((g) => luminance(s.ui[g]!));
    for (let i = 1; i < lum.length; i++) {
      if (s.mode === 'dark') expect(lum[i]!, SURFACES[i]).toBeGreaterThan(lum[i - 1]!);
      else expect(lum[i]!, SURFACES[i]).toBeLessThan(lum[i - 1]!);
    }
  });

  it('the AI inks clear AA on the AI surfaces, and the signal on every row', () => {
    const fails: string[] = [];
    for (const ink of ['ink', 'muted', 'signal'])
      for (const g of ['surface', 'surface-2']) {
        const r = contrast(s.ai[ink]!, s.ai[g]!);
        if (r < AA) fails.push(`ai-${ink} on ai-${g}: ${r.toFixed(2)}`);
      }
    for (const g of SURFACES) {
      const r = contrast(s.ai['signal']!, s.ui[g]!);
      if (r < AA) fails.push(`ai-signal on ${g}: ${r.toFixed(2)}`);
    }
    expect(fails).toEqual([]);
  });

  it('matches its mode: a dark scheme has a dark page, a light one a light page', () => {
    expect(luminance(s.ui['bg']!) < 0.2).toBe(s.mode === 'dark');
  });
});

describe('the stored choice', () => {
  const store = (init: Record<string, string>) => {
    const m = new Map(Object.entries(init));
    return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), m };
  };

  it('nothing stored is the dark default; a legacy `theme=light` is the light default', () => {
    expect(currentScheme(readSchemeState(store({}).get)).id).toBe('dark');
    expect(currentScheme(readSchemeState(store({ theme: 'light' }).get)).id).toBe('light');
  });

  it('an unknown or wrong-mode id falls back to that mode’s default', () => {
    const st = readSchemeState(store({ theme: 'dark', [SCHEME_STORAGE.dark]: 'nope', [SCHEME_STORAGE.light]: 'nord' }).get);
    expect(st).toEqual({ mode: 'dark', light: 'light', dark: 'dark' });
  });

  it('picking a scheme picks its mode; the toggle returns to the other mode’s last scheme', () => {
    let st = readSchemeState(store({}).get);
    st = withScheme(st, 'nord');
    expect(currentScheme(st).id).toBe('nord');
    st = withScheme(st, 'gruvbox-light');
    expect(st.mode).toBe('light');
    st = toggledMode(st);
    expect(currentScheme(st).id).toBe('nord');
    st = toggledMode(st);
    expect(currentScheme(st).id).toBe('gruvbox-light');
  });

  it('writes the legacy `theme` key as the mode, so old readers still work', () => {
    const s = store({});
    writeSchemeState(s.set, withScheme(readSchemeState(s.get), 'solarized-light'));
    expect(s.m.get('theme')).toBe('light');
    expect(s.m.get(SCHEME_STORAGE.light)).toBe('solarized-light');
  });

  it('public/theme-boot.js applies the same rule before first paint', () => {
    const boot = readFileSync(new URL('../public/theme-boot.js', import.meta.url).pathname, 'utf8');
    expect(boot).toContain(`getItem('${SCHEME_STORAGE.mode}')`);
    expect(`theme-scheme-light`).toBe(SCHEME_STORAGE.light);
    expect(`theme-scheme-dark`).toBe(SCHEME_STORAGE.dark);
    expect(boot).toContain(`getItem('theme-scheme-' + mode)`);
    expect(boot).toContain(`setAttribute('data-scheme', id)`);
    const html = readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf8');
    // In <head>, blocking (no defer/async/module), so it runs before the first paint.
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toMatch(/<script src="\/theme-boot\.js"><\/script>/);
  });
});
