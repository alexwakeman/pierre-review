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

// ⚠ NO `SIDE_ROLES` LIST ANY MORE. `change` and `conflict` are still the two hues a SIDE pane can
// wear, but only while its region is UNDECIDED — once a decision is taken a side is `applied` green
// or it is bare, so there is no longer a colour family keyed on "side-ness" for a test to walk.
// See `lib/mergeResolver.ts`'s `panePaint`.

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

/** The alpha the RIBBON paints at, read off its own rule. Same reason as `alphaFor`: the test
 *  measures what the page paints, not what somebody remembered writing.
 *  ⚠ ONE RULE, NOT A FAMILY — every ribbon is the applied green now. */
function ribbonAlpha(): number {
  const m = /\.mr-fill-applied\s*\{[^}]*fill:\s*rgb\(var\(--mr-applied\)\s*\/\s*([\d.]+)\)/.exec(
    CSS,
  );
  if (m == null) throw new Error('no .mr-fill-applied rule in index.css');
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

  it('has no outline family at all, for any role', () => {
    // ⚠ DELETED, NOT MERELY UNUSED, AND THE REASONING IS KEPT IN `index.css`. A side the reader
    // turned down used to drop to a 1px inset outline in its own hue rather than lose its paint,
    // because "this was the other option" and "this pane has nothing here" are different facts.
    // They are — but the outline ringed an untaken block in red beside the green one that won, and
    // a rejected side now paints nothing. A rule left behind here is a colour the next reader
    // would reach for.
    // ⚠ A SELECTOR, NOT A MENTION. `index.css` still NAMES `.mr-edge-*` in the comment recording
    // why it went, and a bare `/\.mr-edge-/` fails on that prose — which would push the next
    // reader to delete the reasoning to get the test green.
    expect(CSS, 'no .mr-edge-* rule may survive').not.toMatch(/^\s*\.mr-edge-[\w-]*\s*[,{]/m);
  });

  it('draws a ribbon that is never fainter than the wash it joins', () => {
    // ⚠ A RIBBON IS MEASURED AGAINST A DIFFERENT FLOOR AGAIN, AND THE REASON IS WRITTEN DOWN SO
    // NOBODY "FIXES" IT TO 4.5 OR 3. It carries no text, so AA does not bind, and it is the FOURTH
    // encoding of a state the wash, the centre's 2px rule and the strip's word already carry —
    // WCAG 1.4.11 exempts a redundant non-text mark. What this pins is that the mark is actually
    // visible: a ribbon sits on the BARE GUTTER with nothing to read on it, so a wash alpha there
    // would be invisible at arm's length, and nobody may silently ship 0.03.
    //
    // ⚠ ONE FAMILY NOW, AND IT IS THE ONE IT JOINS. The ribbon leaves an accepted side and lands on
    // the result, and both of those are `applied` green — so the wash it must not be fainter than
    // is `applied`'s, not a per-type one.
    const RIBBON_FLOOR = 1.25;
    const alpha = ribbonAlpha();
    expect(alpha, '.mr-fill-applied vs the applied wash').toBeGreaterThan(alphaFor('applied'));
    const light = over(channels(lightInk['applied']!), alpha, LIGHT_BG);
    const dark = over(channels(darkInk['applied']!), alpha, DARK_BG);
    expect(contrastRatio(light, LIGHT_BG), 'light ribbon on page').toBeGreaterThanOrEqual(
      RIBBON_FLOOR,
    );
    expect(contrastRatio(dark, DARK_BG), 'dark ribbon on page').toBeGreaterThanOrEqual(
      RIBBON_FLOOR,
    );
  });

  it('paints the ribbon from a CSS class, never an SVG attribute', () => {
    // ⚠ `var()` WORKS AS A CSS PROPERTY AND NOT INSIDE AN SVG PRESENTATION ATTRIBUTE. A path
    // carrying `fill="rgb(var(--mr-applied) / 0.22)"` paints nothing at all, silently — so the
    // fill lives here as a class and `RegionRibbons` only ever sets a class name.
    expect(blockCarrying('\\.mr-fill-applied', 'fill:'), '.mr-fill-applied').toMatch(
      /fill:\s*rgb\(var\(--mr-applied\)\s*\//,
    );
    // ⚠ NO z-index ON THE OVERLAY. It is positioned with z-index `auto`, which paints it UNDER the
    // panes' sticky headers (`z-10`); giving it one would put the ribbons over them. And
    // `pointer-events: none` keeps the gutter's accept arrows clickable underneath.
    const ribbons = blockCarrying('\\.mr-ribbons', 'position:');
    expect(ribbons).toMatch(/pointer-events:\s*none/);
    expect(ribbons).toMatch(/overflow:\s*hidden/);
    expect(ribbons, '.mr-ribbons must not carry a z-index').not.toMatch(/z-index:/);
    // ⚠ AN `<svg>` IS A REPLACED ELEMENT, so CSS 2.1 §10.3.8 gives an absolutely-positioned one
    // its INTRINSIC 300x150 and ignores `right` as over-constrained — `left: 0; right: 0` sizes a
    // div and does NOT size this. Shipped once: correct paths at correct coordinates, every one
    // clipped out of existence by `overflow: hidden` against a 300px box, and 1,420 green tests.
    // Nothing here can measure layout, so this asserts the one declaration that fixed it.
    expect(ribbons, '.mr-ribbons needs an explicit width — left/right do not size an <svg>').toMatch(
      /width:\s*100%/,
    );
  });

  it('has exactly ONE ribbon fill, and it is the applied green', () => {
    // ⚠ THIS TEST IS THE INVERSE OF THE ONE IT REPLACES, AND THE OLD REASONING IS RECORDED RATHER
    // THAN DELETED. It used to assert `.mr-fill-applied` must NOT exist: "a ribbon exists only
    // because a decision was taken, so an `.mr-fill-applied` would be every ribbon there is and the
    // hue would carry nothing." Every ribbon IS applied — that part was right. What changed is that
    // a hue carrying nothing is now the CORRECT outcome: the ribbon joins an accepted side (green)
    // to the result (green), so a type-hued band between them read as a third, different thing.
    expect(CSS, 'the ribbon paints in --mr-applied').toMatch(/\.mr-fill-applied\b/);
    // The per-type fills are gone, and `ignored` never had one: keeping the ancestor takes no
    // side's lines, so there is no linkage to draw.
    expect(CSS).not.toMatch(/\.mr-fill-change\b/);
    expect(CSS).not.toMatch(/\.mr-fill-conflict\b/);
    expect(CSS).not.toMatch(/\.mr-fill-ignored\b/);
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
