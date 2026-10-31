import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';
import { CHRONOLOGY_FLOW, DENSE_FLOW_TREND } from './chronology-fixtures.js';

// Reports → Chronology → "Over time", at a real workspace's density (chronology-fixtures.ts):
//   • no chart scrolls unless it is wider than its box (no stray scroll bars on a desktop);
//   • a hover box is never cut off by the scroller or hidden under the chart above it;
//   • the hours-saved chart's markers open a popover that says what happened, fully on screen;
//   • "click to measure from this week" is gone.
// Screenshots: SHOTS_DIR (default /tmp/limn-chronology-shots).

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/limn-chronology-shots';
const URL = '/app/?view=activity&activityRepo=insights&insightsTab=bottlenecks';

async function openChronology(page: Page): Promise<void> {
  await installMockApi(page);
  // Registered after the mock, so these answer first.
  await page.route(
    (u) => u.pathname === '/api/flow-findings',
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CHRONOLOGY_FLOW) }),
  );
  await page.route(
    (u) => u.pathname === '/api/flow-trend',
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DENSE_FLOW_TREND) }),
  );
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chronology-trend')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Working hours saved, opened to merged' })).toBeVisible();
}

const gainMarkers = (page: Page) => page.getByTestId('chronology-trend').locator('button[aria-haspopup="dialog"][data-marker]');
const popover = (page: Page) => page.getByTestId('chronology-event-popover');

/** The box sits wholly inside the viewport. */
async function expectOnScreen(page: Page, box: { x: number; y: number; width: number; height: number } | null): Promise<void> {
  expect(box).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 0.5);
}

/** Nothing is drawn over the popover: the topmost element at five points inside it is its own. */
async function expectUncovered(page: Page): Promise<void> {
  const covered = await popover(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 6, r.top + 6],
      [r.right - 6, r.top + 6],
      [r.left + 6, r.bottom - 6],
      [r.right - 6, r.bottom - 6],
    ] as const;
    return pts.filter(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit == null || !el.contains(hit);
    }).length;
  });
  expect(covered).toBe(0);
}

for (const width of [1280, 1440, 1920]) {
  test(`at ${width}px no chart scrolls and the hover box is never clipped`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openChronology(page);
    const trend = page.getByTestId('chronology-trend');
    // Wide enough for 26 weeks: no box scrolls, so no scroll bar can draw.
    await expect(trend.locator('[data-scrolls]')).toHaveCount(0);
    const scrollable = await trend.evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>('*')].filter((el) => {
        const cs = getComputedStyle(el);
        const scrolls = (v: string) => v === 'auto' || v === 'scroll';
        return (
          (scrolls(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) ||
          (scrolls(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && el.tagName !== 'UL')
        );
      }).length,
    );
    expect(scrollable).toBe(0);

    // Hover the TOP row of the budget chart: the box above it used to be cut off by the scroller
    // and hidden under the chart above.
    const cell = page.getByTestId('budget-cell-firstLook-10');
    await cell.scrollIntoViewIfNeeded();
    await cell.hover();
    const tip = page.getByTestId('budget-weather-tip');
    await expect(tip).toBeVisible();
    await expectOnScreen(page, await tip.boundingBox());
    const cellBox = (await cell.boundingBox())!;
    const tipBox = (await tip.boundingBox())!;
    // It points at the cell: above it (or below, flipped), never on top of it.
    expect(tipBox.y + tipBox.height <= cellBox.y + 0.5 || tipBox.y >= cellBox.y + cellBox.height - 0.5).toBe(true);
    await page.screenshot({ path: `${SHOTS}/chronology-${width}-budget-hover.png`, fullPage: false });
  });
}

test('a marker on the hours-saved chart opens what happened that week, fully on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openChronology(page);
  // Week of 13 Jul: seven repositories joined at once.
  const marker = gainMarkers(page).nth(5);
  await marker.scrollIntoViewIfNeeded();
  // The head (and its count badge) is not cut by the heading above it.
  // Measured in one pass, so a scroll between reads cannot skew them.
  const clip = await marker.evaluate((el) => {
    const rail = el.parentElement!.getBoundingClientRect();
    const head = el.getBoundingClientRect();
    const badge = el.querySelector('span:last-child')!.getBoundingClientRect();
    return { head: head.top - rail.top, badge: badge.top - rail.top };
  });
  expect(clip.head).toBeGreaterThanOrEqual(0);
  expect(clip.badge).toBeGreaterThanOrEqual(0);

  await marker.click();
  await expect(popover(page)).toBeVisible();
  await expect(popover(page)).toContainText('Repository joined');
  await expect(popover(page)).toContainText('acme/habitat-metric-frontend joined the workspace');
  await expect(popover(page)).toContainText('and 1 more');
  await expect(popover(page)).toContainText('can move without anything changing in how people work');
  await expect(popover(page)).toContainText('That week on this chart');
  await expect(marker).toHaveAttribute('aria-expanded', 'true');
  await expectOnScreen(page, await popover(page).boundingBox());
  await expectUncovered(page);
  await page.screenshot({ path: `${SHOTS}/chronology-1440-event-popover.png` });

  // A second click closes it; Escape closes it too, and keyboard opens it.
  await marker.click();
  await expect(popover(page)).toHaveCount(0);
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(popover(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(marker).toBeFocused();

  // "Compare before and after" opens the lens.
  await marker.click();
  await popover(page).getByRole('button', { name: 'Compare before and after' }).click();
  await expect(page.getByTestId('chronology-trend-lens')).toBeVisible();
  await expect(popover(page)).toHaveCount(0);
});

test('the busiest marker (the current week) keeps its popover on screen at the right edge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChronology(page);
  const last = gainMarkers(page).last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(popover(page)).toContainText('Setting changed');
  await expect(popover(page)).toContainText('so far');
  await expectOnScreen(page, await popover(page).boundingBox());
  await expectUncovered(page);
  await page.screenshot({ path: `${SHOTS}/chronology-1280-event-popover-edge.png` });
});

test('the hours-saved chart no longer measures from a clicked week', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openChronology(page);
  const trend = page.getByTestId('chronology-trend');
  const baseline = trend.getByText(/^Baseline: half merged within/);
  const before = await baseline.textContent();
  const svg = trend.locator('svg[aria-label^="Working hours saved against the baseline"]');
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(baseline).toHaveText(before!);
  await expect(trend).not.toContainText('measure from');
  await expect(trend).not.toContainText('Measure hours saved');
  await expect(trend).not.toContainText('Use the default baseline');
});

test('on a phone the charts scroll sideways, and the popover and hover box stay on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChronology(page);
  const trend = page.getByTestId('chronology-trend');
  // 26 weeks need 640px: each chart scrolls inside its own box, the page does not.
  await expect(trend.locator('[data-scrolls]')).toHaveCount(3);
  const pageScrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(pageScrollsSideways).toBe(false);

  const marker = gainMarkers(page).nth(5);
  await marker.scrollIntoViewIfNeeded();
  await marker.click();
  await expect(popover(page)).toBeVisible();
  await expectOnScreen(page, await popover(page).boundingBox());
  await expectUncovered(page);
  await page.screenshot({ path: `${SHOTS}/chronology-390-event-popover.png` });
  await page.keyboard.press('Escape');

  const cell = page.getByTestId('budget-cell-firstLook-3');
  await cell.scrollIntoViewIfNeeded();
  await cell.hover();
  const tip = page.getByTestId('budget-weather-tip');
  await expect(tip).toBeVisible();
  await expectOnScreen(page, await tip.boundingBox());
  await page.screenshot({ path: `${SHOTS}/chronology-390-budget-hover.png` });
});
