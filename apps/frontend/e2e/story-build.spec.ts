import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi } from './mock-api.js';

// "Implement story" (docs/STORY-BUILD.md) against the mocked API (mock-api.ts keeps ACME-1's session
// per page): the Implement button sits ONLY on the not-started card with no pull request (owner
// decision 4), opens the build tab, Start makes a plan, Accept builds, Push pushes one repository.

/** The fixtures keep AI dark; this feature needs it on (`me.ai.enabled`). */
async function withAi(page: Page): Promise<void> {
  await installMockApi(page);
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route(
    (u) => u.pathname.endsWith('/api/me'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
}

async function gotoSprint(page: Page): Promise<void> {
  await withAi(page);
  await page.goto('/app/?view=sprint');
  await expect(page.getByTestId('sprint-view')).toBeVisible();
}

test.describe('Implement story', () => {
  test('only the not-started ticket with no pull request offers Implement', async ({ page }) => {
    await gotoSprint(page);
    const acme1 = page.locator('[data-ticket="ACME-1"]').first();
    const acme2 = page.locator('[data-ticket="ACME-2"]').first();
    await expect(acme1.getByRole('button', { name: 'Implement ACME-1' })).toHaveCount(1);
    await expect(acme2.getByTestId('ticket-implement')).toHaveCount(0);
  });

  test('open from the card, start, accept, push', async ({ page }) => {
    await gotoSprint(page);
    const card = page.locator('[data-ticket="ACME-1"]').first();
    await card.hover();
    await card.getByRole('button', { name: 'Implement ACME-1' }).click();

    const view = page.getByTestId('story-build-overlay');
    await expect(view).toBeVisible();
    await expect(page).toHaveURL(/view=story-build%3A/);
    await expect(view.getByTestId('story-build-start')).toBeVisible();

    await view.getByTestId('story-build-start-button').click();
    await expect(view.getByTestId('story-build-summary')).toContainText('CSV endpoint');
    await expect(view.getByTestId('story-build-plan-repo')).toHaveCount(2);
    // Every gap the plan closes is listed under "Already done".
    await expect(view.getByTestId('story-build-criterion')).toHaveCount(3);

    // The steps sit behind Details.
    await view.getByTestId('story-build-plan-repo').first().getByRole('button', { name: 'Details' }).click();
    await expect(view.getByTestId('story-build-steps-detail')).toContainText('Stream a report as CSV');

    await view.getByRole('button', { name: 'Accept plan and build' }).click();
    await expect(view.getByTestId('story-build-repo')).toHaveCount(2);
    await expect(view.getByRole('button', { name: 'Push all' })).toBeVisible();

    // The diff is read only when opened.
    const api = view.locator('[data-testid="story-build-repo"][data-repo="acme/api"]');
    await api.getByTestId('story-build-diff-toggle').click();
    await expect(api.getByTestId('story-build-diff')).toContainText('csvHeader');

    await api.getByRole('button', { name: 'Push as draft' }).click();
    await expect(api).toHaveAttribute('data-status', 'pushed');
    await expect(api.getByTestId('story-build-pushed-pr')).toContainText('#77');
  });

  test('never offered while AI is off', async ({ page }) => {
    await installMockApi(page);
    await page.goto('/app/?view=sprint');
    await expect(page.getByTestId('sprint-view')).toBeVisible();
    await expect(page.locator('[data-ticket="ACME-1"]').first()).toBeVisible();
    await expect(page.getByTestId('ticket-implement')).toHaveCount(0);
  });

  test('a build tab URL re-creates the tab', async ({ page }) => {
    await withAi(page);
    await page.goto(`/app/?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#ACME-1')}`);
    await expect(page.getByTestId('story-build-overlay')).toBeVisible();
    await expect(page.getByTestId('story-build-header')).toContainText('ACME-1');
  });
});
