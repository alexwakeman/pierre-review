// The ONE way anything photographs or films the demo stack.
//
// WHY THIS FILE EXISTS. `capture-shots.mjs` and `capture-demo-video.mjs` both
// open the same seeded app and both depend on the same four invisible decisions:
// the viewport width, the colour scheme, reduced motion, and the localStorage
// seed that suppresses the first-run tour. If those drift apart, the stills and
// the video stop being pictures of the same product — a 1180px still beside a
// 1440px clip, or a clip with the onboarding banner the stills never show. So
// they live here once and both callers import them.
//
// A NARROW VIEWPORT IS THE WHOLE TRICK (inherited from capture-shots.mjs): the
// SPA is responsive, so at 1180px the rail collapses to a chip strip and every
// panel takes the full width. One panel fills the frame and its 12px body text
// lands at a readable size once the frame is scaled into a marketing column.
import { chromium } from 'playwright';

export const DEMO_BASE = process.env.DEMO_BASE ?? 'http://localhost:5273/app/';

/** The width every capture is taken at. Changing it changes the layout, not the zoom. */
export const DEMO_WIDTH = 1180;

export async function launch() {
  return chromium.launch({ headless: true });
}

/**
 * A browser context seeded so the app opens on the screen we asked for and
 * nothing else.
 *
 * `reducedMotion: 'reduce'` is not politeness here — it is determinism. The SPA
 * has entry transitions, and a frame captured mid-transition is a frame of a
 * half-drawn panel. Under reduced motion the screen is either there or not.
 */
export async function ctx(
  browser,
  { width = DEMO_WIDTH, height = 900, scale = 2, pane, colorScheme = 'dark' } = {},
) {
  const c = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme,
    reducedMotion: 'reduce',
  });
  await c.addInitScript((h) => {
    // Never show the first-run tour or the welcome-back banner in a capture.
    localStorage.setItem('pierre:onboarded', '1');
    localStorage.setItem('pierre:cookieConsent', 'granted');
    if (h) localStorage.setItem('pierre:detailPaneHeight', String(h));
  }, pane);
  return c;
}

/**
 * Collect console errors and uncaught exceptions off a page, deduplicated.
 * (The precedent is `lib/ui-harness.mjs`; a capture that renders a blank panel
 * because a query threw should say so rather than silently ship the blank.)
 *
 * @returns {string[]} the live array — read it after the page has settled.
 */
export function watchPage(page) {
  const errors = [];
  const seen = new Set();
  const note = (msg) => {
    if (seen.has(msg)) return;
    seen.add(msg);
    errors.push(msg);
  };
  page.on('console', (m) => m.type() === 'error' && note(m.text()));
  page.on('pageerror', (e) => note(String(e)));
  return errors;
}

/**
 * `ready` is the selector that means "this screen has painted". It defaults to
 * the timeline canvas, which is warm under every overlay — but the Feed is heavy
 * enough with a real estate behind it that the board can still be building when
 * the feed itself is on screen, so feed captures wait on their own container.
 *
 * ⚠ NO BLANKET `Escape` HERE. It closes the PR detail pane that `?pr=<id>` just
 * opened, and every pull-request capture then times out waiting for a pane the
 * script itself dismissed. The stray-popover problem this was reaching for is
 * fixed at its source instead: tab clicks are scoped INSIDE the pane, so they
 * cannot land on the board's own filter controls behind it.
 */
export async function open(page, query = '', ready = '.vis-timeline', { settleMs = 1800 } = {}) {
  await page.goto(`${DEMO_BASE}${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ready, { timeout: 40_000 });
  await page
    .getByRole('button', { name: /dismiss|close|got it/i })
    .first()
    .click({ timeout: 700 })
    .catch(() => {});
  if (settleMs) await page.waitForTimeout(settleMs);
}
