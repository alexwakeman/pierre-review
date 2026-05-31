// Regression guard: the marker/cluster an open popover refers to carries a
// persistent "selected" pulse (ev-selected) whenever we're NOT in cross-user
// focus — so it stays locatable on the timeline. In focus the marching-ants
// cross-link ring owns the marker instead (the two must never stack), and
// closing the popover clears the pulse.
//
// Setup + invocation are identical to cluster-back-nav.mjs — see ./README.md.
// Needs the dev server running and a board with a cross-user cluster in view.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFrom = process.env.PW_CORE_DIR
  ? createRequire(pathToFileURL(`${process.env.PW_CORE_DIR}/_resolve.cjs`))
  : createRequire(import.meta.url);
const { chromium } = requireFrom('playwright-core');

const URL = process.env.URL || 'http://localhost:5173/?preset=90d&repos=1';
const CHROME =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADED = process.env.HEADED === '1';

const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED, slowMo: HEADED ? 250 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.route('**/*', (route) => {
  const t = route.request().resourceType();
  if (t === 'media' || t === 'font') return route.abort();
  return route.continue();
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) errors.push('CONSOLE ' + m.text());
});
const fail = (msg) => { console.error('FAIL:', msg); return browser.close().then(() => process.exit(1)); };

// Snapshot the glow state: how many items carry each class, and whether the
// selection halo actually paints (non-empty box-shadow, and not suppressed by an
// overlapping cross-link ring via the :not() guard).
const glow = () => page.evaluate(() => ({
  selected: document.querySelectorAll('.vis-item.ev-selected').length,
  crossLinked: document.querySelectorAll('.vis-item.ev-cross-linked').length,
  haloPaints: (() => {
    const el = document.querySelector(
      '.vis-item.ev-selected:not(.ev-cross-linked) .ev-cluster-inner, .vis-item.ev-selected:not(.ev-cross-linked) .ev-marker-inner',
    );
    return el ? getComputedStyle(el).boxShadow !== 'none' : false;
  })(),
}));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.vis-timeline', { timeout: 20000 });
await page.waitForTimeout(2000);

// Open a cross-user cluster (NOT focused yet) -> the cluster must pulse.
let opened = false;
for (let a = 0; a < 6 && !opened; a++) {
  const c = await page.$('.vis-item.vis-point.ev-cluster:not(.ev-own)');
  if (!c) { await page.waitForTimeout(400); continue; }
  await c.click({ force: true });
  await page.waitForTimeout(450);
  opened = await page.$$eval('.z-50 button.w-full', (b) => b.length >= 2);
}
if (!opened) await fail('no cross-user cluster opened (point URL at a denser repo/zoom)');

const listed = await glow();
console.log('cluster list (not focused):', JSON.stringify(listed));
if (!(listed.selected > 0 && listed.haloPaints && listed.crossLinked === 0)) {
  await fail('selected cluster does not pulse while unfocused');
}

// Pick a comment -> cross-user focus -> the ring owns the marker, no select pulse.
await (await page.$('.z-50 button.w-full')).click({ force: true });
await page.waitForTimeout(1500);
const focused = await glow();
console.log('focused (picked):          ', JSON.stringify(focused));
if (!(focused.crossLinked > 0 && focused.selected === 0)) {
  await fail('focus did not hand the marker to the cross-link ring');
}

// Close the popover -> the pulse must clear.
const close = await page.$('.tl-modal-close');
if (close) await close.click({ force: true });
await page.waitForTimeout(700);
// Closing while focused keeps focus; exit it so we land on the no-selection state.
const exit = await page.$('text=Exit focus');
if (exit) await exit.click({ force: true });
await page.waitForTimeout(800);
const cleared = await glow();
console.log('after close + exit focus:  ', JSON.stringify(cleared));

await browser.close();
const ok = listed.selected > 0 && listed.haloPaints && focused.selected === 0 && cleared.selected === 0 && errors.length === 0;
if (errors.length) console.log('errors:', errors.slice(0, 6));
console.log(`\n${ok ? 'PASS' : 'FAIL'}: selection pulse shows when unfocused, yields to the ring in focus, clears on close`);
process.exit(ok ? 0 : 1);
