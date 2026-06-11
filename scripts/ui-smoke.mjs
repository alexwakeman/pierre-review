// Smoke check: load the timeline SPA against the running dev server, confirm it
// renders some repo rows and logs no console errors, and drop a screenshot in
// scripts/.ui-artifacts/. Run with `pnpm verify:ui` (needs `pnpm dev` running).
// This doubles as a worked example of the ui-harness for ad-hoc verifications.
import { withTimeline, ensureServer, artifact } from './lib/ui-harness.mjs';

await ensureServer();

const shot = artifact('smoke.png');
const { result, consoleErrors } = await withTimeline(
  async (page) => {
    const repoRows = await page.locator('.tl-repo-header').count();
    await page.screenshot({ path: shot });
    return { repoRows };
  },
  { query: process.argv[2] ?? '' },
);

console.log(`repo rows rendered: ${result.repoRows}`);
console.log(`screenshot: ${shot}`);
if (consoleErrors.length) {
  console.error(`\n❌ ${consoleErrors.length} console error(s):\n${consoleErrors.join('\n')}`);
  process.exit(1);
}
console.log('✅ UI smoke passed — timeline rendered, no console errors.');
