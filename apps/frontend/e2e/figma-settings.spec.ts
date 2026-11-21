import { expect, test } from '@playwright/test';
import type { FigmaConnectionCheck, WorkspaceFigmaSettings, WorkspaceFigmaUpdate } from '@pierre-review/shared';
import { installMockApi } from './mock-api.js';

// Settings → Integrations → Figma (docs/IMPLEMENT-UI-PLAN.md § 3): a WRITE-ONLY token, written on Enter, never
// shown again; "Test token" is a press.
test('the Figma token: saved on Enter, never shown, Replace / Remove, Test token on a press', async ({ page }) => {
  await installMockApi(page);
  let saved: WorkspaceFigmaSettings = { workspaceId: 1, hasToken: false, tokenUnreadable: false };
  const puts: WorkspaceFigmaUpdate[] = [];
  let checks = 0;
  await page.route(/\/api\/workspaces\/\d+\/figma$/, async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as WorkspaceFigmaUpdate;
      puts.push(body);
      saved = { ...saved, hasToken: body.clearToken !== true };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) });
  });
  await page.route(/\/api\/workspaces\/\d+\/figma\/check$/, async (route) => {
    checks += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workspaceId: 1, ok: true, message: 'The token works, as Ada.' } satisfies FigmaConnectionCheck) });
  });
  await page.goto('/app/?workspace=1&view=activity');
  await page.getByRole('button', { name: /^Search or jump/ }).click();
  await page.keyboard.type('Settings: Integrations');
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const token = settings.getByTestId('figma-token');
  await expect(token).toBeVisible();
  expect(checks).toBe(0);
  await expect(settings.getByRole('button', { name: 'Test token' })).toBeDisabled();

  await token.fill('figd_secret');
  await token.press('Enter');
  await expect(settings.getByTestId('figma-token-saved')).toHaveText('Saved');
  expect(puts).toEqual([{ token: 'figd_secret' }]);
  await expect(settings.getByTestId('figma-token')).toHaveCount(0);
  await expect(page.locator('input[value="figd_secret"]')).toHaveCount(0);

  await settings.getByRole('button', { name: 'Test token' }).click();
  await expect(settings.getByText('The token works, as Ada.')).toBeVisible();
  expect(checks).toBe(1);

  await settings.getByTestId('figma-token-saved').locator('xpath=..').getByRole('button', { name: 'Remove' }).click();
  await expect(settings.getByTestId('figma-token')).toBeVisible();
  expect(puts.at(-1)).toEqual({ clearToken: true });
});
