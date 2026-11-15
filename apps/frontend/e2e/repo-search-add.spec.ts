import { test, expect } from '@playwright/test';
import type { Repo, RepoSearchResponse, RepoSearchResult } from '@pierre-review/shared';
import { installMockApi } from './mock-api.js';

// ADDING A REPO IS A STILL PICTURE. Reported: a search showed two results; pressing Add
// resized the "Repos & workspaces" modal, and the result list then "grew" into many more rows.
// Cause: the modal sized itself to its content (and widened when the sync panel opened), and its
// body clips overflow, so a short modal cut the dropdown off after two rows; the add made the
// modal taller and revealed the rest. Now the modal has one fixed size, so every result shows
// from the start and nothing moves when a repo is added.

const result = (i: number): RepoSearchResult => ({
  githubNodeId: `R_${i}`,
  owner: 'acme',
  name: `payments-${i}`,
  fullName: `acme/payments-${i}`,
  description: `Payments service ${i}`,
  ownerAvatarUrl: null,
  stargazerCount: 10 * i,
  openPrCount: i,
  url: `https://github.com/acme/payments-${i}`,
  isPrivate: false,
  isOwnedOrMember: true,
});
const RESULTS = Array.from({ length: 8 }, (_, i) => result(i + 1));

for (const viewport of [
  { width: 1600, height: 1000 },
  // a laptop: the old content-sized modal was shortest here, and cut the list off
  { width: 1280, height: 720 },
]) test(`the add-repo search shows every result and nothing resizes when a repo is added (${viewport.width}×${viewport.height})`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await installMockApi(page);
  const added: string[] = [];
  // Registered after installMockApi, so these win for their paths.
  await page.route('**/api/repos/search**', (route) =>
    route.fulfill({
      json: {
        results: RESULTS.filter((r) => !added.includes(r.fullName)),
        hasNextPage: false,
        cursor: null,
      } satisfies RepoSearchResponse,
    }),
  );
  await page.route('**/api/repos', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as { owner: string; name: string };
    added.push(`${body.owner}/${body.name}`);
    return route.fulfill({
      json: {
        id: 99,
        owner: body.owner,
        name: body.name,
        fullName: `${body.owner}/${body.name}`,
        createdAt: new Date().toISOString(),
        lastFullSyncAt: null,
        lastIncrementalSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
      } as unknown as Repo,
    });
  });

  await page.goto('/app/?workspace=1&view=activity');
  await page.getByRole('button', { name: /^Workspace:/ }).click();
  await page.getByText('Manage repos & workspaces').click();
  const dialog = page.getByRole('dialog', { name: 'Manage repos and workspaces' });
  await expect(dialog).toBeVisible();

  await dialog.locator('#add-repo-input').fill('payments');
  const listbox = page.getByRole('listbox', { name: 'Repository search results' });
  await expect(listbox.getByRole('option')).toHaveCount(RESULTS.length);

  // Every row the list holds is actually visible, not clipped by the modal.
  const lastVisible = async (): Promise<boolean> =>
    listbox.getByRole('option').last().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit != null && el.contains(hit);
    });
  await listbox.getByRole('option').last().scrollIntoViewIfNeeded();
  expect(await lastVisible()).toBe(true);

  // The whole dropdown sits inside the modal (whose body clips overflow): none of it is cut off.
  const before = await dialog.boundingBox();
  const list = await listbox.boundingBox();
  expect((list?.y ?? 0) + (list?.height ?? 0)).toBeLessThanOrEqual((before?.y ?? 0) + (before?.height ?? 0));

  await listbox.getByRole('option').first().click();
  // The added repo drops out of the list; nothing else appears.
  await expect(listbox.getByRole('option')).toHaveCount(RESULTS.length - 1);
  await page.waitForTimeout(500);
  const after = await dialog.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);
});
