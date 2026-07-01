import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// Regression gates for the consolidated Inbox Feed + focus-as-tab UX (see CLAUDE.md):
//   • the app lands on the INBOX by default (timeline is secondary)
//   • the "Feed" rail entry is selected and the consolidated stream renders, flat
//   • the legacy My Turn / Feed header pills are GONE
//   • the feed has no "seen/Done" control; acknowledged items are simply dropped
//   • clicking ANY feed item (My Turn or activity) opens a closable PR-focus tab (its
//     own isolated timeline) and leaves the Inbox overlay; My Turn items are marked
//     with a yellow-bordered card
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

  test('the consolidated Feed renders a flat chronological list (no tiers)', async ({ page }) => {
    await gotoInbox(page);
    // One flat list, no tier section headers.
    await expect(overlay(page).locator('section h3')).toHaveCount(0);
    // 4 mock items, but the acknowledged (seen) one is dropped now that the feed has no
    // "Done" concept → 3 rendered.
    await expect(overlay(page).locator('ul > li')).toHaveCount(3);
    // Comment-based items inline their (markdown-rendered) content.
    await expect(overlay(page).getByText('Can you take another look at this?')).toBeVisible();
  });

  test('the legacy My Turn / Feed header pills are removed', async ({ page }) => {
    await gotoInbox(page);
    // The two removed header pills had these stable testids — they must be gone.
    await expect(page.getByTestId('myturn-pill')).toHaveCount(0);
    await expect(page.getByTestId('feed-pill')).toHaveCount(0);
  });

  test('a My Turn item is marked with a yellow-bordered card', async ({ page }) => {
    await gotoInbox(page);
    const row = overlay(page).locator('ul > li', { hasText: 'Inbox: fix auth race' });
    await expect(row).toBeVisible();
    // My Turn items render as a yellow-bordered card (no Done/seen control).
    await expect(row.locator('article.border-yellow-400')).toBeVisible();
    await expect(row.getByText('My Turn')).toBeVisible();
  });

  test('clicking a My Turn item opens a PR-focus tab', async ({ page }) => {
    await gotoInbox(page);
    await overlay(page).getByText('Inbox: fix auth race').click(); // the awaiting_review item
    // Leaves the Inbox overlay and surfaces a closable PR-focus tab named by the PR.
    await expect(overlay(page)).toBeHidden();
    await expect(tabs(page).getByRole('button', { name: /PR focus/i })).toBeVisible();
    await expect(tabs(page).getByRole('button', { name: /Close focus tab/i })).toBeVisible();
  });

  test('clicking a feed event opens a PR-focus tab', async ({ page }) => {
    await gotoInbox(page);
    await overlay(page).getByText('Other: docs pass').click(); // the pr_opened feed event
    await expect(overlay(page)).toBeHidden();
    await expect(tabs(page).getByRole('button', { name: /PR focus/i })).toBeVisible();
  });

  test('the feed has no Done/seen control and drops acknowledged items', async ({ page }) => {
    await gotoInbox(page);
    // The old ✓ acknowledge toggle is gone entirely.
    await expect(overlay(page).getByRole('button', { name: /Mark seen/i })).toHaveCount(0);
    // The acknowledged mock item (#104 "Watched repo PR by bob") is not rendered.
    await expect(overlay(page).getByText('Watched repo PR by bob')).toHaveCount(0);
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
