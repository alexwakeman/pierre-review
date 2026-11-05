import { readFileSync } from 'node:fs';
import { COLOR_SCHEMES, type SchemeMode } from '../src/lib/colorSchemes.js';

// THE COLOUR SCHEMES AS index.css DECLARES THEM — one reader shared by every contrast test, so each
// one measures the same values the page paints (not a copy somebody remembered). Not a test file:
// vitest collects `*.test.ts` only.

export const SCHEME_CSS = readFileSync(new URL('../src/index.css', import.meta.url).pathname, 'utf8');

export interface ParsedScheme {
  id: string;
  label: string;
  mode: SchemeMode;
  /** `--ui-<role>` → `#rrggbb` */
  ui: Record<string, string>;
  /** `--ai-<role>` → `#rrggbb` */
  ai: Record<string, string>;
  /** Raw declared values, to check the space-separated channel form. */
  raw: Record<string, string>;
}

const toHex = (r: string, g: string, b: string): string =>
  `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;

/** Every `--ui-*` / `--ai-*` declared in a rule whose selector list names `[data-scheme='<id>']`,
 *  merged in source order (the defaults declare the two families in two blocks). */
export function parseScheme(id: string): Omit<ParsedScheme, 'label' | 'mode'> {
  const ui: Record<string, string> = {};
  const ai: Record<string, string> = {};
  const raw: Record<string, string> = {};
  for (const m of SCHEME_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    if (!selectors.includes(`[data-scheme='${id}']`)) continue;
    for (const d of m[2]!.matchAll(/--(ui|ai)-([a-z0-9-]+):\s*([^;]+);/g)) {
      raw[`${d[1]}-${d[2]}`] = d[3]!.trim();
      const c = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(d[3]!.trim());
      if (c == null) continue;
      (d[1] === 'ui' ? ui : ai)[d[2]!] = toHex(c[1]!, c[2]!, c[3]!);
    }
  }
  return { id, ui, ai, raw };
}

export const SCHEMES: ParsedScheme[] = COLOR_SCHEMES.map((s) => ({ ...parseScheme(s.id), label: s.label, mode: s.mode }));

/** Every page ground of one mode, by scheme id. */
export function pageGrounds(mode: SchemeMode): [string, string][] {
  return SCHEMES.filter((s) => s.mode === mode).map((s) => [s.id, s.ui['bg']!]);
}

export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
