import { test, expect } from '@playwright/test';
import type { SandboxWorkspaceSettingsBody } from '@pierre-review/shared';
import { installMockApi, ME_RESPONSE } from './mock-api.js';

// SETTINGS → SANDBOX → "AI Fix reads every repository" (components/settings/SandboxSection.tsx; docs/SANDBOX.md
// § AI Fix sessions → Scope): one per-workspace switch, ON by default, its explanation behind the ⓘ; a tick
// writes at once (no Save button), sending the WHOLE setting with the switch's value.

test('the AI Fix repositories switch: on by default, explained behind ⓘ, saved with the whole setting', async ({ page }) => {
  await installMockApi(page);
  // Settings → Sandbox is there while agentic AI is on.
  await page.route('**/api/me', (route) => route.fulfill({ json: { ...ME_RESPONSE, ai: { ...ME_RESPONSE.ai, enabled: true } } }));
  const puts: SandboxWorkspaceSettingsBody[] = [];
  await page.route(/\/api\/workspaces\/\d+\/sandbox$/, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as SandboxWorkspaceSettingsBody;
    puts.push(body);
    return route.fulfill({
      json: { workspaceId: 1, memoryProjects: null, userClaudeMd: true, userSkills: false, globalProxyEnv: false, resources: { cpus: null, memoryGb: null, diskGb: null }, services: [], alwaysAllowedHosts: [], fixAllRepos: body.fixAllRepos ?? true },
    });
  });
  await page.goto('/app/?workspace=1&view=activity');
  await page.getByRole('button', { name: /^Search or jump/ }).click();
  await page.keyboard.type('Settings: Sandbox');
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const section = settings.getByTestId('sandbox-settings');
  const box = section.getByRole('checkbox', { name: 'AI Fix reads every repository' });
  await expect(box).toBeChecked();

  await section.getByRole('button', { name: 'About “AI Fix reads every repository”' }).click();
  await expect(page.getByText('At most 12 repositories', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');

  await box.uncheck();
  await expect(section.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toMatchObject({ fixAllRepos: false, userClaudeMd: true, services: [] });
});
