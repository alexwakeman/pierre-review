import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi } from './mock-api.js';

// Regression gates for the consolidated Activity Feed + click-to-detail UX (see CLAUDE.md):
//   • the app lands on the ACTIVITY console, on the Pending rail entry (timeline is secondary);
//     an empty workspace lands on the guidance to move repos in
//   • the rail reads Pending, Feed, Bots, Reports
//   • a Feed link names `?activityRepo=feed`, and the consolidated stream renders there, flat
//   • the legacy My Turn / Feed header pills are GONE
//   • each item is a real activity event flagged isMyTurn (participation) — My-Turn items
//     get a yellow-bordered card + badge; there is no "seen/Done" control
//   • clicking ANY feed item opens the full-height PR DETAIL tab (an overlay + a closable
//     PR tab), NOT an isolated timeline — Show/Focus in the detail then drive the timeline
//   • Activity + Timeline are permanent, non-closable TABS in the tab strip

const overlay = (p: Page) => p.getByTestId('activity-overlay');
const tabs = (p: Page) => p.getByTestId('pinned-tabs');

async function gotoActivity(page: Page, query = ''): Promise<void> {
  await installMockApi(page);
  await page.goto('/app/' + query);
  // Every load lands on the Activity console overlay (Activity-first).
  await expect(overlay(page)).toBeVisible();
}

// The Feed is one rail click below the landing, so a Feed spec names it in the URL — the same
// link the app emits.
const gotoFeed = (page: Page): Promise<void> =>
  gotoActivity(page, '?view=activity&activityRepo=feed');

const railButton = (p: Page, name: string) =>
  overlay(p).getByRole('button', { name, exact: true });

test.describe('Activity Feed / click-to-detail flows', () => {
  test('lands on the Activity console with Pending selected by default', async ({ page }) => {
    await gotoActivity(page);
    await expect(railButton(page, 'Pending')).toHaveAttribute('aria-pressed', 'true');
    await expect(railButton(page, 'Feed')).toHaveAttribute('aria-pressed', 'false');
    // The board itself renders — a fixture gap would blank it rather than fail loudly.
    await expect(page.getByTestId('attention-view')).toBeVisible();
    // Pending is the default, so the app's own URL names no console.
    await expect(page).not.toHaveURL(/activityRepo=/);
  });

  test('the landing board claims no counts before the workspace resolves', async ({ page }) => {
    await installMockApi(page);
    // Hold `GET /api/workspaces` open, so the store's `workspaceId` stays null (not resolved yet).
    // Registered after the mock, so it runs first and then hands the request on to it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname.endsWith('/api/workspaces'),
      async (route) => {
        await held;
        await route.fallback();
      },
    );
    await page.goto('/app/');
    const board = page.getByTestId('attention-view');
    await expect(board).toBeVisible();
    // Unknown is never zero: the badges wait, and the board does not say My turn is empty.
    const myTurn = board.getByRole('tab', { name: /My turn/ });
    await expect(myTurn).toContainText('…');
    await expect(board.getByText('Nothing is your turn right now.')).toHaveCount(0);
    release();
    await expect(myTurn).not.toContainText('…');
  });

  test('an empty workspace opens on the guidance to move repos in, not an empty board', async ({
    page,
  }) => {
    await installMockApi(page);
    // The account has a repo (`/api/repos`) but this workspace has none. Registered after the mock,
    // so it wins.
    await page.route(
      (url) => url.pathname.endsWith('/api/activity'),
      (route) => route.fulfill({ json: { ...fixtures.ACTIVITY, repos: [] } }),
    );
    await page.goto('/app/');
    await expect(overlay(page).getByText(/No repos in this workspace yet/)).toBeVisible();
    await expect(page.getByTestId('attention-view')).toHaveCount(0);
    // Still the Pending entry: the guidance replaces the board, not the selection.
    await expect(railButton(page, 'Pending')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the rail reads Pending, Feed, Bots, Reports', async ({ page }) => {
    await gotoActivity(page);
    // The four pseudo-rows are the first `aria-pressed` buttons in the overlay; the per-repo rows
    // follow them. Polled, because the rail can re-render while the workspace resolves.
    await expect
      .poll(() =>
        overlay(page)
          .locator('button[aria-pressed]')
          .evaluateAll((els) => els.slice(0, 4).map((el) => (el as HTMLElement).innerText.trim())),
      )
      .toEqual(['Pending', 'Feed', 'Bots', 'Reports']);
  });

  test('a Feed link opens the Feed and survives a reload', async ({ page }) => {
    await gotoFeed(page);
    await expect(railButton(page, 'Feed')).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(overlay(page)).toBeVisible();
    await expect(railButton(page, 'Feed')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/activityRepo=feed/);
  });

  test('the consolidated Feed renders a flat chronological list (no tiers)', async ({ page }) => {
    await gotoFeed(page);
    // One flat list, no tier section headers.
    await expect(overlay(page).locator('section h3')).toHaveCount(0);
    // All 3 mock items render (there is no "seen/Done" concept dropping any).
    await expect(overlay(page).locator('ul > li')).toHaveCount(3);
    // Comment-based items inline their (markdown-rendered) content.
    await expect(overlay(page).getByText('Can you take another look at this?')).toBeVisible();
  });

  test('the legacy My Turn / Feed header pills are removed', async ({ page }) => {
    await gotoFeed(page);
    await expect(page.getByTestId('myturn-pill')).toHaveCount(0);
    await expect(page.getByTestId('feed-pill')).toHaveCount(0);
  });

  test('a My Turn item is marked with a yellow-bordered card', async ({ page }) => {
    await gotoFeed(page);
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
    await gotoFeed(page);
    // The review-thread card renders its conversation inline (interacting with it is
    // stopPropagation'd), so open the tab via the card's PR-title affordance.
    await overlay(page).getByRole('button', { name: /Activity: fix auth race/ }).first().click();
    // Leaves the Activity overlay and shows the full-height PR detail overlay + a closable tab.
    await expect(overlay(page)).toBeHidden();
    await expect(page.getByTestId('pinned-pr-overlay')).toBeVisible();
    await expect(tabs(page).getByRole('button', { name: /Close detail tab/i })).toBeVisible();
  });

  test('clicking a plain feed event opens the PR detail tab', async ({ page }) => {
    await gotoFeed(page);
    await overlay(page).getByText('Other: docs pass').first().click();
    await expect(overlay(page)).toBeHidden();
    await expect(page.getByTestId('pinned-pr-overlay')).toBeVisible();
  });

  test('the feed has no Done/seen control', async ({ page }) => {
    await gotoFeed(page);
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
