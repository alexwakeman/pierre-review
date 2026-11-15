#!/usr/bin/env node
// Render the Ensemble mark (one banded quarter-circle in the ember run) into every
// favicon and app icon the two apps serve, plus the landing's transparent header mark.
// Run by hand after a change to the mark:
//
//     node scripts/make-favicons.mjs
//
// ⚠ THE MARK IS READ FROM packages/shared/src/brand-mark.ts (`brandMarkSvg`), the ONE
// definition the app's Wordmark also draws. Node imports it with type stripping, so that
// file must stay erasable TypeScript. Never hand-edit an icon this script writes.
//
// WHY AN OPAQUE TILE. A PNG favicon gets no theme signal (there is no prefers-color-scheme
// for a tab icon), so every icon carries its own ground: the landing's --bg. Only
// /mark.svg, which the landing header places on its own black tile, is transparent.
//
// The band count drops with size: three bands at 16-32px stay distinct in a tab slot;
// large icons get six.

import { writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BRAND_GROUND, brandMarkSvg } from '../packages/shared/src/brand-mark.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPA = join(repoRoot, 'apps', 'frontend', 'public');
const LANDING = join(repoRoot, 'apps', 'landing', 'public');

// Both public dirs carry the small icons because BOTH get served at a root: locally the SPA's
// own `public` is the static root, while on ensemble.ac `/` is the landing.
//
// ⚠ icon-512 IS DECLARED `purpose: "any maskable"` in site.webmanifest, and a maskable icon is
// cropped to a circle 80% of the icon's width. The mark reaches into the corners of its box, so
// the 512 draws it at 56% (inset .22) to keep every band inside that circle.
const TARGETS = [
  { file: 'favicon-16.png', size: 16, bands: 3, inset: 0, dirs: [SPA, LANDING] },
  { file: 'favicon-32.png', size: 32, bands: 3, inset: 0, dirs: [SPA, LANDING] },
  { file: 'favicon-48.png', size: 48, bands: 4, inset: 0, dirs: [SPA, LANDING] },
  { file: 'apple-touch-icon.png', size: 180, bands: 6, inset: 0.12, dirs: [SPA, LANDING] },
  { file: 'icon-192.png', size: 192, bands: 6, inset: 0.12, dirs: [LANDING] },
  { file: 'icon-512.png', size: 512, bands: 6, inset: 0.22, dirs: [LANDING] },
];

const wrote = [];
const write = (dir, file, data) => {
  const out = join(dir, file);
  writeFileSync(out, data);
  wrote.push(relative(repoRoot, out));
};

// The vector icons: the tab icon (opaque, three bands) and the landing's header mark.
for (const dir of [SPA, LANDING]) write(dir, 'favicon.svg', brandMarkSvg(3, BRAND_GROUND));
write(LANDING, 'mark.svg', brandMarkSvg(4));

// CHROMIUM_PATH: a Chrome binary other than the one this Playwright downloaded.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  for (const t of TARGETS) {
    const pad = Math.round(t.size * t.inset);
    const html = `<!doctype html><html><body style="margin:0;background:${BRAND_GROUND}">
      <div style="width:${t.size}px;height:${t.size}px;box-sizing:border-box;padding:${pad}px">
        <div style="width:100%;height:100%">${brandMarkSvg(t.bands).replace('<svg ', '<svg width="100%" height="100%" ')}</div>
      </div></body></html>`;
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(html);
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: t.size, height: t.size } });
    for (const dir of t.dirs) write(dir, t.file, png);
  }
} finally {
  await browser.close();
}

console.log(`wrote:\n  ${wrote.join('\n  ')}`);
