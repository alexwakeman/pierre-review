import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// The shared Timeline has NO bottom detail pane: a PR bar opens the PR POPOVER (key facts, "Open
// details", "Open on GitHub"); "Open details" opens the PR's own tab. Esc and a click on empty
// canvas close the popover; ↵ on the j/k selection opens it. A Focus tab keeps its pane.

const popover = (p: Page) => p.getByTestId('pr-popover');

async function gotoBoard(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/app/?view=timeline&preset=30d');
  await expect(page.locator('.pr-bar').first()).toBeVisible();
}

test.describe('Timeline PR popover', () => {
  test('a bar click opens the popover, not the bottom pane; Open details opens the PR tab', async ({ page }) => {
    await gotoBoard(page);
    await page.locator('.vis-item.pr-bar').first().click();
    await expect(popover(page)).toBeVisible();
    await expect(page.getByTestId('detail-pane')).toHaveCount(0);
    await expect(popover(page)).toContainText('acme/web#');
    await expect(popover(page)).toContainText('State');
    await expect(popover(page)).toContainText('Size');
    await expect(popover(page).getByRole('link', { name: /Open on GitHub/ })).toHaveAttribute('href', /^https:\/\/github\.com\/acme\/web\/pull\/\d+$/);

    await popover(page).getByTestId('pr-popover-open').click();
    await expect(page.getByTestId('pinned-pr-overlay')).toBeVisible();
    await expect(page).toHaveURL(/view=pr-detail(:|%3A)\d+/);
    await expect(popover(page)).toHaveCount(0);
  });

  test('Esc closes the popover; Enter on the selected PR reopens it', async ({ page }) => {
    await gotoBoard(page);
    await page.locator('.vis-item.pr-bar').first().click();
    await expect(popover(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover(page)).toHaveCount(0);
    // The selection survives the first Escape — Enter opens the card again.
    await page.locator('body').focus();
    await page.keyboard.press('Enter');
    await expect(popover(page)).toBeVisible();
    // A second Escape closes it; j moves the selection; Enter opens that PR's card.
    await page.keyboard.press('Escape');
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(popover(page)).toBeVisible();
  });

  test('a click on empty canvas closes the popover first, then the selection', async ({ page }) => {
    await gotoBoard(page);
    await page.locator('.vis-item.pr-bar').first().click();
    await expect(popover(page)).toBeVisible();
    // The pane below the drawn rows is empty canvas (the board's own dismissal path).
    const box = await page.locator('.vis-timeline').boundingBox();
    if (box == null) throw new Error('no board');
    await page.mouse.click(box.x + box.width - 40, box.y + box.height + 30);
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator('.pr-bar.vis-selected')).toHaveCount(1);
  });
});
