// Reusable Playwright harness for verifying the timeline SPA against the running
// dev server. Spins up headless Chromium, opens the app at a given query string,
// waits for the timeline to render, and captures console / page errors — so an
// ad-hoc UI check is a few lines instead of boilerplate. Playwright is a root dev
// dependency (`pnpm add -D -w playwright` + `pnpm exec playwright install chromium`),
// so scripts run from the repo root can `import` this directly.
//
// Usage:
//   import { withTimeline, ensureServer, artifact } from './lib/ui-harness.mjs';
//   await ensureServer();
//   const { result, consoleErrors } = await withTimeline(
//     async (page) => {
//       await page.getByRole('button', { name: /^Events/ }).click();
//       return page.getByRole('dialog', { name: 'Event types' }).innerText();
//     },
//     { query: '?repos=7774&preset=30d' },
//   );
//
// Env overrides: PIERRE_UI_BASE (default http://localhost:5173/app/).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', '.ui-artifacts');

export const BASE = process.env.PIERRE_UI_BASE ?? 'http://localhost:5173/app/';

/** Resolve a path under the gitignored scripts/.ui-artifacts/ dir (for screenshots). */
export function artifact(name) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  return join(ARTIFACT_DIR, name);
}

/** Fail fast with an actionable message if the dev server isn't up. */
export async function ensureServer(base = BASE) {
  const res = await fetch(base).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(
      `Dev app not reachable at ${base}. Start it first:  pnpm dev  ` +
        `(or set PIERRE_UI_BASE).`,
    );
  }
}

/**
 * Open the timeline SPA, wait for it to render, run `fn(page, ctx)`, and tear down.
 * Returns `{ result, consoleErrors }` — `result` is whatever `fn` returns. Any
 * console.error / uncaught page error during the run is collected into
 * `consoleErrors` (deduped) so callers can assert the page stayed clean.
 *
 * Options:
 *   query     query string appended to BASE (e.g. '?repos=7774&preset=30d')
 *   viewport  { width, height } (default 1600×1000)
 *   settleMs  extra wait after the timeline appears, for async lane/marker layout
 *   waitForTimeline  set false to skip the .vis-timeline wait (e.g. a 401 gate)
 */
export async function withTimeline(fn, opts = {}) {
  const {
    query = '',
    viewport = { width: 1600, height: 1000 },
    settleMs = 2000,
    waitForTimeline = true,
  } = opts;

  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const seen = new Set();
  const note = (msg) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      consoleErrors.push(msg);
    }
  };
  try {
    const page = await browser.newPage({ viewport });
    page.on('console', (m) => m.type() === 'error' && note(m.text()));
    page.on('pageerror', (e) => note(String(e)));

    await page.goto(`${BASE}${query}`, { waitUntil: 'networkidle' });
    if (waitForTimeline) {
      await page.waitForSelector('.vis-timeline', { timeout: 20000 });
      if (settleMs) await page.waitForTimeout(settleMs);
    }
    const result = await fn(page, { consoleErrors, artifact });
    return { result, consoleErrors };
  } finally {
    await browser.close();
  }
}
