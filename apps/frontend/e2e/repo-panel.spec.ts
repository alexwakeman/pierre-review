import { test, expect, type Page } from '@playwright/test';
import { resolveToolSwitch, type MeResponse, type RepoOverviewResponse, type SyncStatus } from '@pierre-review/shared';
import { installMockApi, ME_RESPONSE } from './mock-api.js';

// ONE REPO's PANEL in Repos & workspaces (components/Activity/RepoPanel.tsx), opened by clicking a repo:
//   · its first full sync shows as a bar while it runs;
//   · what was synced: pull requests by state;
//   · BOT SCORING IS OPT-IN: off by default; switching it on saves at once and shows this repo's scoring;
//   · without the model, one line says so and links to Settings → Features.

async function setup(page: Page, botInstalled: boolean): Promise<{ puts: unknown[] }> {
  const seen = { puts: [] as unknown[] };
  let enabled = false;
  await installMockApi(page);
  const me: MeResponse = {
    ...ME_RESPONSE,
    mlSeverity: botInstalled,
    ml: { state: botInstalled ? 'ready' : 'absent', message: null },
    tools: {
      ai: resolveToolSwitch(null, true, []),
      botAnalysis: resolveToolSwitch(null, botInstalled, []),
    },
  };
  await page.route('**/api/me', (route) => route.fulfill({ json: me }));
  // The first sync is running: the 90-day backfill, 40% in.
  await page.route('**/api/repos/*/sync-status', (route) =>
    route.fulfill({
      json: {
        repoId: 10,
        status: 'running',
        progress: { percent: 0.4, prsProcessed: 17, pages: 2, mode: 'full', foregroundComplete: true },
        lastFullSyncAt: null,
        lastIncrementalSyncAt: null,
        lastSyncError: null,
      } satisfies SyncStatus,
    }),
  );
  await page.route('**/api/repos/*/overview', (route) =>
    route.fulfill({
      json: {
        repoId: 10,
        prs: { total: 17, open: 4, merged: 11, closed: 2 },
        authors: 5,
        botScoring: { enabled, labelled: enabled ? 1 : 0, pending: enabled ? 3 : 0 },
      } satisfies RepoOverviewResponse,
    }),
  );
  await page.route('**/api/repos/*/bot-scoring', (route) => {
    const body = route.request().postDataJSON() as { enabled: boolean };
    seen.puts.push(body);
    enabled = body.enabled;
    return route.fulfill({ json: { id: 10, botScoring: body.enabled } });
  });
  return seen;
}

async function openPanel(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/app/?workspace=1&view=activity');
  await page.getByRole('button', { name: /^Workspace:/ }).click();
  await page.getByText('Manage repos & workspaces').click();
  await page.getByTestId('manager-repo-open').first().click();
  const panel = page.getByTestId('repo-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('a repo’s panel shows its first sync and what was synced; Bot scoring is off until switched on', async ({ page }) => {
  const seen = await setup(page, true);
  const panel = await openPanel(page);
  await expect(panel.getByRole('heading', { name: 'acme/web' })).toBeVisible();
  await expect(panel.getByTestId('repo-panel-sync')).toContainText('Loading the last 90 days');
  await expect(panel.getByRole('progressbar', { name: /Loading the last 90 days/ })).toHaveAttribute('aria-valuenow', '40');
  await expect(panel.getByTestId('repo-panel-stats')).toContainText('17');
  await expect(panel.getByTestId('repo-panel-stats')).toContainText('Merged11');

  const scoring = panel.getByTestId('repo-panel-bot-scoring');
  await expect(scoring).not.toBeChecked();
  await scoring.click({ force: true });
  await expect.poll(() => seen.puts).toEqual([{ enabled: true }]);
  await expect(scoring).toBeChecked();
  await expect(panel.getByTestId('repo-panel-scoring')).toContainText('1 of 4');
  await expect(panel.getByRole('progressbar', { name: /Scoring bot comments/ })).toHaveAttribute('aria-valuenow', '25');
});

test('without the model, the panel says so and links to Settings → Features', async ({ page }) => {
  await setup(page, false);
  const panel = await openPanel(page);
  await expect(panel.getByTestId('repo-panel-bot-scoring')).toHaveCount(0);
  await expect(panel.getByTestId('repo-panel-bot-setup')).toContainText('not set up on this machine');
  await panel.getByRole('button', { name: 'Set up in Settings → Features' }).click();
  // Repos & workspaces closes first, so Settings is not opened behind it.
  await expect(page.getByRole('dialog', { name: 'Manage repos and workspaces' })).toHaveCount(0);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('tab', { name: 'Features', exact: true })).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'Features', exact: true })).toHaveAttribute('aria-selected', 'true');
});
