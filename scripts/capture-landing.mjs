// Screenshot the built landing pages at desktop + mobile widths to validate
// rendering. Expects `vite preview` (or dev) serving the landing.
//   node scripts/capture-landing.mjs            → all pages, both devices
//   node scripts/capture-landing.mjs mobile     → mobile only
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '.ui-artifacts', 'landing');
mkdirSync(DIR, { recursive: true });
const BASE = process.env.LANDING_BASE ?? 'http://localhost:5280';
const ONLY = process.argv[2]; // 'mobile' | 'desktop' | undefined

const PAGES = [
  ['home', '/'],
  ['features', '/features'],
  ['pro', '/pro'],
  ['pricing', '/pricing'],
  ['how-it-works', '/how-it-works'],
];
const DEVICES = [
  ['desktop', { width: 1440, height: 900 }, 2, false],
  ['mobile', { width: 390, height: 844 }, 3, true],
];

const browser = await chromium.launch({ headless: true });
const results = [];
for (const [dev, viewport, scale, isMobile] of DEVICES) {
  if (ONLY && ONLY !== dev) continue;
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme: 'dark',
    isMobile,
    hasTouch: isMobile,
  });
  const consoleErrors = [];
  for (const [name, path] of PAGES) {
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}/${dev}: ${m.text()}`));
    page.on('pageerror', (e) => consoleErrors.push(`${name}/${dev}: ${String(e)}`));
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // Scroll through the page so native lazy-loaded images fire before the
    // fullPage screenshot (which doesn't scroll on its own).
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
    // Detect horizontal overflow (the classic mobile bug).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: join(DIR, `${name}-${dev}.png`), fullPage: true });
    results.push(`${name}-${dev}: overflowX=${overflow}px`);
    await page.close();
  }
  if (consoleErrors.length) results.push(`CONSOLE ERRORS:\n  ${consoleErrors.join('\n  ')}`);
  await ctx.close();
}
await browser.close();
console.log(results.join('\n'));
console.log(`\nwritten to ${DIR}`);
