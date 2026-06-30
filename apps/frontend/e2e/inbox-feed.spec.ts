import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// Regression gates for the consolidated Inbox Feed + focus-as-tab UX (see CLAUDE.md):
//   • the app lands on the INBOX by default (timeline is secondary)
//   • the "Feed" rail entry is selected and the consolidated stream renders, tiered
//   • the legacy My Turn / Feed header pills are GONE
//   • clicking a My Turn item enters My Turn Focus as a tab ("My Turn")
//   • clicking a thread / feed item enters PR Focus as a tab ("PR Focus") and leaves
//     the Inbox overlay
//   • the header Timeline | Inbox switch toggles the board

const overlay = (p: Page) => p.getByTestId('inbox-overlay');
const tabs = (p: Page) => p.getByTestId('pinned-tabs');

async function gotoInbox(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/app/');
  // Bare load lands on the Inbox overlay (Inbox-first).
  await expect(overlay(page)).toBeVisible();
}

test.describe('Inbox Feed / focus-as-tab flows', () => {
  test('lands on the Inbox with the Feed entry selected by default', async ({ page }) => {
    await gotoInbox(page);
    const feedRail = overlay(page).getByRole('button', { name: 'Feed', exact: true });
    await expect(feedRail).toBeVisible();
    await expect(feedRail).toHaveAttribute('aria-pressed', 'true');
  });

  test('the consolidated Feed renders the three priority tiers + items', async ({ page }) => {
    await gotoInbox(page);
    const headers = overlay(page).locator('section h3');
    await expect(headers).toHaveCount(3); // tier 0 / 1 / 2 all populated by the fixture
    await expect(overlay(page).locator('section ul li')).toHaveCount(3);
    // Comment-based items inline their content.
    await expect(overlay(page).getByText('Please address this nit before merge.')).toBeVisible();
  });

  test('the legacy My Turn / Feed header pills are removed', async ({ page }) => {
    await gotoInbox(page);
    // The two removed header pills had these stable testids — they must be gone.
    await expect(page.getByTestId('myturn-pill')).toHaveCount(0);
    await expect(page.getByTestId('feed-pill')).toHaveCount(0);
  });

  test('clicking a My Turn item enters My Turn Focus as a tab', async ({ page }) => {
    await gotoInbox(page);
    await overlay(page).getByText('Inbox: fix auth race').click(); // the awaiting_review item
    // Leaves the Inbox overlay and surfaces the focus tab labelled "My Turn".
    await expect(overlay(page)).toBeHidden();
    await expect(tabs(page).getByRole('button', { name: /My Turn/ })).toBeVisible();
  });

  test('clicking a thread item enters PR Focus as a tab', async ({ page }) => {
    await gotoInbox(page);
    await overlay(page).getByText('Inbox: add login form').click(); // the tier-0 thread item
    await expect(overlay(page)).toBeHidden();
    // PR-isolation focus surfaces a "PR Focus" tab (set once the timeline isolates).
    await expect(tabs(page).getByRole('button', { name: /PR Focus/ })).toBeVisible();
  });

  test('the Timeline | Inbox header switch toggles the board', async ({ page }) => {
    await gotoInbox(page);
    // The header switch is a tablist (role=tab), not plain buttons.
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('.vis-timeline')).toBeVisible();
    // …and back to the Inbox.
    await page.getByRole('tab', { name: 'Inbox' }).click();
    await expect(overlay(page)).toBeVisible();
  });
});
