import { test, expect, type Page } from '@playwright/test';
import { installMockApi, fixtures } from './mock-api.js';

// Regression gates for the My Turn / Feed / Focus-mode UX (see CLAUDE.md):
//   • the app lands on the FEED by default (My Turn pill NOT active)
//   • the My Turn pill ENTERS My Turn Focus Mode (board isolated to the whole inbox)
//   • opening a To Do keeps ALL inbox PRs on the board + highlights one (never "just one")
//   • clicking empty canvas in focus does NOT blank the board (returns to the To Do list)
//   • browser Back steps L2 → L1 → Feed home
//   • clicking a Feed item navigates the timeline WITHOUT entering any focus mode
//   • PR-isolation focus and My Turn focus are discrete (one never leaks into the other)

const FULL_BOARD = fixtures.PRS.length; // 5
const INBOX = fixtures.INBOX_IDS.length; // 3

const feedPill = (p: Page) => p.getByTestId('feed-pill');
const myTurnPill = (p: Page) => p.getByTestId('myturn-pill');
const exitMyTurnPill = (p: Page) => p.getByRole('button', { name: 'Exit My Turn focus' });
const prBars = (p: Page) => p.locator('.vis-item.pr-bar:not(.pr-focus-hidden)');

async function gotoApp(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/app/');
  await page.waitForSelector('.vis-timeline');
  // Wait for the full board to paint so later isolation assertions are meaningful.
  await expect(prBars(page)).toHaveCount(FULL_BOARD);
}

async function enterMyTurnFocus(page: Page): Promise<void> {
  await myTurnPill(page).click();
  await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('myturn-panel')).toBeVisible();
  await expect(prBars(page)).toHaveCount(INBOX);
}

test.describe('My Turn / Feed / Focus-mode flows', () => {
  test('lands on the Feed by default (My Turn pill not active)', async ({ page }) => {
    await gotoApp(page);
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(page.getByTestId('myturn-panel')).toHaveCount(0);
    await expect(feedPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');
    // The full board shows every PR; nothing is isolated on a fresh load.
    await expect(prBars(page)).toHaveCount(FULL_BOARD);
  });

  test('the My Turn pill enters My Turn Focus Mode showing the WHOLE inbox', async ({ page }) => {
    await gotoApp(page);
    await enterMyTurnFocus(page);
    // The board is isolated to the inbox subset (fewer than the full board) — and to MORE
    // than one PR. This is the core "shows only that one PR" regression guard.
    await expect(prBars(page)).toHaveCount(INBOX);
    expect(INBOX).toBeGreaterThan(1);
    expect(INBOX).toBeLessThan(FULL_BOARD);
    await expect(exitMyTurnPill(page)).toBeVisible();
    await expect(feedPill(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('My Turn focus shows watched-repo PRs, not only awaiting-review (regression #54)', async ({ page }) => {
    await gotoApp(page);
    await enterMyTurnFocus(page); // asserts the board shows ALL inbox PRs (count === INBOX)
    // A new PR in a Watched repo is a distinct inbox section. It was being filtered off the
    // focus board (watchedRepoPrs wasn't in the focus id set), so an inbox containing one
    // rendered empty until the card was clicked. Its bar must be present in focus.
    await expect(
      page.locator('.vis-item.pr-bar', { hasText: 'Watched repo PR' }),
    ).toHaveCount(1);
  });

  test('My Turn focus zooms the window to fit the inbox (PRs fill the available width)', async ({ page }) => {
    await gotoApp(page);
    // A bar's width on the full (14-day) board…
    const bar = page.locator('.vis-item.pr-bar', { hasText: 'Watched repo PR' });
    await expect(bar).toBeVisible();
    const before = (await bar.boundingBox())!.width;

    await enterMyTurnFocus(page);
    // …grows substantially once focus zooms the window tight to the inbox span, instead of
    // leaving the PR squished in a corner of the wide date-filter view.
    await expect(async () => {
      const box = await bar.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(before * 1.3);
    }).toPass({ timeout: 6000 });
  });

  test('opening a To Do shows its PR detail while keeping ALL inbox PRs on the board', async ({ page }) => {
    await gotoApp(page);
    await enterMyTurnFocus(page);
    await page.getByTestId('myturn-row-open').first().click();
    // The PR detail opens (a PR is selected)…
    await expect(page.getByTestId('detail-clear')).toBeVisible();
    // …we're STILL in My Turn focus…
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'true');
    // …and EVERY inbox PR is still on the board (not reduced to the one we opened).
    await expect(prBars(page)).toHaveCount(INBOX);
  });

  test('clicking empty canvas in focus deselects WITHOUT blanking the board', async ({ page }) => {
    await gotoApp(page);
    await enterMyTurnFocus(page);
    await page.getByTestId('myturn-row-open').first().click();
    await expect(page.getByTestId('detail-clear')).toBeVisible();

    // Click an empty region of the timeline canvas (low in the center panel, below the
    // packed bars). It must drop the selection (back to the To Do list) but keep every
    // inbox PR visible — the "all PRs disappear" regression.
    const center = page.locator('.vis-panel.vis-center');
    const box = await center.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 40, box!.y + box!.height - 30);

    await expect(page.getByTestId('detail-clear')).toHaveCount(0);
    await expect(page.getByTestId('myturn-panel')).toBeVisible();
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(prBars(page)).toHaveCount(INBOX);
  });

  test('browser Back steps L2 (PR) → L1 (To Do list) → Feed home', async ({ page }) => {
    await gotoApp(page);
    await enterMyTurnFocus(page);
    await page.getByTestId('myturn-row-open').first().click();
    await expect(page.getByTestId('detail-clear')).toBeVisible();

    // Back #1: PR detail → the To Do list (still in My Turn focus, all inbox PRs shown).
    await page.goBack();
    await expect(page.getByTestId('detail-clear')).toHaveCount(0);
    await expect(page.getByTestId('myturn-panel')).toBeVisible();
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(prBars(page)).toHaveCount(INBOX);

    // Back #2: the To Do list → the Feed home (focus left, full board restored).
    await page.goBack();
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(prBars(page)).toHaveCount(FULL_BOARD);
  });

  test('a programmatic full-exit (Esc) does not swallow the next Back press', async ({ page }) => {
    // Guards the history-suppress accounting: exiting from L2 unwinds 2 entries with a
    // single history.go(-2) → exactly ONE popstate to swallow. Over-counting left the
    // suppress counter armed and ate the user's next genuine Back. Reproduce by exiting,
    // re-entering, then pressing Back — which must leave focus (not be swallowed).
    await gotoApp(page);
    await enterMyTurnFocus(page);
    await page.getByTestId('myturn-row-open').first().click(); // L2
    await expect(page.getByTestId('detail-clear')).toBeVisible();

    await page.keyboard.press('Escape'); // full exit from L2 → Feed home (unwinds 2)
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');

    await enterMyTurnFocus(page); // re-enter (L1)
    await page.goBack(); // must be honoured, not swallowed → back to the Feed
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('clicking a LIFECYCLE Feed item navigates the timeline WITHOUT entering any focus mode', async ({ page }) => {
    await gotoApp(page);
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    // The first feed item is a pr_opened lifecycle event (no marker) → a plain navigate.
    await page.getByRole('button', { name: 'Show on timeline' }).first().click();

    // A PR is now selected (its detail), but we are NOT in My Turn focus, NOT in the
    // PR-isolation overlay, and the board is the FULL board — a plain timeline navigation.
    await expect(page.getByTestId('detail-clear')).toBeVisible();
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(exitMyTurnPill(page)).toHaveCount(0);
    await expect(page.locator('.tl-focus-active')).toHaveCount(0);
    await expect(prBars(page)).toHaveCount(FULL_BOARD);

    // Browser Back returns to the Feed home (selection cleared, full board).
    await page.goBack();
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(page.getByTestId('detail-clear')).toHaveCount(0);
    await expect(feedPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(prBars(page)).toHaveCount(FULL_BOARD);
  });

  test('a programmatic exit from a feed navigation (Esc) does not swallow the next Back', async ({ page }) => {
    // Guards the feed back-stack's suppress accounting: leaving a feed-originated selection
    // the programmatic way (Esc → clear selection) unwinds the {pierreFeed} entry with a
    // single history.go → exactly ONE popstate to swallow. Over-counting would leave the
    // counter armed and eat the user's next genuine Back. Reproduce: open a lifecycle feed
    // item, Esc back to the Feed, open another, then Back — which must be honoured.
    await gotoApp(page);
    await expect(page.getByTestId('feed-panel')).toBeVisible();

    // Lifecycle feed item (no popover) → a plain navigate, {pierreFeed} pushed.
    await page.getByRole('button', { name: 'Show on timeline' }).first().click();
    await expect(page.getByTestId('detail-clear')).toBeVisible();

    // Esc clears the selection (programmatic exit) → the Feed home; the {pierreFeed} entry
    // is unwound here, NOT by a Back.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(page.getByTestId('detail-clear')).toHaveCount(0);

    // Open another feed item, then Back — must be honoured (not swallowed) → the Feed home.
    await page.getByRole('button', { name: 'Show on timeline' }).first().click();
    await expect(page.getByTestId('detail-clear')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(page.getByTestId('detail-clear')).toHaveCount(0);
  });

  test('clicking an OWN-WORK marker Feed item opens its popover WITHOUT entering focus', async ({ page }) => {
    await gotoApp(page);
    const panel = page.getByTestId('feed-panel');
    await expect(panel).toBeVisible();
    // BOB's comment on BOB's own PR #103 ("Inbox: tidy router") is own-work + has a marker.
    await panel
      .locator('li', { hasText: 'Inbox: tidy router' })
      .getByRole('button', { name: 'Show on timeline' })
      .click();

    // The event's popover opens (content readable inline), but the board stays full and
    // un-focused — own-work events never enter the PR-isolation overlay.
    await expect(page.getByTestId('marker-popover')).toBeVisible();
    await expect(page.locator('.tl-focus-active')).toHaveCount(0);
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(prBars(page)).toHaveCount(FULL_BOARD);

    // Browser Back returns to the Feed home in ONE press — closing the popover and
    // clearing the selection together (the feed popover has no back-slot of its own).
    await page.goBack();
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(page.getByTestId('marker-popover')).toHaveCount(0);
    await expect(page.getByTestId('detail-clear')).toHaveCount(0);
    await expect(feedPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(prBars(page)).toHaveCount(FULL_BOARD);
  });

  test('clicking a CROSS-PERSON marker Feed item enters PR Focus AND opens the popover', async ({ page }) => {
    await gotoApp(page);
    const panel = page.getByTestId('feed-panel');
    await expect(panel).toBeVisible();
    // My review on ALICE's PR #101 ("Inbox: add login form") is cross-person + has a marker.
    await panel
      .locator('li', { hasText: 'Inbox: add login form' })
      .getByRole('button', { name: 'Show on timeline' })
      .click();

    // The timeline enters the PR-isolation Focus overlay (NOT My Turn focus) and opens the
    // event's popover after focusing, so the content reads inline immediately.
    await expect(page.locator('.tl-focus-active')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Exit focus mode' })).toBeVisible();
    await expect(page.getByTestId('marker-popover')).toBeVisible();
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');
    // Focus isolates the board to the PR's contributors — strictly fewer bars than full.
    await expect(prBars(page)).toHaveCount(1);

    // Browser Back returns to the Feed home in ONE press — skipping the intermediate
    // "full board, PR still selected" state: it leaves PR Focus, clears the selection,
    // and restores the full board, all together.
    await page.goBack();
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(page.locator('.tl-focus-active')).toHaveCount(0);
    await expect(page.getByTestId('detail-clear')).toHaveCount(0);
    await expect(feedPill(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(prBars(page)).toHaveCount(FULL_BOARD);
  });

  test('navigating out of a feed-entered focus (k) tears the focus down with it', async ({ page }) => {
    // A feed-entered PR Focus rides the single {pierreFeed} history entry (it pushes no
    // {pierreFocus} of its own). Clearing feedReturn the programmatic way — here pressing
    // `k` to select a different PR — must tear the focus overlay down too, so the board
    // can't stay collapsed to the old PR while the selection moves on (the overlay would
    // otherwise outlive its only history entry).
    await gotoApp(page);
    const panel = page.getByTestId('feed-panel');
    await expect(panel).toBeVisible();
    await panel
      .locator('li', { hasText: 'Inbox: add login form' })
      .getByRole('button', { name: 'Show on timeline' })
      .click();
    await expect(page.locator('.tl-focus-active')).toHaveCount(1);

    // Close the popover so the keypress isn't captured, focus stays up.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('marker-popover')).toHaveCount(0);
    await expect(page.locator('.tl-focus-active')).toHaveCount(1);

    // `k` selects a different PR → the feed-entered focus tears down, board un-collapses.
    await page.keyboard.press('k');
    await expect(page.locator('.tl-focus-active')).toHaveCount(0);
    await expect(prBars(page)).toHaveCount(FULL_BOARD);
    await expect(page.getByTestId('detail-clear')).toBeVisible();
  });

  test('feed → focus → Esc (exit focus) → Back still returns to the Feed home', async ({ page }) => {
    // Guards the history-suppress accounting on the feed back-stack: exiting PR Focus the
    // programmatic way (Esc) unwinds the {pierreFocus} entry but KEEPS the selection (the
    // documented Esc behaviour), leaving the {pierreFeed} entry on the stack. A subsequent
    // genuine Back must still be honoured (not swallowed) and land on the Feed home.
    await gotoApp(page);
    const panel = page.getByTestId('feed-panel');
    await expect(panel).toBeVisible();
    await panel
      .locator('li', { hasText: 'Inbox: add login form' })
      .getByRole('button', { name: 'Show on timeline' })
      .click();
    await expect(page.locator('.tl-focus-active')).toHaveCount(1);
    await expect(page.getByTestId('marker-popover')).toBeVisible();

    // Esc #1 closes the open popover (focus stays — the user keeps exploring the PR).
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('marker-popover')).toHaveCount(0);
    await expect(page.locator('.tl-focus-active')).toHaveCount(1);

    // Esc #2 leaves PR Focus but keeps the PR selected (detail pane stays open).
    await page.keyboard.press('Escape');
    await expect(page.locator('.tl-focus-active')).toHaveCount(0);
    await expect(page.getByTestId('detail-clear')).toBeVisible();

    // Back is honoured (not swallowed by the focus-exit's suppress) → the Feed home.
    await page.goBack();
    await expect(page.getByTestId('feed-panel')).toBeVisible();
    await expect(page.getByTestId('detail-clear')).toHaveCount(0);
    await expect(prBars(page)).toHaveCount(FULL_BOARD);
  });

  test('PR-isolation focus is discrete from My Turn focus', async ({ page }) => {
    await gotoApp(page);
    const timeline = page.locator('.vis-timeline');

    // Double-clicking a bar on the full board enters the PR-isolation overlay…
    await prBars(page).first().dblclick();
    await expect(page.locator('.tl-focus-active')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Exit focus mode' })).toBeVisible();
    // …which is NOT My Turn focus.
    await expect(myTurnPill(page)).toHaveAttribute('aria-pressed', 'false');

    // Esc leaves it cleanly, back to the full board.
    await page.keyboard.press('Escape');
    await expect(page.locator('.tl-focus-active')).toHaveCount(0);
    await expect(prBars(page)).toHaveCount(FULL_BOARD);

    // And entering My Turn focus never raises the PR-isolation overlay.
    await enterMyTurnFocus(page);
    await expect(timeline).not.toHaveClass(/tl-focus-active/);
  });
});
