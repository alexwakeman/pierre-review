import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi } from './mock-api.js';

// Regression gates for the consolidated Activity Feed + click-to-detail UX (see CLAUDE.md):
//   • a bare URL lands on the OPEN PRS tab (the default view); Activity opens on its Pending rail
//     entry; an empty workspace lands on the guidance to move repos in
//   • the sidebar reads Pending, Open pull requests, This Sprint, Timeline, Feed, Reports, Bots
//     Monitoring (Docs too, where AI runs)
//   • a legacy ?insightsTab=sprint|merged link lands on This Sprint
//   • the Open PRs trunk strip arrives collapsed, and expands on a click
//   • a Feed link names `?activityRepo=feed`, and the consolidated stream renders there, flat —
//     the stream ALONE (no daily brief, no trunk strip, no open-PR panel)
//   • Pending's My turn tab has two views: its cards, and the default branches + open PRs
//   • the legacy My Turn / Feed header pills are GONE
//   • each item is a real activity event flagged isMyTurn (participation) — My-Turn items
//     get a yellow-bordered card + badge; there is no "seen/Done" control
//   • clicking ANY feed item opens the full-height PR DETAIL tab (an overlay + a closable
//     PR tab), NOT an isolated timeline — Show/Focus in the detail then drive the timeline
//   • THE REDESIGN'S SHELL: one sidebar replaced the tab row and the Activity rail. Pending, Open
//     pull requests, This Sprint and Timeline lead it; Docs, Feed, Reports and Bots Monitoring
//     follow. `aria-current="page"` marks where you are. The tab strip (`pinned-tabs`) now holds
//     only the dynamic tabs (a PR, a drill-down) and renders nothing when none is open.

const overlay = (p: Page) => p.getByTestId('activity-overlay');
const tabs = (p: Page) => p.getByTestId('pinned-tabs');

async function gotoActivity(page: Page, query = ''): Promise<void> {
  await installMockApi(page);
  // A bare URL lands on Activity → Open PRs; Activity is named anyway — the link the app emits.
  const extra = query.replace(/^\?/, '');
  await page.goto('/app/' + (/(^|[?&])view=/.test(query) ? query : `?view=activity${extra ? `&${extra}` : ''}`));
  await expect(overlay(page)).toBeVisible();
}

// The Feed is one rail click below the landing, so a Feed spec names it in the URL — the same
// link the app emits.
const gotoFeed = (page: Page): Promise<void> =>
  gotoActivity(page, '?view=activity&activityRepo=feed');

// The sidebar's destination items, by their words (each carries a stable test id: its store value).
const NAV_ID: Record<string, string> = {
  Pending: 'attention',
  'Open PRs': 'open-prs',
  'This Sprint': 'sprint',
  Timeline: 'timeline',
  Docs: 'docs',
  Feed: 'feed',
  Reports: 'insights',
  'Bots Monitoring': 'bots',
};
const railButton = (p: Page, name: string) => p.getByTestId(`nav-${NAV_ID[name] ?? name}`);
const isCurrent = (p: Page, name: string) => expect(railButton(p, name)).toHaveAttribute('aria-current', 'page');
const isNotCurrent = (p: Page, name: string) => expect(railButton(p, name)).not.toHaveAttribute('aria-current', 'page');

test.describe('Activity Feed / click-to-detail flows', () => {
  test('lands on the Activity console with Open PRs selected by default', async ({ page }) => {
    await gotoActivity(page);
    await isCurrent(page, 'Open PRs');
    await isNotCurrent(page, 'Pending');
    // The list itself renders — a fixture gap would blank it rather than fail loudly.
    await expect(page.getByTestId('open-prs-view')).toBeVisible();
    // Open PRs is the default, so the app's own URL names no console.
    await expect(page).not.toHaveURL(/activityRepo=/);
    // Pending is a named console.
    await railButton(page, 'Pending').click();
    await expect(page.getByTestId('attention-view')).toBeVisible();
    await expect(page).toHaveURL(/activityRepo=attention/);
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
    await page.goto('/app/?view=activity&activityRepo=attention');
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
    await page.goto('/app/?view=activity&activityRepo=attention');
    await expect(overlay(page).getByText(/No repos in this workspace yet/)).toBeVisible();
    await expect(page.getByTestId('attention-view')).toHaveCount(0);
    // Still the Pending entry: the guidance replaces the board, not the selection.
    await isCurrent(page, 'Pending');
  });

  test('the sidebar reads Pending, Open pull requests, This Sprint, Timeline, then Feed, Reports, Bots Monitoring', async ({ page }) => {
    await gotoActivity(page);
    // The destination items, top to bottom (the LABEL span only: some carry a count after it).
    // Polled, because the sidebar can re-render while the workspace resolves. Docs shows only where
    // AI runs; the fixture's me has it off.
    await expect
      .poll(() =>
        page
          .getByTestId('sidebar')
          .locator('nav[aria-label="Main"] button[data-testid^="nav-"]')
          .evaluateAll((els) => els.map((el) => (el.querySelector('.nav-label')?.textContent ?? '').trim())),
      )
      .toEqual(['Pending', 'Open pull requests', 'This Sprint', 'Timeline', 'Feed', 'Reports', 'Bots Monitoring']);
    // No fixed views in the tab strip any more: with no PR open it is not there at all.
    await expect(tabs(page)).toHaveCount(0);
  });

  test('This Sprint is a sidebar destination, opening on Theme, with Critical path, People and Merged so far', async ({ page }) => {
    await gotoActivity(page);
    await railButton(page, 'This Sprint').click();
    const view = page.getByTestId('sprint-tab-view');
    await expect(view).toBeVisible();
    await expect(page).toHaveURL(/view=sprint/);
    await expect(view.getByRole('tab', { name: 'Theme' })).toHaveAttribute('aria-selected', 'true');
    await view.getByRole('tab', { name: 'People' }).click();
    await expect(page).toHaveURL(/sprintTab=people/);
    // A card shows its story in place (its corner arrow opens the story view).
    await expect(view.getByRole('button', { name: /^ACME-1: Export a report as CSV/ })).toBeVisible();

    await view.getByRole('tab', { name: 'Merged so far' }).click();
    await expect(view.getByRole('tab', { name: 'Merged so far' })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/sprintTab=merged/);
  });

  for (const [query, tab] of [
    ['?activityRepo=sprint', 'Theme'],
    ['?activityRepo=sprint&sprintTab=people', 'People'],
    ['?activityRepo=insights&insightsTab=sprint', 'Theme'],
    ['?activityRepo=insights&insightsTab=merged', 'Merged so far'],
  ] as const) {
    test(`a legacy ${query} link lands on the This Sprint tab → ${tab}`, async ({ page }) => {
      await installMockApi(page);
      await page.goto(`/app/?view=activity&${query.slice(1)}`);
      const view = page.getByTestId('sprint-tab-view');
      await expect(view.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/view=sprint/);
      await expect(page).not.toHaveURL(/insightsTab=|activityRepo=sprint/);
    });
  }

  test('the Open PRs trunk strip arrives collapsed, even with a red default branch', async ({ page }) => {
    await installMockApi(page);
    // A RED default branch — the state that used to arrive open. Registered after the mock, so it wins.
    await page.route(
      (url) => url.pathname.endsWith('/api/branch-status'),
      (route) =>
        route.fulfill({
          json: {
            repos: fixtures.BRANCH_STATUS.repos.map((r) => ({ ...r, ciStatus: 'failure' as const })),
          },
        }),
    );
    await page.goto('/app/?view=activity');
    await expect(overlay(page)).toBeVisible();
    const header = () =>
      page.getByTestId('open-prs-view').getByTestId('branch-status-panel').locator(':scope > button[aria-expanded]');
    await expect(header()).toHaveAttribute('aria-expanded', 'false');
    await header().click();
    await expect(header()).toHaveAttribute('aria-expanded', 'true');
    // Leaving and coming back is a fresh visit: collapsed again.
    await railButton(page, 'Feed').click();
    await expect(page.getByTestId('feed-view')).toBeVisible();
    await railButton(page, 'Open PRs').click();
    await expect(header()).toHaveAttribute('aria-expanded', 'false');
  });

  test('a Feed link opens the Feed and survives a reload', async ({ page }) => {
    await gotoFeed(page);
    await isCurrent(page, 'Feed');
    await page.reload();
    await expect(overlay(page)).toBeVisible();
    await isCurrent(page, 'Feed');
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

  test('Open PRs is headed by the default branches; My turn is not', async ({ page }) => {
    await gotoActivity(page);
    const list = page.getByTestId('open-prs-view');
    await expect(list.getByTestId('branch-status-panel')).toBeVisible();
    // No tab strip chip for Open PRs: it is a sidebar destination.
    await expect(tabs(page).getByRole('tab', { name: /^Open PRs/ })).toHaveCount(0);

    // ⚠ The branch read is CACHED now, so a strip still mounted on My turn would render at once —
    // the absence is a real check, not a race against a fetch.
    await railButton(page, 'Pending').click();
    const board = page.getByTestId('attention-view');
    await expect(board.getByRole('tab', { name: /My turn/ })).not.toContainText('…');
    await expect(board.getByTestId('branch-status-panel')).toHaveCount(0);
    await expect(board.getByTestId('open-prs-panel')).toHaveCount(0);
  });

  test('a bare URL lands on Activity → Open PRs', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/app/');
    await expect(overlay(page)).toBeVisible();
    await expect(page.getByTestId('open-prs-view')).toBeVisible();
  });

  test('a legacy ?view=open-prs link lands on Open PRs', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/app/?view=open-prs');
    await expect(overlay(page)).toBeVisible();
    await expect(page.getByTestId('open-prs-view')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open PRs', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/view=open-prs/);

    // A reload lands back on it.
    await page.reload();
    await expect(page.getByTestId('open-prs-view')).toBeVisible();
  });

  test('a legacy ?attnView=branches link lands on My turn and is never re-emitted', async ({
    page,
  }) => {
    await gotoActivity(page, '?activityRepo=attention&attnView=branches');
    const board = page.getByTestId('attention-view');
    await expect(board.getByRole('tab', { name: /My turn/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page).not.toHaveURL(/attnView=/);
  });

  test('the Feed is the stream alone: no daily brief, no trunk strip, no open-PR panel', async ({
    page,
  }) => {
    await installMockApi(page);
    // A non-zero brief, so the deleted strip WOULD have rendered. Registered after the mock, so it
    // wins.
    await page.route(
      (url) => url.pathname.endsWith('/api/daily-brief'),
      (route) =>
        route.fulfill({
          json: {
            ...fixtures.DAILY_BRIEF,
            counts: { ...fixtures.DAILY_BRIEF.counts, stalled: 3 },
          },
        }),
    );
    const brief = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/daily-brief'));
    // ⚠ ABSENCE NEEDS THE DATA FIRST. `toHaveCount(0)` passes the instant nothing is there, so on a
    // cold Feed load it passes before any of the three reads lands. Land on Open PRs, where the
    // trunk strip renders and the open-PR count has landed (the brief is read at boot by the
    // header), THEN open the Feed: every read is cached, so a panel still mounted there would paint
    // in the Feed's first render.
    await page.goto('/app/?view=activity');
    await expect(page.getByTestId('open-prs-view').getByTestId('branch-status-panel')).toBeVisible();
    await expect(railButton(page, 'Open PRs')).toContainText(/\d/);
    await (await brief).finished();

    await railButton(page, 'Feed').click();
    await expect(page.getByTestId('feed-view')).toBeVisible();
    // Soft, so a regression reports every panel that came back, not just the first.
    await expect.soft(page.getByTestId('brief-strip')).toHaveCount(0);
    await expect.soft(page.getByTestId('branch-status-panel')).toHaveCount(0);
    await expect.soft(page.getByTestId('open-prs-panel')).toHaveCount(0);
  });

  test('the sidebar toggles between the board and Activity; g-keys and i do too', async ({ page }) => {
    await gotoActivity(page);
    await railButton(page, 'Timeline').click();
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('.vis-timeline')).toBeVisible();
    await isCurrent(page, 'Timeline');
    // …and back to the Activity console.
    await railButton(page, 'Open PRs').click();
    await expect(overlay(page)).toBeVisible();
    // g then t: the board; i: Activity again; g then p: Pending.
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(overlay(page)).toBeHidden();
    await page.keyboard.press('i');
    await expect(overlay(page)).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/activityRepo=attention/);
  });

  test('⌘K and / open the command menu, which reaches every destination', async ({ page }) => {
    await gotoActivity(page);
    await page.keyboard.press('/');
    const palette = page.getByRole('dialog', { name: 'Command menu' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('feed');
    await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(palette.getByRole('option').first()).toContainText('Feed');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page).toHaveURL(/activityRepo=feed/);
    await isCurrent(page, 'Feed');
    // ⌘K (Ctrl+K off a Mac) opens it too, from anywhere.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await isCurrent(page, 'Feed');
  });

  test('? opens the key sheet and Escape closes it without leaving the page', async ({ page }) => {
    await gotoActivity(page, '?activityRepo=feed');
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-sheet')).toHaveCount(0);
    await expect(overlay(page)).toBeVisible();
    await isCurrent(page, 'Feed');
  });
});
