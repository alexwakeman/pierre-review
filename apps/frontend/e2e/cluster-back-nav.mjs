// Perf reproduction + regression guard for the timeline cluster-popover
// "back" navigation.
//
// THE BUG (fixed): on a board with many contributor rows, clicking a cross-user
// cluster, picking a comment (which collapses the timeline to a two-person
// focus), then pressing "‹ back" froze the main thread for ~2s. Root cause:
// leaving focus re-showed every collapsed row via a per-row
// `groupsData.update({ visible: true })`, and vis-timeline's `Group.setData`
// re-parses the row label's `innerHTML` on every such update — hundreds of
// synchronous re-parses + redraws. The fix made row labels cached DOM elements
// (cheap re-append instead of re-parse) and batched the visibility toggles into
// a single update per direction.
//
// This script drives the REAL app via system Chrome (Playwright), reproduces the
// exact gesture, and measures main-thread blocking (PerformanceObserver
// `longtask`) during the back press. It asserts the worst single block stays
// under a threshold so the regression can't silently return.
//
// PREREQUISITES
//   1. Dev server running:  pnpm dev   (frontend :5173, backend :4000)
//   2. A board that renders at least one CROSS-USER cluster (one person's
//      comments on another person's PR, bunched at the current zoom). The
//      default URL below (single repo, 90-day zoom) reliably produces one on a
//      busy repo; override with URL=... for your data.
//   3. playwright-core available. It downloads NO browsers and drives the system
//      Google Chrome, so it's a fast, dependency-light install:
//        mkdir -p /tmp/pw && cd /tmp/pw && \
//          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright-core
//      then run from there:  node <repo>/apps/frontend/e2e/cluster-back-nav.mjs
//
// CONFIG (env): URL, CHROME (executable path), HEADED=1, THRESHOLD_MS (default 600).

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve playwright-core (CommonJS) without forcing it into the repo's deps.
// Default: resolve relative to this file (works if it's installed in the repo).
// PW_CORE_DIR=<dir>: resolve from a throwaway install's node_modules (see README).
const requireFrom = process.env.PW_CORE_DIR
  ? createRequire(pathToFileURL(`${process.env.PW_CORE_DIR}/_resolve.cjs`))
  : createRequire(import.meta.url);
const { chromium } = requireFrom('playwright-core');

const URL = process.env.URL || 'http://localhost:5173/?preset=90d&repos=1';
const CHROME =
  process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADED = process.env.HEADED === '1';
const THRESHOLD_MS = Number(process.env.THRESHOLD_MS || 600);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !HEADED,
  slowMo: HEADED ? 250 : 0,
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
// Block heavy assets so the board renders instantly and the console stays clean.
await ctx.route('**/*', (route) => {
  const t = route.request().resourceType();
  if (t === 'image' || t === 'media' || t === 'font') return route.abort();
  return route.continue();
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) {
    errors.push('CONSOLE ' + m.text());
  }
});

function fail(msg) {
  console.error('FAIL:', msg);
  return browser.close().then(() => process.exit(1));
}

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.vis-timeline', { timeout: 20000 });
await page.waitForTimeout(2000); // let markers + clusters settle

const rowCount = await page.$$eval('.vis-foreground .vis-group', (g) => g.length);
console.log(`board: ${rowCount} group rows rendered`);

// Open a CROSS-USER cluster (it's the cross-user kind that triggers the
// focus-collapse on pick — own-work clusters don't). vis renders each point item
// twice (a positioned `.vis-point` and a zero-size `.vis-dot`); click the sized
// one. vis routes clicks through Hammer, so a real ElementHandle click is needed
// (page.mouse.click is not recognised). Retry — a redraw can swallow a click.
let opened = false;
for (let attempt = 0; attempt < 6 && !opened; attempt++) {
  const cluster = await page.$('.vis-item.vis-point.ev-cluster:not(.ev-own)');
  if (!cluster) {
    await page.waitForTimeout(400);
    continue;
  }
  await cluster.click({ force: true });
  await page.waitForTimeout(450);
  opened = await page.$$eval('.z-50 button.w-full', (b) => b.length >= 2);
}
if (!opened) {
  await fail(
    'no cross-user cluster opened — this board may have none in view. ' +
      'Set URL=... to a denser repo/zoom (e.g. ?preset=90d&repos=<id>).',
  );
}
console.log('opened cross-user cluster list');

// Pick the first comment -> drills in and collapses to the two-person focus.
await (await page.$('.z-50 button.w-full')).click({ force: true });
await page.waitForTimeout(1600); // let the collapse + scroll settle

const focusRows = await page.$$eval(
  '.vis-foreground .vis-group',
  (g) => g.filter((el) => el.offsetHeight > 0).length,
);
console.log(`focused: ${focusRows} rows visible (collapsed from ${rowCount})`);
if (focusRows >= rowCount) {
  await fail('picking the comment did not collapse the timeline to a focus');
}

// MEASURE: press "‹ back" and record main-thread long tasks until the cluster
// list is back and the thread is quiet again.
await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration });
  }).observe({ entryTypes: ['longtask'] });
  window.__t0 = performance.now();
});
const back = await page.evaluateHandle(() => {
  const m = document.querySelector('.z-50');
  return m ? [...m.querySelectorAll('button')].find((b) => /back to/.test(b.textContent || '')) || null : null;
});
if (!back.asElement()) await fail('no "back to N events" button found in the popover');
await back.asElement().click({ force: true });

const result = await page.evaluate(async () => {
  const t0 = window.__t0;
  const isList = () => {
    const m = document.querySelector('.z-50');
    return m ? [...m.querySelectorAll('button')].filter((b) => /w-full/.test(b.className)).length >= 2 : false;
  };
  let listAt = null;
  const deadline = performance.now() + 9000;
  while (performance.now() < deadline) {
    if (listAt == null && isList()) listAt = performance.now();
    if (listAt != null) {
      const last = window.__lt[window.__lt.length - 1];
      const quiet = !last || performance.now() - (last.start + last.dur) > 500;
      if (quiet && performance.now() - listAt > 500) break;
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  const lt = window.__lt;
  return {
    listVisibleMs: listAt != null ? Math.round(listAt - t0) : null,
    blockTotalMs: Math.round(lt.reduce((s, e) => s + e.dur, 0)),
    blockMaxMs: Math.round(lt.reduce((m, e) => Math.max(m, e.dur), 0)),
    taskCount: lt.length,
  };
});

// Verify it actually returned to the list AND re-expanded the rows.
const afterRows = await page.$$eval(
  '.vis-foreground .vis-group',
  (g) => g.filter((el) => el.offsetHeight > 0).length,
);
console.log('back-nav result:', JSON.stringify(result));
console.log(`after back: ${afterRows} rows visible (rows re-expanded: ${afterRows > focusRows + 5})`);
if (errors.length) console.log('console/page errors:', errors.slice(0, 8));

await browser.close();

const ok =
  result.blockMaxMs <= THRESHOLD_MS &&
  afterRows > focusRows + 5 &&
  errors.length === 0;
console.log(
  `\n${ok ? 'PASS' : 'FAIL'}: worst main-thread block ${result.blockMaxMs}ms ` +
    `(threshold ${THRESHOLD_MS}ms), total ${result.blockTotalMs}ms across ${result.taskCount} tasks`,
);
process.exit(ok ? 0 : 1);
