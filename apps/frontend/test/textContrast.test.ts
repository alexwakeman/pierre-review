import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// TEXT CONTRAST, ENFORCED FROM THE SOURCE.
//
// A reader reported "major contrast issues in two grey shades" on a chip in dark mode. The pairing
// behind it was `text-gray-300 dark:text-gray-600`, which measures 2.66:1 on the dark page ground
// and 1.60:1 on the light one — against WCAG AA's 4.5:1 for body text. It was not one chip: the
// same pairing appeared at 22 sites, and nothing would have caught the twenty-third.
//
// So the rule is checked here rather than remembered. This test resolves every Tailwind text colour
// the SPA writes, pairs each `text-*` with the `dark:text-*` on the same element, and measures both
// against the ground that element actually sits on.
//
// ⚠ IT MEASURES BOTH THEMES. The failing pairing was WORSE in light mode than in dark, and a reader
// who only ever opens one theme would have reported only half of it.
//
// ⚠ DECORATIVE MARKS ARE EXEMPT, AND THE EXEMPTION IS EXPLICIT. A "·" between two metadata items
// carries nothing the layout does not, and WCAG exempts it — but "exempt" has to be a decision
// somebody wrote down, not an inference from how dim a colour is. Decorative marks go through
// `DECORATIVE_MARK_CLASS` in lib/ui.ts; anything else that is dim has to be legible.
//
// ⚠ WHAT THIS TEST DELIBERATELY DOES *NOT* DO. A first cut measured every `text-*` in the SPA
// against the page ground and reported 756 failures — nearly all of them false. `text-gray-100`
// is not unreadable; it sits inside a dark badge, on a ground this file cannot see from a string
// literal. Static text cannot resolve the ancestor background, so the check is scoped to the ONE
// pattern where the ground is not in doubt: a MUTED PAIRING — a light shade of 300-or-lighter set
// with a dark shade of 600-or-darker. That idiom is only ever dim-text-on-the-page; a badge sets a
// `bg-` on the same element and pairs the other way round. It is the exact shape of the reported
// defect, it admits no false positives, and it leaves brighter text to the rendered-page audit
// (run in a browser against a real screen) rather than guessing here.

/** Tailwind v3 default palette, the shades this SPA actually uses. */
const TW: Record<string, string> = {
  'gray-100': '#f3f4f6', 'gray-200': '#e5e7eb', 'gray-300': '#d1d5db', 'gray-400': '#9ca3af',
  'gray-500': '#6b7280', 'gray-600': '#4b5563', 'gray-700': '#374151', 'gray-800': '#1f2937',
  'gray-900': '#111827', 'gray-950': '#030712',
  'slate-300': '#cbd5e1', 'slate-400': '#94a3b8', 'slate-500': '#64748b', 'slate-600': '#475569',
  'zinc-400': '#a1a1aa', 'zinc-500': '#71717a', 'zinc-600': '#52525b',
  'neutral-400': '#a3a3a3', 'neutral-500': '#737373',
};

/** The page grounds. `bg-white` in light, `dark:bg-gray-950` in dark — see index.css / App.tsx. */
const LIGHT_BG = '#ffffff';
const DARK_BG = '#030712';

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
function luminance(hex: string): number {
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const AA_BODY = 4.5;

/** The opt-out, spelled once. Mirrors `DECORATIVE_MARK_CLASS` in src/lib/ui.ts. */
const DECORATIVE_MARK_TOKEN = 'decorative-mark';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SRC = new URL('../src', import.meta.url).pathname;

interface Violation {
  file: string;
  line: number;
  cls: string;
  theme: 'light' | 'dark';
  ratio: number;
}

/** Every `className`-ish string literal in the SPA, with its line number. */
function classStrings(): { file: string; line: number; value: string }[] {
  const out: { file: string; line: number; value: string }[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((text, i) => {
      // Any quoted run containing a `text-` utility. Template literals included: a conditional
      // className is exactly where a dim colour gets slipped in unnoticed.
      for (const m of text.matchAll(/["'`]([^"'`]*\btext-[a-z]+-\d{2,3}\b[^"'`]*)["'`]/g)) {
        out.push({ file: file.slice(SRC.length + 1), line: i + 1, value: m[1]! });
      }
    });
  }
  return out;
}

function check(): Violation[] {
  const bad: Violation[] = [];
  for (const { file, line, value } of classStrings()) {
    // Decorative marks are exempt BY NAME, never by being dim — see the header.
    if (value.includes(DECORATIVE_MARK_TOKEN)) continue;
    const light = value.match(/(?:^|\s)text-([a-z]+)-(\d{2,3})\b/);
    const dark = value.match(/dark:text-([a-z]+)-(\d{2,3})\b/);
    if (!light || !dark) continue;
    const lightShade = Number(light[2]);
    const darkShade = Number(dark[2]);
    // THE MUTED PAIRING, and only it — see the header for why the check is this narrow.
    if (!(lightShade <= 300 && darkShade >= 600)) continue;
    const lightKey = `${light[1]}-${light[2]}`;
    const darkKey = `${dark[1]}-${dark[2]}`;
    if (TW[lightKey]) {
      const r = contrastRatio(TW[lightKey], LIGHT_BG);
      if (r < AA_BODY) bad.push({ file, line, cls: `text-${lightKey}`, theme: 'light', ratio: r });
    }
    if (TW[darkKey]) {
      const r = contrastRatio(TW[darkKey], DARK_BG);
      if (r < AA_BODY) bad.push({ file, line, cls: `dark:text-${darkKey}`, theme: 'dark', ratio: r });
    }
  }
  return bad;
}

/** A `text-*` with NO `dark:text-*` beside it renders the SAME colour in both themes, so it has to
 *  clear AA against BOTH grounds.
 *
 *  ⚠ SCOPED TO COLOURS MEASURED FAILING ON A REAL SCREEN, not to every unpaired colour. A first cut
 *  flagged every bare `text-gray-400` in light mode at 2.54:1 and was mostly wrong: plenty of them
 *  sit inside a dark panel or a coloured chip, a ground no string literal can resolve. Guessing
 *  there would train a reader to ignore this test, which is worse than not having it.
 *
 *  `gray-500` earns its place empirically: measured at 4.16:1 against the dark page ground in a
 *  browser, on 111 elements, at the moment this was written. It is 0.34 short — invisible as a
 *  single chip, which is exactly why it needed a measurement rather than an eye. Add a colour here
 *  only after measuring it the same way; the rendered-page audit is the instrument, this is the
 *  ratchet that stops a fixed one coming back. */
const UNPAIRED_MEASURED_FAILING: readonly string[] = ['gray-500'];

function checkUnpaired(): Violation[] {
  const bad: Violation[] = [];
  for (const { file, line, value } of classStrings()) {
    if (value.includes(DECORATIVE_MARK_TOKEN)) continue;
    if (/dark:text-[a-z]+-\d{2,3}/.test(value)) continue;
    const m = value.match(/(?:^|\s)text-([a-z]+-\d{2,3})\b/);
    if (!m || !UNPAIRED_MEASURED_FAILING.includes(m[1]!)) continue;
    for (const [theme, bg] of [['light', LIGHT_BG], ['dark', DARK_BG]] as const) {
      const r = contrastRatio(TW[m[1]!]!, bg);
      if (r < AA_BODY) bad.push({ file, line, cls: `text-${m[1]}`, theme, ratio: r });
    }
  }
  return bad;
}

describe('text contrast', () => {
  it('measures the reported pairing so the numbers in the header are not folklore', () => {
    // `text-gray-300 dark:text-gray-600` — the pairing a reader reported as unreadable.
    expect(contrastRatio(TW['gray-600']!, DARK_BG)).toBeLessThan(3);
    expect(contrastRatio(TW['gray-300']!, LIGHT_BG)).toBeLessThan(2);
    // ...and the replacement, which passes in BOTH themes.
    expect(contrastRatio(TW['gray-500']!, LIGHT_BG)).toBeGreaterThanOrEqual(AA_BODY);
    expect(contrastRatio(TW['gray-400']!, DARK_BG)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('a colour used in BOTH themes clears AA in both — the unpaired case', () => {
    // ⚠ THE SUBTLE HALF OF THE SAME DEFECT. The reported chip was obviously broken at 2.66:1; this
    // one is 4.16:1, looks nearly fine, and was on 111 elements. A theme-less colour is a promise
    // that it works on both grounds, and that promise is what this measures.
    const bad = checkUnpaired();
    const report = bad
      .map((v) => `${v.file}:${v.line}  ${v.cls}  ${v.theme} ${v.ratio.toFixed(2)}:1`)
      .join('\n');
    expect(report).toBe('');
  });

  it('no informative text in the SPA falls below AA in either theme', () => {
    const bad = check();
    const report = bad
      .map((v) => `${v.file}:${v.line}  ${v.cls}  ${v.theme} ${v.ratio.toFixed(2)}:1`)
      .join('\n');
    expect(report).toBe('');
  });
});
