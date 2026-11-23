import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { AdoptionCommentaryRequest, MeResponse } from '@pierre-review/shared';
import { adoptionCommentaryFor, installMockApi, ME_RESPONSE } from './mock-api.js';

// REPORTS → DOWNLOAD REPORT (docs/AI-ADOPTION-REPORT.md § The UI; docs/FRONTEND.md § Reports →
// Download report). The header action opens a dialog; NOTHING is fetched until Download is pressed;
// a neutral progress bar runs through the real stages; a real PDF downloads. With AI off there is no AI
// box; with AI on and the box ticked, one commentary call per commentary slide (eight).

async function open(page: Page, o: { ai?: boolean; slowFigures?: boolean } = {}): Promise<{ reads: string[]; commentary: AdoptionCommentaryRequest[] }> {
  await installMockApi(page);
  const seen = { reads: [] as string[], commentary: [] as AdoptionCommentaryRequest[] };
  if (o.ai) {
    await page.route('**/api/me', (route) =>
      route.fulfill({ json: { ...ME_RESPONSE, ai: { ...ME_RESPONSE.ai, enabled: true } } satisfies MeResponse }),
    );
  }
  await page.route('**/api/reports/ai-adoption**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/reports/ai-adoption/commentary' && o.ai) {
      const body = route.request().postDataJSON() as AdoptionCommentaryRequest;
      seen.commentary.push(body);
      return route.fulfill({ json: adoptionCommentaryFor(body) });
    }
    if (path === '/api/reports/ai-adoption') {
      seen.reads.push(route.request().url());
      // Slow enough that the progress bar is seen before the file arrives.
      if (o.slowFigures !== false) await new Promise((r) => setTimeout(r, 600));
    }
    return route.fallback();
  });
  await page.goto('/app/?activityRepo=insights');
  await expect(page.getByTestId('insights-view')).toBeVisible();
  return seen;
}

test('nothing is fetched until Download; the bar runs; a PDF downloads (AI off: no AI box)', async ({ page }) => {
  const seen = await open(page);
  await page.getByTestId('report-download').click();
  const dialog = page.getByRole('dialog', { name: 'Download report' });
  await expect(dialog).toBeVisible();
  // The report names nobody, so there is no option to hide names.
  await expect(dialog.getByText('Anonymise people')).toHaveCount(0);
  await expect(dialog.getByText('Write commentary with AI')).toHaveCount(0);
  // Opening the dialog fetched nothing.
  expect(seen.reads).toEqual([]);

  await dialog.getByTestId('report-prepared-for').fill('Northwind board');
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(dialog.getByRole('progressbar', { name: 'Making the report' })).toBeVisible();
  await expect(dialog.getByTestId('report-stage')).toContainText('Fetching figures');
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^ensemble-ai-adoption-default-\d{4}-\d{2}-\d{2}\.pdf$/);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(seen.reads.length).toBe(1);
  expect(seen.commentary).toEqual([]);
  // Nothing about AI in the done line.
  await expect(dialog.getByTestId('report-done')).toHaveText(/^Saved ensemble-ai-adoption-default-.*\.pdf\.$/);
});

test('with AI on and the box ticked, one commentary call per slide', async ({ page }) => {
  const seen = await open(page, { ai: true });
  await page.getByTestId('report-download').click();
  const dialog = page.getByRole('dialog', { name: 'Download report' });
  await dialog.getByText('Write commentary with AI').click();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  const download = await downloading;
  expect(readFileSync((await download.path())!).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(seen.commentary.map((c) => c.slide)).toEqual(['summary', 'adoption', 'people', 'delivery', 'courts', 'review_bots', 'guardrails', 'cost']);
  // Only the slide and the report's stamp go to the server: no name, no "Prepared for".
  for (const c of seen.commentary) expect(Object.keys(c).sort()).toEqual(['generatedAt', 'slide', 'workspaceId']);
  await expect(dialog.getByTestId('report-done')).toHaveText('Saved. AI wrote all 8 commentaries.');
});

test('closing the dialog cancels the build: no file', async ({ page }) => {
  await open(page);
  let downloaded = false;
  page.on('download', () => {
    downloaded = true;
  });
  await page.getByTestId('report-download').click();
  const dialog = page.getByRole('dialog', { name: 'Download report' });
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(downloaded).toBe(false);
});
