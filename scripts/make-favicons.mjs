#!/usr/bin/env node
// Render the Limn mark — the `group` sprite, the same one the header wordmark draws — into
// every favicon the two apps serve. Run by hand after a change to the sprite:
//
//     node scripts/make-favicons.mjs
//
// ⚠ THE GRID IS READ OUT OF `apps/landing/src/lib/sprites.ts`, NOT COPIED HERE. That file's
// `SOURCE.group` is already duplicated by hand into apps/frontend/src/components/Wordmark.tsx
// (see that file's header — the two drift silently). A third transcription would be a third
// thing to keep in step, so this parses the one on disk and asserts its shape instead: a grid
// that is not 11x9, or that has lost its single accent run, throws rather than quietly
// emitting a wrong icon.
//
// WHY AN OPAQUE TILE. A PNG favicon gets no theme signal — there is no prefers-color-scheme
// for a tab icon — so a transparent mark is invisible on half the browsers it lands in. The
// tile carries its own ground, which is what the script-"P" it replaces did too; the colours
// below are that icon's exact ink and ground, so only the mark changes.

import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The near-black page ground and gray-100 ink the outgoing favicons already used.
const GROUND = [0x02, 0x07, 0x11];
const INK = [0xf3, 0xf4, 0xf6];
// The wordmark's DARK-ground vermilion (`dark:fill-[#F26B4E]`). The tile is near-black, so
// this is the half of the pair that belongs here — #C13A20 is the light-ground one.
const ACCENT = [0xf2, 0x6b, 0x4e];

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** Pull `SOURCE.group`'s `rows: [...]` string literals out of the landing's sprite table. */
function readGroupSprite() {
  const path = join(repoRoot, 'apps', 'landing', 'src', 'lib', 'sprites.ts');
  const src = readFileSync(path, 'utf8');
  const at = src.indexOf('group: {');
  if (at < 0) throw new Error(`no \`group:\` entry in ${relative(repoRoot, path)}`);
  const open = src.indexOf('rows: [', at);
  const close = src.indexOf('],', open);
  if (open < 0 || close < 0) throw new Error('could not find group.rows');
  // Only the quoted literals — the block is interleaved with comment lines.
  const rows = [...src.slice(open, close).matchAll(/'([.xa]*)'/g)].map((m) => m[1]);

  // Assert the shape rather than trust the parse: this script writes binaries nobody reads
  // back, so a silent degradation here ships a wrong mark to every tab.
  const w = Math.max(...rows.map((r) => r.length));
  if (rows.length !== 9 || w !== 11) {
    throw new Error(`expected an 11x9 group sprite, parsed ${w}x${rows.length}`);
  }
  if (!rows.some((r) => r.includes('a'))) throw new Error('parsed grid has no accent run');
  return rows.map((r) => r.padEnd(w, '.'));
}

// ---------------------------------------------------------------------------
// A minimal PNG writer (8-bit RGBA, one IDAT, no filtering)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4 + 1; // +1 filter byte per scanline
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter 0 (none) — flat colour, nothing to predict
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Nearest-neighbour by construction — the mark is pixel art and every edge stays hard. */
function render(rows, size, scale) {
  const gw = rows[0].length;
  const gh = rows.length;
  const originX = Math.floor((size - gw * scale) / 2);
  const originY = Math.floor((size - gh * scale) / 2);

  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = GROUND[0];
    px[i * 4 + 1] = GROUND[1];
    px[i * 4 + 2] = GROUND[2];
    px[i * 4 + 3] = 0xff;
  }
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = rgb[0];
    px[i + 1] = rgb[1];
    px[i + 2] = rgb[2];
  };
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const ch = rows[gy][gx];
      if (ch !== 'x' && ch !== 'a') continue;
      const rgb = ch === 'a' ? ACCENT : INK;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          put(originX + gx * scale + dx, originY + gy * scale + dy, rgb);
        }
      }
    }
  }
  return encodePng(size, px);
}

// `scale` is chosen per size, never derived, so every icon lands on whole pixels.
//
// ⚠ icon-512 IS DECLARED `purpose: "any maskable"` in site.webmanifest, and a maskable icon is
// cropped to a circle 80% of the icon's width. An 11x9 grid at scale s has a half-diagonal of
// 7.11s, which has to stay inside that circle's 204.8px radius — so s <= 28. That is why the
// 512 sits at ~60% width where the rest sit at ~67-69%: it is the only one that gets cropped.
const SPA = join(repoRoot, 'apps', 'frontend', 'public');
const LANDING = join(repoRoot, 'apps', 'landing', 'public');

// Both public dirs carry the small icons because BOTH get served at a root: locally the SPA's
// own `public` is the static root, while in cloud `/` is the landing and `/app` is the SPA, so
// a root-absolute `/favicon-32.png` resolves into a different directory in each mode.
const TARGETS = [
  { file: 'favicon-16.png', size: 16, scale: 1, dirs: [SPA, LANDING] },
  { file: 'favicon-32.png', size: 32, scale: 2, dirs: [SPA, LANDING] },
  { file: 'favicon-48.png', size: 48, scale: 3, dirs: [SPA, LANDING] },
  { file: 'apple-touch-icon.png', size: 180, scale: 11, dirs: [SPA, LANDING] },
  { file: 'icon-192.png', size: 192, scale: 12, dirs: [LANDING] },
  { file: 'icon-512.png', size: 512, scale: 28, dirs: [LANDING] },
];

const rows = readGroupSprite();
console.log(`mark: ${rows[0].length}x${rows.length} from apps/landing/src/lib/sprites.ts`);
for (const { file, size, scale, dirs } of TARGETS) {
  const png = render(rows, size, scale);
  for (const dir of dirs) {
    writeFileSync(join(dir, file), png);
    console.log(`  ${relative(repoRoot, join(dir, file))}  ${size}px @${scale}x  ${png.length}B`);
  }
}
