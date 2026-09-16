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

/**
 * The launch flags every capture browser gets.
 *
 * ⚠ THESE ARE NOT AN OPTIMISATION — THEY ARE WHAT MAKES THE TIMELINE PAINT.
 * vis-timeline positions its ITEMS (the PR bars) inside `requestAnimationFrame`,
 * and a renderer Chromium considers backgrounded coalesces rAF to 1 Hz or stops
 * it altogether. The failure is silent and it has already been paid for once in
 * this repo: 47 correct group rows, every bar at x=0, no error anywhere. The
 * demo video's recorder browser has carried these flags since it was written;
 * the APP browser did not, which is the half that films the timeline.
 *
 * (The OTHER half of that landmine is `document.hidden`, which
 * `components/Timeline/index.tsx` checks before rebuilding groups+bars+markers.
 * A headless page is not hidden, so it does not bite here — but a scene that
 * films the board should still assert its bars exist rather than trust that.)
 */
export const CAPTURE_LAUNCH_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

export async function launch() {
  return chromium.launch({ headless: true, args: CAPTURE_LAUNCH_ARGS });
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
    // Never show the first-run tour in a capture.
    localStorage.setItem('pierre:onboarded', '1');
    localStorage.setItem('pierre:cookieConsent', 'granted');
    if (h) localStorage.setItem('pierre:detailPaneHeight', String(h));
  }, pane);
  // ⚠ AN INIT SCRIPT, NOT `page.addStyleTag`. A style tag has to be added AFTER
  // a navigation and would have to be re-added per page; this runs before the
  // SPA's first paint on every document in the context, including a reload.
  // (`BrowserContext` has no `addStyleTag` at all.)
  await c.addInitScript((css) => {
    const install = () => {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
    };
    if (document.head) install();
    else document.addEventListener('DOMContentLoaded', install, { once: true });
  }, CAPTURE_CSS);
  return c;
}

/**
 * TWO THINGS THAT APPEAR ON A WALL CLOCK, NOT ON THE SCREEN'S OWN STATE. Both
 * are hidden for the duration of a capture, and neither is a picture of the
 * product:
 *
 *  • THE BACKGROUND-LOADING TOAST. `GlobalLoadingBar` shows while
 *    `isMlScoring()` is true, which on the demo stack is FOREVER: the seeder
 *    ships 2,945 `ml_comment_labels` rows and leaves 20 comments unscored, and
 *    `pnpm demo` sets `DISABLE_SCHEDULER=true`, so there is a permanent backlog
 *    with nothing draining it. "Classifying bot comments · 0 of 20 · 0%" then
 *    sits in the bottom-right corner of every frame.
 *
 *  • THE WELCOME-BACK BANNER. It renders only outside the Activity console and
 *    only once `useMyTurnByWorkspace` has resolved, which lands SEVERAL SECONDS
 *    after the screen does — so it appeared in one probe run and not the next,
 *    and it shifts the whole page down 28px when it arrives. A 28px jump
 *    mid-scene is exactly the non-determinism this module exists to remove.
 *
 * ⚠ SELECT ON WHAT THE COMPONENT PROMISES, and fail OPEN. The toast's
 * `role="status"` + `aria-label` are part of its accessibility contract. The
 * banner has no test id, so this keys on its class list; if that changes the
 * rule simply stops matching and the banner comes back, which is visible in the
 * next capture rather than silent.
 */
const CAPTURE_CSS = `
  [role="status"][aria-label="Background loading"] { display: none !important; }
  div.h-7.border-amber-200.bg-amber-50 { display: none !important; }
`;

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
