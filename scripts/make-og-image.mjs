#!/usr/bin/env node
// Render the landing's social preview card (apps/landing/public/og-image.png, 2400x1260: the
// 1200x630 Open Graph size at 2x). Run by hand after a change to the hero's words or picture:
//
//     node scripts/make-og-image.mjs
//
// WHY A CARD, NOT A SCREENSHOT. The landing shows no product screenshots (every picture of the app
// is a clickable HTML mock), so the preview a link unfurls to is the hero itself: the same claim,
// the same Bach picture, the same tiles, fonts and pigments as the board (apps/landing/src/board.css).
// ⚠ The words here are the hero's (components/board/Hero.tsx). Change them in the same commit.
//
// Everything is inlined as data: URLs, so the page needs no server and no network.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const landing = join(root, 'apps', 'landing');
const data = (path, type) => `data:${type};base64,${readFileSync(join(landing, path)).toString('base64')}`;

const font = (w) => `@font-face { font-family: 'Albert Sans'; font-weight: ${w};
  src: url(${data(`src/fonts/albert-sans-latin-${w}-normal.woff2`, 'font/woff2')}) format('woff2'); }`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${font(400)} ${font(500)} ${font(600)}
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; background: #0f1012; }
body { padding: 10px; display: grid; gap: 8px; grid-template-columns: 1fr 380px; grid-template-rows: 1fr 150px;
  font-family: 'Albert Sans', system-ui, sans-serif; color: #f1f1ef; }
.tile { border-radius: 4px; overflow: hidden; }
.say { background: #1a1b1e; padding: 46px 52px; display: flex; flex-direction: column; grid-row: 1 / 3; }
.kick { font-size: 21px; font-weight: 500; color: #a9a69f; letter-spacing: 0.01em; }
.kick b { color: #d2b071; font-weight: 600; }
h1 { font-size: 76px; line-height: 1.0; font-weight: 600; letter-spacing: -0.035em; margin-top: 30px; }
.lead { font-size: 25px; line-height: 1.35; color: #d8d6d0; margin-top: 26px; max-width: 640px; }
.foot { margin-top: auto; display: flex; align-items: center; gap: 22px; }
code { font: 500 22px ui-monospace, SFMono-Regular, Menlo, monospace; background: #24252a; color: #f1f1ef;
  padding: 12px 18px; border-radius: 4px; }
.url { font-size: 22px; color: #a9a69f; }
.ph { background: #121110; }
.ph img { width: 100%; height: 100%; object-fit: cover; object-position: 50% 40%;
  filter: saturate(0.8) contrast(1.04) brightness(0.88); display: block; }
.motto { background: linear-gradient(135deg, #e2c487 0%, #d2b071 45%, #9a763f 100%); color: #121110;
  padding: 22px 26px; display: flex; flex-direction: column; justify-content: center; }
.motto p { font-size: 21px; line-height: 1.25; font-weight: 500; letter-spacing: -0.01em; }
.motto span { font-size: 15px; margin-top: 8px; opacity: 0.8; }
</style></head><body>
<div class="tile say">
  <p class="kick"><b>Ensemble</b> · an agentic SDLC on your machine</p>
  <h1>Define, build, and review as an ensemble.</h1>
  <p class="lead">From ticket to merged pull request with your own Claude or Codex. It runs fully on your team’s own machines, with no added service.</p>
  <div class="foot"><code>npx ensemble-review</code><span class="url">ensemble.ac</span></div>
</div>
<div class="tile ph"><img src="${data('src/assets/board/img/bach-hand.jpg', 'image/jpeg')}" alt=""></div>
<div class="tile motto"><p>“One hears four sensible people conversing among themselves.”</p><span>Goethe, on the string quartet, 1829</span></div>
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
