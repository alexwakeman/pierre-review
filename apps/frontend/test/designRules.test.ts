import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// THE REDESIGN'S RULES, HELD FROM THE SOURCE (docs/redesign/DESIGN.md § 2, § 3, § 4).
//
// The type scale is FOUR sizes (text-meta / body / title / display) and the colours are the
// `--ui-*` roles. A codemod moved the SPA onto them; these checks keep it there:
//
//  • NO arbitrary pixel text size and no Tailwind size off the scale (text-xs / sm / base / lg …)
//    anywhere in src — a new one fails here, by file and line.
//  • RAW PALETTE CLASSES ARE A RATCHET. A handful remain on purpose (measured contrast pairs the
//    conflict resolver's tests pin, a few chart/marker inks); the count may only go DOWN. Lower
//    `PALETTE_CEILING` when you remove one.

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC);

/** Strip comments so prose that names an old class does not count. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the four type sizes', () => {
  it('no arbitrary pixel text size and no off-scale Tailwind size', () => {
    const bad: string[] = [];
    const re = /(?<![\w-])((?:[a-z-]+:)*)text-(\[\d+(?:\.\d+)?px\]|xs|sm|base|lg|xl|2xl|3xl)(?![\w-])/g;
    for (const f of files) {
      const lines = code(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(re)) bad.push(`${f.replace(SRC, 'src')}:${i + 1} ${m[0]}`);
      });
    }
    expect(bad, 'use text-meta (12) / text-body (13) / text-title (15) / text-display (22)').toEqual([]);
  });
});

describe('raw palette classes', () => {
  const PALETTE_CEILING = 18;
  it(`may only go down (ceiling ${PALETTE_CEILING})`, () => {
    const re =
      /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|divide)-(?:gray|slate|zinc|neutral|stone|sky|blue|cyan|emerald|green|lime|teal|amber|yellow|orange|red|rose)-\d{2,3}(?![\w-])/g;
    let n = 0;
    const where: string[] = [];
    for (const f of files) {
      const hits = code(readFileSync(f, 'utf8')).match(re) ?? [];
      if (hits.length > 0) where.push(`${f.replace(SRC, 'src')}: ${hits.length}`);
      n += hits.length;
    }
    expect(n, `map new colours to the --ui-* roles instead:\n${where.join('\n')}`).toBeLessThanOrEqual(PALETTE_CEILING);
  });
});
