import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ── THE RESOLVER'S COLOURS, MEASURED FROM SOURCE ─────────────────────────────────────────────
//
// ⚠ HAND-RUN, like every test under `apps/frontend/test`:
//     ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
//
// ⚠ THIS EXISTS BECAUSE `textContrast.test.ts` CANNOT SEE THESE COLOURS. That scanner resolves
// Tailwind utilities with a numeric shade (`text-gray-400`, `fill-gray-500`); the resolver's
// palette is four CSS custom properties and seven scoped syntax colours, which match nothing it
// looks for. So this test reads `index.css`, composites each wash at ITS OWN declared alpha over
// the page ground, and measures both directions in both themes. The same gap is recorded in
// `index.css`'s own header and in docs/FRONTEND.md beside `--ai-*`.
//
// The formula is `textContrast.test.ts:52-68`'s, restated rather than imported: that file exports
// `contrastRatio` but importing a test from a test couples two hand-run suites, and the four lines
// below are the WCAG definition, not a helper.

const CSS = readFileSync(new URL('../src/index.css', import.meta.url).pathname, 'utf8');

/** The page grounds, from index.css / App.tsx: `bg-white` and `dark:bg-gray-950`. */
const LIGHT_BG: RGB = [255, 255, 255];
const DARK_BG: RGB = [3, 7, 18];
const AA_BODY = 4.5;

type RGB = [number, number, number];

function luminance([r, g, b]: RGB): number {
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(fg: RGB, bg: RGB): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
/** `background: rgb(var(--x) / a)` over an opaque ground. */
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as RGB;
}
function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const ROLES = ['change', 'conflict', 'applied', 'ignored'] as const;
type Role = (typeof ROLES)[number];

/** The declaration block of a selector that actually carries `--mr-change`. There are two other
 *  `:root` blocks in this file (the AI tokens, the wordmark), so the predicate matters. */
function blockCarrying(selector: string, marker: string): string {
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of CSS.matchAll(re)) {
    if (m[1]!.includes(marker)) return m[1]!;
  }
  throw new Error(`no ${selector} block declaring ${marker} in index.css`);
}

function tokens(block: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(new RegExp(`--${prefix}-([a-z_]+)\\s*:\\s*([^;]+);`, 'g'))) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** ⚠ SPACE-SEPARATED CHANNELS ARE LOAD-BEARING. `rgb(var(--mr-change) / 0.12)` composites only
 *  when the variable holds `29 78 216`; a comma-separated triplet paints nothing, silently. */
function channels(value: string): RGB {
  const parts = value.trim().split(/\s+/);
  expect(parts).toHaveLength(3);
  return parts.map((p) => {
    const n = Number(p);
    expect(Number.isInteger(n) && n >= 0 && n <= 255).toBe(true);
    return n;
  }) as RGB;
}

const lightBlock = blockCarrying(':root', '--mr-change');
const darkBlock = blockCarrying('\\.dark', '--mr-change');
const lightInk = tokens(lightBlock, 'mr');
const darkInk = tokens(darkBlock, 'mr');

/** The per-role alpha, read off the `.mr-wash-*` rule rather than restated here — the test must
 *  measure what the page actually paints, not what somebody remembered writing. */
function alphaFor(role: Role): number {
  const m = new RegExp(`\\.mr-wash-${role}\\s*\\{[^}]*rgb\\(var\\(--mr-${role}\\)\\s*/\\s*([\\d.]+)\\)`).exec(
    CSS,
  );
  if (m == null) throw new Error(`no .mr-wash-${role} rule in index.css`);
  return Number(m[1]);
}

describe('the four resolver roles', () => {
  it('declares all four in both themes, space-separated', () => {
    for (const role of ROLES) {
      expect(lightInk[role], `light --mr-${role}`).toBeTypeOf('string');
      expect(darkInk[role], `dark --mr-${role}`).toBeTypeOf('string');
      channels(lightInk[role]!);
      channels(darkInk[role]!);
    }
  });

  it('clears AA as ink on its own wash, in both themes', () => {
    for (const role of ROLES) {
      const alpha = alphaFor(role);
      const light = channels(lightInk[role]!);
      const dark = channels(darkInk[role]!);
      expect(contrastRatio(light, over(light, alpha, LIGHT_BG)), `light ${role} on wash`).toBeGreaterThanOrEqual(
        AA_BODY,
      );
      expect(contrastRatio(dark, over(dark, alpha, DARK_BG)), `dark ${role} on wash`).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    }
  });

  it('clears AA as ink on the bare page, in both themes', () => {
    // The strip's state word sits on the page, not on its own wash — that is the second direction
    // the plan's table measures, and the one a wash-only test would miss.
    for (const role of ROLES) {
      expect(contrastRatio(channels(lightInk[role]!), LIGHT_BG), `light ${role} on page`).toBeGreaterThanOrEqual(
        AA_BODY,
      );
      expect(contrastRatio(channels(darkInk[role]!), DARK_BG), `dark ${role} on page`).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    }
  });

  it('does not borrow the AI accent for a conflict', () => {
    // ⚠ vermilion is the AI surface's accent and the Pro badge draws in it. A merge conflict is
    // not something a model produced, and sharing the hue would say it was.
    const aiSignal = blockCarrying(':root', '--ai-signal');
    const ai = tokens(aiSignal, 'ai')['signal'];
    expect(ai).toBeTypeOf('string');
    expect(lightInk['conflict']).not.toBe(ai);
  });
});

describe('the resolver’s syntax colours', () => {
  const HL = ['keyword', 'string', 'comment', 'number', 'title', 'type', 'meta'] as const;
  const lightHl = tokens(blockCarrying('\\.mr-code', '--mr-hl-keyword'), 'mr-hl');
  const darkHl = tokens(blockCarrying('\\.dark \\.mr-code', '--mr-hl-keyword'), 'mr-hl');

  /** Every ground a code cell can sit on: the page and the four washes. */
  function grounds(inks: Record<string, string>, page: RGB): RGB[] {
    return [page, ...ROLES.map((role) => over(channels(inks[role]!), alphaFor(role), page))];
  }

  it('clears AA on the page and on every wash, in both themes', () => {
    // ⚠ `highlight.js/styles/github-dark.css` is imported globally and every other consumer paints
    // it on a fixed #0d1117 ground. The resolver's cells sit on the washes above, which are
    // near-white in light mode — github-dark's #a5d6ff strings measure 1.3:1 there. Hence the
    // scoped `.mr-code` palette, and hence this measurement.
    for (const name of HL) {
      const light = hexToRgb(lightHl[name]!);
      for (const ground of grounds(lightInk, LIGHT_BG)) {
        expect(contrastRatio(light, ground), `light ${name}`).toBeGreaterThanOrEqual(AA_BODY);
      }
      const dark = hexToRgb(darkHl[name]!);
      for (const ground of grounds(darkInk, DARK_BG)) {
        expect(contrastRatio(dark, ground), `dark ${name}`).toBeGreaterThanOrEqual(AA_BODY);
      }
    }
  });

  it('clears the syntax theme’s own background out of the way', () => {
    // github-dark sets a background on `.hljs` itself. Inside a resolver cell the WASH is the
    // ground and it encodes a state, so a syntax theme painting over it would delete the state.
    expect(CSS).toMatch(/\.mr-code \.hljs,\s*\n\s*\.mr-code code\.hljs \{\s*\n\s*background: transparent;/);
  });
});
