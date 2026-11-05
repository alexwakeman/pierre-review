import { test, expect } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// THE SIDEBAR NEVER SCROLLS WITH THE PAGE (docs/FRONTEND.md § Open tabs). The bug: with many open
// tabs, a wheel over Open PRs slid the whole shell — sidebar included — up the page. The tab rows'
// `sr-only` spans (position:absolute) resolved against the aside instead of the sidebar's own
// scroller, sat thousands of px down, and stretched the DOCUMENT's scroll range. The scroller is now
// `relative`, so the document never scrolls and the tab list scrolls on its own.
//
// Pinned tabs ride along: they are listed under "Pinned" and survive "Close all".

const N = 60;

test.setTimeout(60_000);

test('many open tabs: the document never scrolls, the sidebar stays put, its list scrolls alone', async ({ page }) => {
  await installMockApi(page);
  await page.addInitScript((n: number) => {
    try {
      if (localStorage.getItem('pierre:tabs') != null) return;
      const tabs: unknown[] = [];
      for (let i = 1; i <= n; i++) {
        tabs.push({
          key: `pr-detail:${9000 + i}`,
          kind: 'pr-detail',
          prId: 9000 + i,
          ...(i <= 2 ? { pinned: true } : {}),
          meta: { id: 9000 + i, number: i, title: `Tab ${i}`, repoFullName: 'acme/web', authorLogin: 'someone', authorDisplayName: 'Some One', authorAvatarUrl: null },
        });
      }
      localStorage.setItem('pierre:tabs', JSON.stringify(tabs));
    } catch {
      /* no storage */
    }
  }, N);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto('/app/?view=activity&activityRepo=open-prs');
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toBeVisible();
  await expect(page.getByTestId('sidebar-pinned-tabs').getByRole('tab')).toHaveCount(2);

  const doc = () =>
    page.evaluate(() => {
      const se = document.scrollingElement as HTMLElement;
      return { top: se.scrollTop, extra: se.scrollHeight - se.clientHeight };
    });
  expect((await doc()).extra).toBeLessThanOrEqual(0);

  // Wheel over the main pane.
  const main = page.locator('[data-shell-main]');
  const mb = (await main.boundingBox())!;
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await doc()).top).toBe(0);
  expect((await sidebar.boundingBox())!.y).toBe(0);

  // Wheel over the sidebar: its own list scrolls, the document does not.
  const middle = page.locator('[data-sidebar-middle]');
  const sb = (await middle.boundingBox())!;
  await page.mouse.move(sb.x + 40, sb.y + sb.height / 2);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 400);
  await expect.poll(() => middle.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await doc()).top).toBe(0);
  expect((await sidebar.boundingBox())!.y).toBe(0);

  // "Close all" keeps the pinned tabs, and they come back after a reload.
  await page.getByTestId('sidebar-open-tabs').getByRole('button', { name: 'Close all' }).click();
  await expect(page.getByTestId('sidebar-open-tabs').getByRole('tab')).toHaveCount(2);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sidebar-pinned-tabs').getByRole('tab')).toHaveCount(2);
});
