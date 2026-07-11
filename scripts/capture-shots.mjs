// Capture the landing-page product screenshots from the ISOLATED demo stack
// (seeded acme/* data — no real GitHub data, no PII).
//
// TWO PASSES against the SAME seeded DB, selected by SHOT_SET (default `pro`):
//
//   PRO pass  (SHOT_SET=pro, the default) — full Pro stack:
//     backend  : DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
//                PRO_DIGEST_ENABLED=true PRO_ADVANCED_AI_ENABLED=true ANTHROPIC_API_KEY=dummy
//                (gh OFF the PATH — see seed-demo.ts)
//     frontend : BACKEND_PORT=4100 vite --port 5273
//     capture  : node scripts/capture-shots.mjs
//     → timeline / activity-feed-pro / repo-console / insights / flow-metrics /
//       sprint-report / pr-detail / claude-review / ai-fix / settings /
//       open-pr-strip / og-image
//       + the WALKTHROUGH step crops (narrow 860px viewport so the UI text is
//       large + legible at column width): flow-review-1-run / 2-memory /
//       3-findings / 4-post (Claude Review on #113) and flow-fix-1-ci /
//       2-analysis / 3-diff / 4-push (CI failure → fix on #114)
//
//   FREE pass (SHOT_SET=free) — pure-OSS mode, same seeded DB, backend RESTARTED
//   with PRO_DISABLED=true (forces OSS even with the pro submodule present):
//     backend  : DATABASE_URL=/tmp/pierre-demo.sqlite PORT=4100 DISABLE_SCHEDULER=true \
//                PRO_DISABLED=true ANTHROPIC_API_KEY=dummy   (gh OFF the PATH)
//     frontend : BACKEND_PORT=4100 vite --port 5273
//     capture  : SHOT_SET=free node scripts/capture-shots.mjs
//     → activity-feed (the PLAIN feed — no FYI/My-Turn cards) / repo-console-free
//       (repo console with no AI digest card)
//
// Writes 2x PNGs into apps/landing/public/shots/ (og-image.png → public root).
// The timeline / open-PR-strip shots load `?preset=30d` so the board shows the
// full month of seeded activity and the strip's stalled count (see seed-demo.ts).
//
// Run:  node scripts/capture-shots.mjs                 (all PRO shots)
//       SHOT_SET=free node scripts/capture-shots.mjs   (all FREE shots)
//       node scripts/capture-shots.mjs insights.png    (one shot, within the set)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'apps', 'landing', 'public');
const SHOTS = join(PUBLIC, 'shots');
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.DEMO_BASE ?? 'http://localhost:5273/app/';
const SHOT_SET = (process.env.SHOT_SET ?? 'pro').toLowerCase(); // 'pro' | 'free'
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

// Open the SPA. A BARE load lands on the Activity console; any query keeps the
// Timeline unless `?view=activity`. The vis board is always warm underneath the
// Activity/PR overlays, so waiting for `.vis-timeline` is safe for every view.
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

const ONLY = process.argv[2]; // optional: capture a single shot by filename (within the active set)
async function shot(name, fn) {
  if (ONLY && name !== ONLY) return;
  try {
    await fn();
    results.push(`✅ ${name}`);
  } catch (err) {
    results.push(`❌ ${name} — ${err.message}`);
  }
}

// ===========================================================================
// PRO pass — the full Pro stack (PRO_ADVANCED_AI_ENABLED + PRO_DIGEST_ENABLED).
// ===========================================================================
async function proShots() {
  // 1. Timeline (hero) — the Timeline tab board at the 30-day preset so the full
  // month of seeded activity fills the board. Any query keeps the app on the
  // timeline view (a bare load would land on Activity).
  await shot('timeline.png', async () => {
    const ctx = await newCtx();
    const page = await ctx.newPage();
    await openApp(page, '?preset=30d&view=timeline');
    await page.screenshot({ path: out('timeline.png') });
    await ctx.close();
  });

  // 2. Activity Feed (PRO) — the cross-repo consolidated feed WITH the yellow
  // My-Turn / FYI cards. With Pro on, the Activity console auto-lands on Insights,
  // so click the Feed rail entry.
  await shot('activity-feed-pro.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1100 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity');
    await page.getByRole('button', { name: 'Feed', exact: true }).click();
    await page.getByTestId('feed-view').waitFor({ timeout: 8000 });
    await page.waitForTimeout(2500); // feed page + FYI cards land
    await page.screenshot({ path: out('activity-feed-pro.png') });
    await ctx.close();
  });

  // 3. Repo console — one repo's rail entry: header stats + AI digest + open-PR list.
  // Deep-link the repo id (acme/api = 2 carries #113 and the richest thread activity).
  await shot('repo-console.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1200 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity&activityRepo=2');
    const console_ = page.getByTestId('repo-console');
    await console_.waitFor({ timeout: 8000 });
    await page.waitForTimeout(2000); // digest + open-PR list load
    await page.screenshot({ path: out('repo-console.png') });
    await ctx.close();
  });

  // 4. Insights — the Pro team review-intelligence rail view (default landing with Pro on).
  await shot('insights.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1100 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity');
    await page.getByTestId('insights-view').waitFor({ timeout: 8000 });
    await page.waitForTimeout(2500); // cards + metrics + sprint report load
    await page.screenshot({ path: out('insights.png') });
    await ctx.close();
  });

  // 5. Flow metrics — the DORA-style charts panel inside Insights (element shot;
  // tall viewport so the whole panel renders without inner scroll).
  await shot('flow-metrics.png', async () => {
    const ctx = await newCtx({ width: 1400, height: 2000 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity');
    const panel = page.getByTestId('flow-metrics');
    await panel.waitFor({ timeout: 8000 });
    await page.waitForTimeout(2500); // chart render
    await panel.screenshot({ path: out('flow-metrics.png') });
    await ctx.close();
  });

  // 6. Sprint report — the Pro sprint-report card (expanded by default), element shot.
  await shot('sprint-report.png', async () => {
    const ctx = await newCtx({ width: 1400, height: 1800 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity');
    const card = page.getByTestId('sprint-report');
    await card.waitFor({ timeout: 8000 });
    await page.waitForTimeout(2000); // report markdown + PR-ref table render
    await card.screenshot({ path: out('sprint-report.png') });
    await ctx.close();
  });

  // 7. PR detail — Overview tab of #113, focused on the (taller) detail pane.
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

  // 7b. Bot triage — "the calm layer above your review bot." Open #113, click the CodeRabbit
  // chip in Overview → the Threads tab filtered to CodeRabbit's threads, with the one-click
  // "Resolve N addressed" backlog action visible. The hero of the bot-aware positioning.
  await shot('bot-review.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1200 }, 2, 920);
    const page = await ctx.newPage();
    await openApp(page, '?pr=113');
    const pane = page.getByTestId('detail-pane');
    await pane.waitFor({ timeout: 8000 });
    // The "Bots" row chip in Overview — "🤖 CodeRabbit · 6 · 3 unresolved".
    await pane.getByRole('button', { name: /CodeRabbit/ }).first().click({ timeout: 4000 });
    await page.waitForTimeout(1500); // Threads tab + vendor filter banner render
    await pane.screenshot({ path: out('bot-review.png') });
    await ctx.close();
  });

  // 8. Claude Review — the findings tab of #113, focused on the (taller) detail pane.
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

  // 9. AI Analysis & Fix — the tab on #114 (the failing infra PR): seeded CI-failure
  // analysis + a succeeded fix run with a reviewable patch.
  await shot('ai-fix.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1200 }, 2, 920);
    const page = await ctx.newPage();
    await openApp(page, '?pr=114');
    const pane = page.getByTestId('detail-pane');
    await pane.waitFor({ timeout: 8000 });
    await pane.getByText('AI Analysis and Fix', { exact: true }).first().click({ timeout: 4000 });
    await page.waitForTimeout(2500); // analysis + fix queries land
    await pane.screenshot({ path: out('ai-fix.png') });
    await ctx.close();
  });

  // 10. Settings — the header account menu → Settings modal (sprint window / Slack /
  // AI policy / Jira links), element shot of the dialog.
  await shot('settings.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1100 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity');
    // The account-menu trigger is the "Signed in as …" button (aria-haspopup="menu").
    await page.locator('button[aria-haspopup="menu"][title^="Signed in as"]').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.waitFor({ timeout: 8000 });
    await page.waitForTimeout(1200); // settings query loads the seeded pro_settings
    await dialog.screenshot({ path: out('settings.png') });
    await ctx.close();
  });

  // 11. Open-PR strip — the 30-day preset so the strip surfaces the stalled PRs
  // (its header reads "N stalled" > 0). Ensure expanded, element screenshot.
  await shot('open-pr-strip.png', async () => {
    const ctx = await newCtx();
    const page = await ctx.newPage();
    await openApp(page, '?preset=30d&view=timeline');
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

  // =========================================================================
  // WALKTHROUGH step crops — the landing page's two step-by-step demos
  // (Claude Review → post on #113; CI failure → fix → push on #114). Captured
  // at a NARROW viewport so the app's text is large relative to the frame —
  // legible when displayed at column width and on mobile — with a tall detail
  // pane so each section fits un-scrolled.
  // =========================================================================
  const WALK_VP = { width: 860, height: 1700 };
  const WALK_PANE = 1450;

  async function openPaneTab(page, prQuery, tabText) {
    await openApp(page, prQuery);
    const pane = page.getByTestId('detail-pane');
    await pane.waitFor({ timeout: 8000 });
    await pane.getByText(tabText, { exact: true }).first().click({ timeout: 4000 });
    await page.waitForTimeout(2200);
    return pane;
  }

  // Screenshot the union bounding box of several locators (page-level clip —
  // the app never scrolls the document itself, so viewport coords == page coords).
  async function cropUnion(page, locators, name, pad = 10) {
    // Scroll the BOTTOM-MOST locator into view (the union must sit fully inside
    // the viewport for the page-level clip); the tall pane keeps the top one visible.
    await locators[locators.length - 1].scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const boxes = [];
    for (const l of locators) {
      const b = await l.boundingBox();
      if (!b) throw new Error('cropUnion: locator not visible');
      boxes.push(b);
    }
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
    const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
    await page.screenshot({
      path: out(name),
      clip: { x, y, width: right - x, height: bottom - y },
    });
  }

  // W1. Claude Review, step 1 — the run controls: model + depth pickers, the
  // deterministic router's hint line, and (Pro) the collapsed review-memory strip.
  await shot('flow-review-1-run.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=113', 'Claude Review');
    const section = pane.locator('div.divide-y > div').first();
    await section.screenshot({ path: out('flow-review-1-run.png') });
    await ctx.close();
  });

  // W2. Claude Review, step 2 — the review-memory panel EXPANDED: signals from
  // past reviews in this repo that get injected into the run.
  await shot('flow-review-2-memory.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=113', 'Claude Review');
    const toggle = pane.getByRole('button', { name: /From your past reviews/ });
    await toggle.click({ timeout: 4000 });
    await page.waitForTimeout(400);
    // Reveal the reworded-finding example (Claude's wording vs yours) — the
    // clearest picture of what the next run learns from.
    await pane
      .getByText(/show example/i)
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
    await page.waitForTimeout(300);
    const panel = toggle.locator('xpath=..'); // the violet-bordered wrapper
    await panel.screenshot({ path: out('flow-review-2-memory.png') });
    await ctx.close();
  });

  // W3. Claude Review, step 3 — Claude's structured output: the summary line and
  // the severity-tagged, line-anchored findings with their per-finding actions.
  await shot('flow-review-3-findings.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=113', 'Claude Review');
    const section = pane
      .locator('div.divide-y > div')
      .filter({ hasText: "Claude's review" })
      .first();
    await section.screenshot({ path: out('flow-review-3-findings.png') });
    await ctx.close();
  });

  // W4. Claude Review, step 4 — your review: the overall-comment composer +
  // verdict picker + the single Post to GitHub control (union crop).
  await shot('flow-review-4-post.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=113', 'Claude Review');
    const compose = pane
      .locator('div.divide-y > div')
      .filter({ hasText: 'Overall review' })
      .first();
    const post = pane
      .locator('div.divide-y > div')
      .filter({ hasText: 'Post to GitHub' })
      .last();
    // A lived-in composer: your words + your verdict (nothing is persisted —
    // the demo backend never posts).
    await compose
      .locator('textarea')
      .fill(
        'Solid refactor — blocking on the transaction-boundary issue; batching can land as a follow-up. Dropped the style nits.',
      );
    await compose.locator('select').selectOption({ label: 'Request changes' });
    await page.waitForTimeout(300);
    await cropUnion(page, [compose, post], 'flow-review-4-post.png');
    await ctx.close();
  });

  // F1. CI fix, step 1 — the failing check, in context (#114's CI status block).
  await shot('flow-fix-1-ci.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=114', 'AI Analysis and Fix');
    const section = pane
      .locator('div.pb-6 > div')
      .filter({ hasText: 'CI status' })
      .first();
    await section.screenshot({ path: out('flow-fix-1-ci.png') });
    await ctx.close();
  });

  // F2. CI fix, step 2 — the AI diagnosis: confidence chips, root cause, the
  // failing check named, and the "Fix it →" handoff.
  await shot('flow-fix-2-analysis.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=114', 'AI Analysis and Fix');
    const section = pane
      .locator('div.pb-6 > div')
      .filter({ hasText: 'CI failure analysis' })
      .first();
    await section.screenshot({ path: out('flow-fix-2-analysis.png') });
    await ctx.close();
  });

  // F3. CI fix, step 3 — the generated patch as a reviewable diff (crop from the
  // AI Fix heading through the file diff, stopping before the push panel).
  await shot('flow-fix-3-diff.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=114', 'AI Analysis and Fix');
    const section = pane
      .locator('div.pb-6 > div')
      .filter({ hasText: 'Push this fix' })
      .first();
    const header = section.getByText('AI Fix', { exact: true });
    const diff = section.locator('div.overflow-hidden.rounded.border').first();
    await cropUnion(page, [header, diff], 'flow-fix-3-diff.png');
    await ctx.close();
  });

  // F4. CI fix, step 4 — the push controls: same branch or a new branch + PR,
  // nothing moves without the click.
  await shot('flow-fix-4-push.png', async () => {
    const ctx = await newCtx(WALK_VP, 2, WALK_PANE);
    const page = await ctx.newPage();
    const pane = await openPaneTab(page, '?pr=114', 'AI Analysis and Fix');
    const panel = pane.locator('div.mt-3.rounded.border').filter({ hasText: 'Push this fix' }).first();
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await panel.screenshot({ path: out('flow-fix-4-push.png') });
    await ctx.close();
  });

  // 12. OG image — timeline at 1200x630 (social card), 30-day preset.
  await shot('og-image.png', async () => {
    const ctx = await newCtx({ width: 1200, height: 630 }, 1);
    const page = await ctx.newPage();
    await openApp(page, '?preset=30d&view=timeline');
    // The social card lives at the public root (/og-image.png), not under /shots.
    await page.screenshot({ path: join(PUBLIC, 'og-image.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
    await ctx.close();
  });
}

// ===========================================================================
// FREE pass — pure-OSS mode (backend restarted with PRO_DISABLED=true). No AI
// digest, no Insights rail entry, no FYI / My-Turn cards or toggle.
// ===========================================================================
async function freeShots() {
  // A. Activity Feed (FREE) — the PLAIN consolidated feed: no yellow My-Turn / FYI
  // cards, no "My Turn only" toggle. Without Pro there is no Insights rail entry,
  // so the Activity console lands on Feed; click it anyway to be safe.
  await shot('activity-feed.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1100 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity');
    await page.getByRole('button', { name: 'Feed', exact: true }).click().catch(() => {});
    await page.getByTestId('feed-view').waitFor({ timeout: 8000 });
    await page.waitForTimeout(2500); // feed page lands
    // GUARD: a mis-configured (Pro-enabled) backend would render FYI / My-Turn
    // surfaces here, producing a mislabeled "free" marketing shot. Fail loudly.
    // Scoped to the FEED container: the header's open-PR strip legitimately says
    // "N my turn" (core triage) even in OSS mode — only the feed's FYI badge /
    // "My Turn only" toggle are Pro.
    const feed = page.getByTestId('feed-view');
    const fyiCount = await feed.getByText(/\bFYI\b|My Turn only/i).count();
    if (fyiCount > 0) {
      throw new Error(
        'FYI / "My Turn" surface visible inside the FREE feed — backend is NOT in PRO_DISABLED mode',
      );
    }
    await page.screenshot({ path: out('activity-feed.png') });
    await ctx.close();
  });

  // B. Repo console (FREE) — one repo's rail entry WITHOUT the AI digest card:
  // header stats + open-PR list only.
  await shot('repo-console-free.png', async () => {
    const ctx = await newCtx({ width: 1600, height: 1200 });
    const page = await ctx.newPage();
    await openApp(page, '?view=activity&activityRepo=2');
    const console_ = page.getByTestId('repo-console');
    await console_.waitFor({ timeout: 8000 });
    await page.waitForTimeout(2000); // open-PR list loads
    await page.screenshot({ path: out('repo-console-free.png') });
    await ctx.close();
  });
}

if (SHOT_SET === 'free') {
  await freeShots();
} else {
  await proShots();
}

await browser.close();
console.log(`SHOT_SET=${SHOT_SET}`);
console.log(results.join('\n'));
console.log(`\nShots written to ${SHOTS}`);
