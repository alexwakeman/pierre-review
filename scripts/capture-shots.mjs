// Capture the landing-page product screenshots from the ISOLATED demo stack
// (seeded acme/* data — no real GitHub data, no PII). Expects:
//   backend  : DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100  (see seed-demo.ts)
//   frontend : BACKEND_PORT=4100 vite --port 5273
// Writes 2x PNGs into apps/landing/public/shots/.
//
// Run:  node scripts/capture-shots.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'apps', 'landing', 'public');
const SHOTS = join(PUBLIC, 'shots');
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.DEMO_BASE ?? 'http://localhost:5273/app/';
const out = (n) => join(SHOTS, n);

const results = [];
const browser = await chromium.launch({ headless: true });

async function newCtx(viewport = { width: 1600, height: 1000 }, scale = 2, paneHeight) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme: 'dark',
  });
  if (paneHeight) {
    await ctx.addInitScript((h) => {
      localStorage.setItem('pierre:detailPaneHeight', String(h));
    }, paneHeight);
  }
  return ctx;
}

async function openApp(page, query = '') {
  await page.goto(`${BASE}${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.vis-timeline', { timeout: 20000 });
  // dismiss a welcome-back banner if present
  await page
    .getByRole('button', { name: /dismiss|close|got it/i })
    .first()
    .click({ timeout: 800 })
    .catch(() => {});
  await page.waitForTimeout(2600); // lanes / markers / clustering settle
}

const ONLY = process.argv[2]; // optional: capture a single shot by filename
async function shot(name, fn) {
  if (ONLY && name !== ONLY) return;
  try {
    await fn();
    results.push(`✅ ${name}`);
  } catch (err) {
    results.push(`❌ ${name} — ${err.message}`);
  }
}

// 1. Timeline (hero) — default board.
await shot('timeline.png', async () => {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openApp(page);
  await page.screenshot({ path: out('timeline.png') });
  await ctx.close();
});

// 2. Open-PR strip — ensure expanded, element screenshot.
await shot('open-pr-strip.png', async () => {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openApp(page);
  const strip = page.getByTestId('open-pr-strip');
  // expand if collapsed
  const toggle = strip.locator('button[aria-expanded]').first();
  const expanded = await toggle.getAttribute('aria-expanded').catch(() => 'true');
  if (expanded === 'false') {
    await toggle.click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(400);
  await strip.screenshot({ path: out('open-pr-strip.png') });
  await ctx.close();
});

// 3. Feed panel — default home; wait for it to populate from /api/feed.
await shot('feed.png', async () => {
  const ctx = await newCtx({ width: 1200, height: 1200 }, 2, 900);
  const page = await ctx.newPage();
  await openApp(page);
  const feed = page.getByTestId('feed-panel');
  await feed.waitFor({ timeout: 8000 });
  // wait for entries to land
  await page.waitForTimeout(4500);
  await feed.screenshot({ path: out('feed.png') });
  await ctx.close();
});

// 4. My Turn — enter focus via the pill; full board + To-Do list.
await shot('my-turn.png', async () => {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openApp(page);
  await page.getByTestId('myturn-pill').click();
  await page.getByTestId('myturn-panel').waitFor({ timeout: 8000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out('my-turn.png') });
  await ctx.close();
});

// 5. Focus mode — isolate a PR with cross-person activity (#113).
await shot('focus-mode.png', async () => {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openApp(page, '?pr=113');
  await page.getByTestId('detail-pane').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Focus', exact: true }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out('focus-mode.png') });
  await ctx.close();
});

// 6. PR detail — Overview tab of #113, focused on the (taller) detail pane.
await shot('pr-detail.png', async () => {
  const ctx = await newCtx({ width: 1600, height: 1200 }, 2, 920);
  const page = await ctx.newPage();
  await openApp(page, '?pr=113');
  const pane = page.getByTestId('detail-pane');
  await pane.waitFor({ timeout: 8000 });
  await page.waitForTimeout(1500);
  await pane.screenshot({ path: out('pr-detail.png') });
  await ctx.close();
});

// 7. Claude Review — the findings tab of #113, focused on the (taller) detail pane.
await shot('claude-review.png', async () => {
  const ctx = await newCtx({ width: 1600, height: 1200 }, 2, 920);
  const page = await ctx.newPage();
  await openApp(page, '?pr=113');
  const pane = page.getByTestId('detail-pane');
  await pane.waitFor({ timeout: 8000 });
  // The PR-detail "Claude Review" TAB (singular) — NOT the header "Claude Reviews"
  // (plural) button, which opens a cross-PR modal. Scope to the detail pane + exact.
  await pane.getByText('Claude Review', { exact: true }).first().click({ timeout: 4000 });
  await page.waitForTimeout(2200);
  await pane.screenshot({ path: out('claude-review.png') });
  await ctx.close();
});

// 8. Insights panel — per-repo snapshot dialog.
await shot('insights-panel.png', async () => {
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openApp(page);
  await page.getByRole('button', { name: 'Insights', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Insights' });
  await dialog.waitFor({ timeout: 8000 });
  await page.waitForTimeout(1500);
  await dialog.screenshot({ path: out('insights-panel.png') });
  await ctx.close();
});

// 9. Analytics — the charts modal (tall viewport so all charts fit, no inner scroll).
await shot('analytics.png', async () => {
  const ctx = await newCtx({ width: 1280, height: 2400 });
  const page = await ctx.newPage();
  await openApp(page);
  await page.getByRole('button', { name: 'Insights', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Insights' }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: /Charts/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Repo analytics' });
  await dialog.waitFor({ timeout: 8000 });
  await page.waitForTimeout(2500); // chart render
  await dialog.screenshot({ path: out('analytics.png') });
  await ctx.close();
});

// 10. OG image — timeline at 1200x630 (social card).
await shot('og-image.png', async () => {
  const ctx = await newCtx({ width: 1200, height: 630 }, 1);
  const page = await ctx.newPage();
  await openApp(page);
  // The social card lives at the public root (/og-image.png), not under /shots.
  await page.screenshot({ path: join(PUBLIC, 'og-image.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await ctx.close();
});

await browser.close();
console.log(results.join('\n'));
console.log(`\nShots written to ${SHOTS}`);
