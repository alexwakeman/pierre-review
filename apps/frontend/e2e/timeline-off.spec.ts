import { test, expect } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// SETTINGS → FEATURES → TIMELINE, at its default (OFF): no sidebar entry, no board fetch, and a
// link to the board or to a Focus tab lands somewhere real (Open pull requests / the PR's own tab),
// never a blank page.

test.describe('Timeline switched off (the default)', () => {
  test('no sidebar entry and no board fetch; ?view=timeline lands on Open pull requests', async ({ page }) => {
    const timelineCalls: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/timeline') timelineCalls.push(r.url());
    });
    await installMockApi(page, { timeline: false });
    await page.goto('/app/?view=timeline&preset=30d');

    await expect(page.getByTestId('nav-open-prs')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('activity-overlay')).toBeVisible();
    await expect(page.getByTestId('nav-timeline')).toHaveCount(0);
    await expect(page).toHaveURL(/view=activity/);
    await expect(page.locator('.pr-bar')).toHaveCount(0);

    // `g t` goes nowhere.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(page.getByTestId('activity-overlay')).toBeVisible();

    expect(timelineCalls).toEqual([]);
  });

  test('a Focus link opens the pull request in its own tab', async ({ page }) => {
    await installMockApi(page, { timeline: false });
    await page.goto('/app/?view=pr-focus:101');
    await expect(page.getByTestId('pinned-pr-overlay')).toBeVisible();
    await expect(page).toHaveURL(/view=pr-detail(:|%3A)101/);
  });
});
