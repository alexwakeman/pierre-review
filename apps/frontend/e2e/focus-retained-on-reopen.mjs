// Regression guard: opening another cluster while a focus is active must KEEP
// the focus (and the timeline's scroll position) — not re-expand every row and
// snap to the top, losing the cluster you just clicked.
//
// THE BUG (fixed): in cross-user focus mode, clicking another cluster ran
// openPopover -> applyContext(null), which cleared the focus, re-expanded all
// rows, and reset the vertical scroll to 0. The fix preserves an active row
// focus when opening another marker/cluster (a picked single event re-targets
// the focus; a cluster list keeps it), so the view stays put.
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

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !HEADED,
  slowMo: HEADED ? 250 : 0,
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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

const fail = (msg) => {
  console.error('FAIL:', msg);
  return browser.close().then(() => process.exit(1));
};
const visRows = () =>
  page.$$eval('.vis-foreground .vis-group', (g) => g.filter((el) => el.offsetHeight > 0).length);
const exitFocusShown = () => page.$('text=Exit focus').then((h) => !!h);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.vis-timeline', { timeout: 20000 });
await page.waitForTimeout(2000);

const allRows = await visRows();
console.log(`board: ${allRows} rows`);

// Open a cross-user cluster (retry — vis swallows the occasional click).
let opened = false;
for (let a = 0; a < 6 && !opened; a++) {
  const c = await page.$('.vis-item.vis-point.ev-cluster:not(.ev-own)');
  if (!c) {
    await page.waitForTimeout(400);
    continue;
  }
  await c.click({ force: true });
  await page.waitForTimeout(450);
  opened = await page.$$eval('.z-50 button.w-full', (b) => b.length >= 2);
}
if (!opened) await fail('no cross-user cluster opened (point URL at a denser repo/zoom)');

// Pick a comment -> enters the two-person focus.
await (await page.$('.z-50 button.w-full')).click({ force: true });
await page.waitForTimeout(1500);
const focusedRows = await visRows();
if (!(focusedRows < allRows) || !(await exitFocusShown())) {
  await fail(`picking did not enter focus (rows ${focusedRows}/${allRows}, exitFocus ${await exitFocusShown()})`);
}
console.log(`focused: ${focusedRows} rows, Exit-focus shown`);

// Close the popover (X) — focus must persist.
const close = await page.$('.tl-modal-close');
if (close) await close.click({ force: true });
await page.waitForTimeout(600);
if ((await visRows()) !== focusedRows || !(await exitFocusShown())) {
  await fail('closing the popover (X) dropped the focus');
}

// THE REGRESSION: click a cluster again while focused. Focus + row count must be
// unchanged (no re-expand, no scroll snap).
const again = await page.$('.vis-item.vis-point.ev-cluster:not(.ev-own)') || await page.$('.vis-item.vis-point.ev-cluster');
if (!again) await fail('no cluster available to re-click while focused');
await again.click({ force: true });
await page.waitForTimeout(1500);

const afterRows = await visRows();
const afterExit = await exitFocusShown();
console.log(`after re-click: ${afterRows} rows, Exit-focus ${afterExit}`);
if (errors.length) console.log('errors:', errors.slice(0, 8));

await browser.close();
const ok = afterRows === focusedRows && afterExit === true && errors.length === 0;
console.log(
  `\n${ok ? 'PASS' : 'FAIL'}: focus ${ok ? 'retained' : 'LOST'} on re-open ` +
    `(rows ${afterRows}, expected ${focusedRows}; expanded-to-full would be ${allRows})`,
);
process.exit(ok ? 0 : 1);
