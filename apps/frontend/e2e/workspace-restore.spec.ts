import { test, expect } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// THE WORKSPACE A LINK NAMED IS REMEMBERED. A tab opened on `?workspace=<id>` must store that
// scope at once: the next BARE load (the CLI opens `/app/` on every restart) restores it. Before,
// only a LATER change was stored, so a reader who never switched came back to Default.
test('a workspace named in the URL is remembered for the next bare load', async ({ page }) => {
  await installMockApi(page);
  await page.goto('/app/?workspace=1&view=activity');
  await expect(page.getByTestId('activity-overlay')).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('pierre:workspaceScope'));
  expect(JSON.parse(stored ?? '{}')).toMatchObject({ workspaceId: 1 });
});
