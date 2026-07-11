import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// Regression gates for the consolidated Activity Feed + click-to-detail UX (see CLAUDE.md):
//   • the app lands on the ACTIVITY console by default (timeline is secondary)
//   • the "Feed" rail entry is selected and the consolidated stream renders, flat
//   • the legacy My Turn / Feed header pills are GONE
//   • each item is a real activity event flagged isMyTurn (participation) — My-Turn items
//     get a yellow-bordered card + badge; there is no "seen/Done" control
//   • clicking ANY feed item opens the full-height PR DETAIL tab (an overlay + a closable
//     PR tab), NOT an isolated timeline — Show/Focus in the detail then drive the timeline
//   • Activity + Timeline are permanent, non-closable TABS in the tab strip

const overlay = (p: Page) => p.getByTestId('activity-overlay');
const tabs = (p: Page) => p.getByTestId('pinned-tabs');

async function gotoActivity(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/app/');
  // Bare load lands on the Activity console overlay (Activity-first).
  await expect(overlay(page)).toBeVisible();
}

test.describe('Activity Feed / click-to-detail flows', () => {
  test('lands on the Activity console with the Feed entry selected by default', async ({ page }) => {
    await gotoActivity(page);
    const feedRail = overlay(page).getByRole('button', { name: 'Feed', exact: true });
    await expect(feedRail).toBeVisible();
    await expect(feedRail).toHaveAttribute('aria-pressed', 'true');
  });

  test('the consolidated Feed renders a flat chronological list (no tiers)', async ({ page }) => {
    await gotoActivity(page);
    // One flat list, no tier section headers.
    await expect(overlay(page).locator('section h3')).toHaveCount(0);
    // All 3 mock items render (there is no "seen/Done" concept dropping any).
    await expect(overlay(page).locator('ul > li')).toHaveCount(3);
    // Comment-based items inline their (markdown-rendered) content.
    await expect(overlay(page).getByText('Can you take another look at this?')).toBeVisible();
  });

  test('the legacy My Turn / Feed header pills are removed', async ({ page }) => {
    await gotoActivity(page);
    await expect(page.getByTestId('myturn-pill')).toHaveCount(0);
    await expect(page.getByTestId('feed-pill')).toHaveCount(0);
  });

  test('a My Turn item is marked with a yellow-bordered card', async ({ page }) => {
    await gotoActivity(page);
    const row = overlay(page).locator('ul > li', {
      hasText: 'Can you take another look at this?',
    });
    await expect(row).toBeVisible();
    // My Turn (participated) items render as a yellow-bordered card with a badge + why-pill.
    await expect(row.locator('article.border-yellow-400')).toBeVisible();
    await expect(row.getByText('My Turn', { exact: true })).toBeVisible();
    await expect(row.getByText('You authored')).toBeVisible();
  });

  test('clicking a My Turn item opens the PR detail tab', async ({ page }) => {
    await gotoActivity(page);
    // The review-thread card renders its conversation inline (interacting with it is
    // stopPropagation'd), so open the tab via the card's PR-title affordance.
    await overlay(page).getByRole('button', { name: /Activity: fix auth race/ }).first().click();
    // Leaves the Activity overlay and shows the full-height PR detail overlay + a closable tab.
    await expect(overlay(page)).toBeHidden();
    await expect(page.getByTestId('pinned-pr-overlay')).toBeVisible();
    await expect(tabs(page).getByRole('button', { name: /Close detail tab/i })).toBeVisible();
  });

  test('clicking a plain feed event opens the PR detail tab', async ({ page }) => {
    await gotoActivity(page);
    await overlay(page).getByText('Other: docs pass').first().click();
    await expect(overlay(page)).toBeHidden();
    await expect(page.getByTestId('pinned-pr-overlay')).toBeVisible();
  });

  test('the feed has no Done/seen control', async ({ page }) => {
    await gotoActivity(page);
    await expect(overlay(page).getByRole('button', { name: /Mark seen/i })).toHaveCount(0);
  });

  test('the Activity | Timeline tabs toggle the board', async ({ page }) => {
    await gotoActivity(page);
    // Activity + Timeline are permanent tabs (role=tab) in the tab strip, not a header pill.
    await tabs(page).getByRole('tab', { name: 'Timeline' }).click();
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('.vis-timeline')).toBeVisible();
    // …and back to the Activity console.
    await tabs(page).getByRole('tab', { name: 'Activity' }).click();
    await expect(overlay(page)).toBeVisible();
  });
});
