// Landing-page product screenshots, captured from the ISOLATED demo stack
// (seeded acme/* data — no real GitHub data, no PII).
//
// WHAT CHANGED, AND WHY. The previous version photographed whole 1600px browser
// windows. At the width a marketing column actually renders them that produced
// pictures of an application rather than pictures of a FEATURE: the thing being
// described was forty pixels tall somewhere in the middle, and the reader could
// not see it. Every shot here is now a CROP OF ONE ELEMENT, taken at a viewport
// narrow enough that the element's own text is large in the frame. A shot exists
// to make one claim legible; if you cannot read the claim in the thumbnail, the
// shot has failed.
//
// TWO PASSES against the SAME seeded DB, selected by SHOT_SET (default `pro`):
//
//   PRO  (default) — the full stack (PRO_DIGEST_ENABLED + PRO_ADVANCED_AI_ENABLED)
//   FREE (SHOT_SET=free) — the same database with PRO_DISABLED=true, which is how
//        the visible-but-locked panes get photographed honestly: the free tier is
//        not a cropped screenshot of the paid one, it is a different screen.
//
// Run:  node scripts/capture-shots.mjs                 (all PRO shots)
//       SHOT_SET=free node scripts/capture-shots.mjs   (all FREE shots)
//       node scripts/capture-shots.mjs pending-board.png   (one shot)
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠ The viewport, the theme, the reduced-motion setting and the localStorage seed
// live in ONE place so the stills and the demo video can never drift apart.
// See scripts/lib/demo-browser.mjs.
import { ctx as demoCtx, launch, open as demoOpen } from './lib/demo-browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'apps', 'landing', 'public');
const SHOTS = join(PUBLIC, 'shots');
mkdirSync(SHOTS, { recursive: true });
const SHOT_SET = (process.env.SHOT_SET ?? 'pro').toLowerCase();
const ONLY = process.argv[2];
const out = (n) => join(SHOTS, n);
const results = [];

const browser = await launch();

// ⚠ `ctx()` and `open()` MOVED to scripts/lib/demo-browser.mjs — the video capture
// needs exactly the same four decisions (1180px viewport, dark, reduced motion,
// the onboarding localStorage seed) and a second copy of them would silently let
// the stills and the clip become pictures of two different products.
const ctx = (opts) => demoCtx(browser, opts);
const open = (page, query, ready) => demoOpen(page, query, ready);

/**
 * Crop one element, with a little breathing room so the shot does not look
 * guillotined, clamped to the page so the clip never runs off the canvas.
 */
async function crop(page, locator, file, { pad = 14, maxHeight = 1400 } = {}) {
  await locator.first().waitFor({ state: 'visible', timeout: 20_000 });
  await locator.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const box = await locator.first().boundingBox();
  if (!box) throw new Error('no bounding box');
  const vw = page.viewportSize().width;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: out(file),
    clip: {
      x,
      y,
      width: Math.min(vw - x, box.width + pad * 2),
      height: Math.min(maxHeight, box.height + pad * 2),
    },
  });
}

async function shot(name, fn) {
  if (ONLY && name !== ONLY) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push(`✅ ${name}  ${Date.now() - t0}ms`);
  } catch (err) {
    results.push(`❌ ${name} — ${err.message}`);
  }
}

// Open the Activity console on a given rail entry.
async function console_(page, rail, extra = '', ready) {
  await open(page, `?view=activity&activityRepo=${rail}${extra}`, ready);
}

// ===========================================================================
// PRO pass
// ===========================================================================
async function proShots() {
  // ---- the worklist ------------------------------------------------------
  await shot('pending-board.png', async () => {
    const c = await ctx({ height: 1100 });
    const p = await c.newPage();
    await console_(p, 'attention');
    await p.waitForTimeout(2500);
    await crop(p, p.getByTestId('attention-view'), 'pending-board.png', { maxHeight: 1250 });
    await c.close();
  });

  await shot('pending-card.png', async () => {
    const c = await ctx({ width: 1000, height: 900 });
    const p = await c.newPage();
    await console_(p, 'attention');
    await p.waitForTimeout(2500);
    // One card, close up: the kind, the review standing, the merge actions.
    await crop(p, p.getByTestId('attention-view').locator('li, article').first(), 'pending-card.png', {
      pad: 10,
      maxHeight: 420,
    });
    await c.close();
  });

  // ---- the stream --------------------------------------------------------
  await shot('feed.png', async () => {
    const c = await ctx({ height: 1150 });
    const p = await c.newPage();
    await console_(p, 'feed', '&feedTab=feed', '[data-testid="feed-view"]');
    await p.waitForTimeout(2500);
    await crop(p, p.getByTestId('feed-view'), 'feed.png', { maxHeight: 1250 });
    await c.close();
  });

  await shot('flow-metrics.png', async () => {
    const c = await ctx({ height: 1150 });
    const p = await c.newPage();
    await console_(p, 'insights');
    await p.getByTestId('insights-view').waitFor({ timeout: 15_000 });
    await p.waitForTimeout(3200);
    await crop(p, p.getByTestId('workspace-flow-metrics'), 'flow-metrics.png', { maxHeight: 1150 });
    await c.close();
  });

  await shot('repo-rows.png', async () => {
    const c = await ctx({ height: 1000 });
    const p = await c.newPage();
    await console_(p, 'insights');
    await p.waitForTimeout(3200);
    await crop(p, p.getByTestId('repo-activity-charts'), 'repo-rows.png', { maxHeight: 900 });
    await c.close();
  });

  await shot('reach.png', async () => {
    const c = await ctx({ width: 900, height: 1000 });
    const p = await c.newPage();
    await console_(p, 'insights');
    await p.waitForTimeout(3200);
    await crop(p, p.getByTestId('workspace-reach'), 'reach.png', { maxHeight: 900 });
    await c.close();
  });

  // ---- paid manager surfaces --------------------------------------------
  await shot('period-report.png', async () => {
    const c = await ctx({ height: 1250 });
    const p = await c.newPage();
    await console_(p, 'insights');
    await p.getByTestId('period-reports').waitFor({ timeout: 15_000 });
    await p.waitForTimeout(3000);
    await crop(p, p.getByTestId('period-reports'), 'period-report.png', { maxHeight: 1350 });
    await c.close();
  });

  await shot('chronology.png', async () => {
    const c = await ctx({ height: 1150 });
    const p = await c.newPage();
    await console_(p, 'insights', '&insightsTab=bottlenecks');
    await p.getByTestId('bottlenecks-panel').waitFor({ timeout: 15_000 });
    await p.waitForTimeout(2500);
    await crop(p, p.getByTestId('bottlenecks-panel'), 'chronology.png', { maxHeight: 1200 });
    await c.close();
  });

  // ---- bots --------------------------------------------------------------
  await shot('bot-roi.png', async () => {
    const c = await ctx({ height: 1150 });
    const p = await c.newPage();
    await console_(p, 'bots', '&botsTab=roi');
    await p.getByTestId('bot-roi-panel').waitFor({ timeout: 15_000 });
    await p.waitForTimeout(3000);
    await crop(p, p.getByTestId('bot-roi-panel'), 'bot-roi.png', { maxHeight: 1150 });
    await c.close();
  });

  await shot('bot-settings.png', async () => {
    const c = await ctx({ height: 1050 });
    const p = await c.newPage();
    await console_(p, 'bots', '&botsTab=settings');
    await p.getByTestId('bot-settings-panel').waitFor({ timeout: 15_000 });
    await p.waitForTimeout(2200);
    await crop(p, p.getByTestId('bot-settings-panel'), 'bot-settings.png', { maxHeight: 1050 });
    await c.close();
  });

  await shot('benchmark.png', async () => {
    const c = await ctx({ height: 1150 });
    const p = await c.newPage();
    await console_(p, 'bots', '&botsTab=benchmark');
    await p.getByTestId('benchmark-panel').waitFor({ timeout: 20_000 });
    await p.waitForTimeout(3500);
    await crop(p, p.getByTestId('benchmark-panel'), 'benchmark.png', { maxHeight: 1200 });
    await c.close();
  });

  await shot('pr-detail.png', async () => {
    const c = await ctx({ height: 1100, pane: 980 });
    const p = await c.newPage();
    await open(p, '?pr=113');
    await p.getByTestId('detail-pane').waitFor({ timeout: 25_000 });
    await p.waitForTimeout(2500);
    await crop(p, p.getByTestId('detail-pane'), 'pr-detail.png', { maxHeight: 1150 });
    await c.close();
  });

  await shot('pr-threads.png', async () => {
    const c = await ctx({ height: 1100, pane: 980 });
    const p = await c.newPage();
    await open(p, '?pr=113');
    await p
      .getByTestId('detail-pane')
      .getByRole('button', { name: /^Threads\d*$/ })
      .first()
      .click();
    await p.waitForTimeout(1200);
    await p.getByTestId('detail-pane').waitFor({ timeout: 25_000 });
    await p.waitForTimeout(2500);
    await crop(p, p.getByTestId('detail-pane'), 'pr-threads.png', { maxHeight: 1150 });
    await c.close();
  });

  // ⚠ NO `pr-changes` SHOT. The Changes tab hydrates its patches from GitHub on
  // demand, and the demo's repositories do not exist there — so against this
  // database it correctly renders "inline diffs aren't available for this PR".
  // That is the honest output, and it is not a picture of the feature. Do not
  // re-add this shot without first giving the demo a real diff to render.
  // ⚠ THERE IS NO `bot-severity` SHOT OF THE "BOT ACTIVITY" TAB. That tab compares
  // each vendor's timing on one pull request against its own baseline; it is
  // DETERMINISTIC and prints "no AI" on its own face. It shipped under a caption
  // claiming it showed the model's severity grades, on a page about the models —
  // a picture contradicting its own caption. The grader's output is these two.

  // The grade in aggregate: what the whole workspace's bots are flagging, by
  // severity and category. This is the model's output at the scale it matters.
  await shot('severity-strip.png', async () => {
    const c = await ctx({ width: 1180, height: 900 });
    const p = await c.newPage();
    await console_(p, 'bots', '&botsTab=roi');
    await p.getByTestId('bot-roi-panel').waitFor({ timeout: 20_000 });
    await p.waitForTimeout(3000);
    await crop(
      p,
      p.locator('section,div').filter({ hasText: /What the bots are flagging/ }).last(),
      'severity-strip.png',
      { maxHeight: 620 },
    );
    await c.close();
  });

  // The grade on individual comments: the drill-down behind one of those tiles,
  // which lists real bot comments each carrying the severity it was given.
  await shot('severity-findings.png', async () => {
    const c = await ctx({ width: 1180, height: 1050 });
    const p = await c.newPage();
    await console_(p, 'bots', '&botsTab=roi');
    await p.getByTestId('bot-roi-panel').waitFor({ timeout: 20_000 });
    await p.waitForTimeout(2800);
    await p
      .getByRole('button', { name: /high severity/i })
      .first()
      .click({ timeout: 8000 });
    await p.getByTestId('bot-flagging-overlay').waitFor({ timeout: 20_000 });
    await p.waitForTimeout(2500);
    await crop(p, p.getByTestId('bot-flagging-overlay'), 'severity-findings.png', {
      maxHeight: 1100,
    });
    await c.close();
  });

  // ---- cross-cutting -----------------------------------------------------
  await shot('og-image.png', async () => {
    const c = await ctx({ width: 1200, height: 630, scale: 2 });
    const p = await c.newPage();
    await console_(p, 'attention');
    await p.waitForTimeout(2500);
    await p.screenshot({ path: join(PUBLIC, 'og-image.png') });
    await c.close();
  });
}

// ===========================================================================
// FREE pass — the SAME database with the plugin forced off. The point is that
// the free tier is a real screen, not a cropped paid one.
// ===========================================================================
async function freeShots() {
  await shot('free-reports.png', async () => {
    const c = await ctx({ height: 1150 });
    const p = await c.newPage();
    await console_(p, 'insights');
    await p.getByTestId('insights-view').waitFor({ timeout: 15_000 });
    await p.waitForTimeout(3200);
    await crop(p, p.getByTestId('insights-view'), 'free-reports.png', { maxHeight: 1250 });
    await c.close();
  });


}

if (SHOT_SET === 'free') await freeShots();
else await proShots();

await browser.close();
console.log(`\n${SHOT_SET.toUpperCase()} shots → apps/landing/public/shots/`);
for (const r of results) console.log('  ' + r);
const failed = results.filter((r) => r.startsWith('❌')).length;
if (failed) {
  console.error(`\n${failed} shot(s) failed`);
  process.exit(1);
}
