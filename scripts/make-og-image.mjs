#!/usr/bin/env node
// Render the landing's social preview card (apps/landing/public/og-image.png, 2400x1260: the
// 1200x630 Open Graph size at 2x). Run by hand after a change to the hero's words or picture:
//
//     node scripts/make-og-image.mjs
//
// WHY A CARD, NOT A SCREENSHOT. The landing shows no product screenshots (every picture of the app
// is a clickable HTML mock), so the preview a link unfurls to is the hero itself: the same claim,
// the same Chain picture, the same tiles, fonts and spectrum as the board (apps/landing/src/board.css).
// The Chain is drawn by the landing's own arc geometry (components/arcs/geometry.ts, imported with
// Node's type stripping) and the mark by packages/shared brand-mark.ts, so neither can drift.
// ⚠ The words here are the hero's (components/board/Hero.tsx). Change them in the same commit.
//
// Everything is inlined as data: URLs, so the page needs no server and no network.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chainQuarters, quartersToSvg, SITE_CHAIN } from '../apps/landing/src/components/arcs/geometry.ts';
import { brandMarkSvg } from '../packages/shared/src/brand-mark.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const landing = join(root, 'apps', 'landing');
const data = (path, type) => `data:${type};base64,${readFileSync(join(landing, path)).toString('base64')}`;

const font = (w) => `@font-face { font-family: 'Albert Sans'; font-weight: ${w};
  src: url(${data(`src/fonts/albert-sans-latin-${w}-normal.woff2`, 'font/woff2')}) format('woff2'); }`;

// The hero's own Chain (geometry.ts SITE_CHAIN), assembled, so the card cannot drift from the page.
function chainSvg() {
  const c = chainQuarters(100, SITE_CHAIN.steps, SITE_CHAIN.first, SITE_CHAIN.margin, SITE_CHAIN.cross, SITE_CHAIN.reach, SITE_CHAIN.scatter);
  return quartersToSvg(`0 0 ${c.width} ${c.height}`, c.quarters);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${font(400)} ${font(500)} ${font(600)}
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; background: #0f1012; }
body { padding: 10px; display: grid; gap: 8px; grid-template-columns: 1fr 380px; grid-template-rows: 1fr 150px;
  font-family: 'Albert Sans', system-ui, sans-serif; color: #f1f1ef; }
.tile { overflow: hidden; }
.say { background: #000; padding: 46px 52px; display: flex; flex-direction: column; grid-row: 1 / 3; }
.kick { font-size: 21px; font-weight: 500; color: #a9a69f; letter-spacing: 0.01em; display: flex; align-items: center; gap: 12px; }
.kick svg { width: 34px; height: 34px; }
.kick b { color: #f1f1ef; font-weight: 600; }
h1 { font-size: 76px; line-height: 1.0; font-weight: 600; letter-spacing: -0.035em; margin-top: 30px; }
.lead { font-size: 25px; line-height: 1.35; color: #dcdad5; margin-top: 26px; max-width: 640px; }
.foot { margin-top: auto; display: flex; align-items: center; gap: 22px; }
code { font: 500 22px ui-monospace, SFMono-Regular, Menlo, monospace; background: #24252a; color: #f1f1ef;
  padding: 12px 18px; }
.url { font-size: 22px; color: #a9a69f; }
.art { background: #000; padding: 18px; display: flex; align-items: center; justify-content: center; }
.art svg { width: 100%; height: 100%; }
.motto { background: linear-gradient(120deg, #ff6a00 0%, #fe9c00 45%, #ffcf00 100%); color: #121110;
  padding: 22px 26px; display: flex; flex-direction: column; justify-content: center; }
.motto p { font-size: 17px; line-height: 1.25; font-weight: 500; letter-spacing: -0.01em; }
.motto span { font-size: 14px; margin-top: 6px; color: #2a1d05; }
</style></head><body>
<div class="tile say">
  <p class="kick">${brandMarkSvg(4)}<span><b>Ensemble</b> · a software factory on your own machine</span></p>
  <h1>Refine, build and review as an ensemble.</h1>
  <p class="lead">You decide what to build. Ensemble does the prompting, checking and re-reviewing, with your own Claude or Codex, on your machine.</p>
  <div class="foot"><code>npx ensemble-review</code><span class="url">ensemble.ac</span></div>
</div>
<div class="tile art">${chainSvg()}</div>
<div class="tile motto"><p>“It is the harmony of the diverse parts … that permits us to see both the ensemble and the details.”</p><span>Henri Poincaré, <i>Science and Method</i>, 1908</span></div>
</body></html>`;

// CHROMIUM_PATH: a Chrome binary other than the one this Playwright downloaded.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const out = join(landing, 'public', 'og-image.png');
  await page.screenshot({ path: out });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
