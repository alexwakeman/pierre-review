import { test, expect, type Page } from '@playwright/test';
import { aiKindsAll, resolveAiRunProfiles, type AiRunProfiles, type AiRunProfilesResponse, type CodexLoginResponse, type MeResponse } from '@pierre-review/shared';
import { installMockApi, ME_RESPONSE } from './mock-api.js';

// SETTINGS → AI → REVIEW, AI FIX, IMPLEMENT STORY (components/settings/AiProviderSection.tsx
// `RunProfilesControl`; docs/CLAUDE-REVIEW.md § The run profiles). The blocks that replaced the one Effort
// control:
//   · a review vendor that is not signed in shows its sign-in line instead of controls;
//   · each change sends the WHOLE profiles object, but only its own block changes (a missing AI Fix block
//     stays missing — auto fix keeps its review's model until the reader sets one);
//   · one review vendor must stay on: the last one's switch is disabled;
//   · REVIEW_EFFORT locks every effort control.

async function setup(page: Page, o: { codex: boolean; envEffort?: boolean }): Promise<{ puts: AiRunProfiles[] }> {
  const seen = { puts: [] as AiRunProfiles[] };
  await installMockApi(page);
  let stored: AiRunProfiles | null = null;
  const status = () =>
    resolveAiRunProfiles(stored, { legacyEffort: null, envEffort: o.envEffort ? 'high' : null, defaultProvider: 'claude' });
  const me = (): MeResponse => ({
    ...ME_RESPONSE,
    ai: {
      ...ME_RESPONSE.ai,
      enabled: true,
      runProfiles: status(),
      providers: {
        ...ME_RESPONSE.ai.providers,
        codex: o.codex
          ? {
              ...ME_RESPONSE.ai.providers.codex,
              runtime: 'ready',
              auth: 'ok',
              route: 'login',
              signedIn: true,
              available: true,
              message: null,
              kinds: aiKindsAll({ auth: 'ok', message: null }),
            }
          : ME_RESPONSE.ai.providers.codex,
      },
    },
  });
  await page.route('**/api/me', (route) => route.fulfill({ json: me() }));
  // Codex is signed in: Settings → AI reads its sign-in state (never the catch-all `{}`).
  await page.route('**/api/ai/codex/login', (route) =>
    route.fulfill({ json: { login: { state: 'idle' }, signedIn: o.codex, plan: null } satisfies CodexLoginResponse }),
  );
  await page.route('**/api/ai/run-profiles', (route) => {
    const body = route.request().postDataJSON() as { profiles: AiRunProfiles };
    seen.puts.push(body.profiles);
    stored = body.profiles;
    return route.fulfill({ json: { runProfiles: status() } satisfies AiRunProfilesResponse });
  });
  return seen;
}

async function openAi(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.goto('/app/?workspace=1&view=activity');
  await page.getByRole('button', { name: /^Search or jump/ }).click();
  await page.keyboard.type('Settings: AI');
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'true');
  return settings;
}

async function choose(page: Page, scope: ReturnType<Page['getByRole']>, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label }).click();
  await page.getByRole('listbox').getByRole('option', { name: option, exact: true }).click();
}

test('Codex not signed in: its sign-in line, no controls; Claude stays on (the only one that can review)', async ({ page }) => {
  await setup(page, { codex: false });
  const settings = await openAi(page);
  const codex = settings.getByTestId('ai-profile-review-codex');
  await expect(codex).toContainText('Not downloaded.');
  await expect(codex.getByRole('combobox')).toHaveCount(0);
  const claude = settings.getByTestId('ai-profile-review-claude');
  await expect(claude.getByRole('checkbox', { name: 'Claude reviews' })).toBeDisabled();
  await expect(claude.getByRole('combobox', { name: 'Claude review model' })).toContainText('Claude Opus 5.5');
  // The old single Effort control is gone.
  await expect(settings.locator('#ai-effort')).toHaveCount(0);
});

test('a review change writes the review block only; the other blocks stay as stored', async ({ page }) => {
  const seen = await setup(page, { codex: true });
  const settings = await openAi(page);
  const claude = settings.getByTestId('ai-profile-review-claude');
  await choose(page, claude, 'Claude review effort', 'High');
  await expect.poll(() => seen.puts.length).toBe(1);
  expect(seen.puts[0]).toEqual({
    review: {
      claude: { enabled: true, model: 'claude-opus-5-5', effort: 'high' },
      codex: { enabled: true, model: 'gpt-6.1-sol', effort: null },
    },
  });
  // Switch Codex off: Claude is then the last one on, and its switch locks.
  await settings.getByRole('checkbox', { name: 'Codex reviews' }).click();
  await expect.poll(() => seen.puts.length).toBe(2);
  expect(seen.puts[1]!.review!.codex!.enabled).toBe(false);
  await expect(claude.getByRole('checkbox', { name: 'Claude reviews' })).toBeDisabled();
});

test('AI Fix and Implement story: vendor, model, effort and the review rounds', async ({ page }) => {
  const seen = await setup(page, { codex: true });
  const settings = await openAi(page);
  const fix = settings.getByTestId('ai-profile-fix');
  await choose(page, fix, 'AI Fix vendor', 'Codex');
  await expect.poll(() => seen.puts.length).toBe(1);
  // A new vendor opens on its usual model; the review block is not written.
  expect(seen.puts[0]).toEqual({ fix: { provider: 'codex', model: 'gpt-6.1-sol', effort: null } });
  const build = settings.getByTestId('ai-profile-build');
  await expect(build.getByRole('combobox', { name: 'Review rounds' })).toContainText('5');
  await choose(page, build, 'Review rounds', '3');
  await expect.poll(() => seen.puts.length).toBe(2);
  expect(seen.puts[1]).toEqual({
    fix: { provider: 'codex', model: 'gpt-6.1-sol', effort: null },
    build: { provider: 'claude', model: 'claude-opus-5-5', effort: null, rounds: 3 },
  });
});

test('AI Fix review rounds: written alone, so auto fix keeps its review\'s model', async ({ page }) => {
  const seen = await setup(page, { codex: true });
  const settings = await openAi(page);
  const fix = settings.getByTestId('ai-profile-fix');
  await expect(fix.getByRole('combobox', { name: 'AI Fix review rounds' })).toContainText('5');
  await choose(page, fix, 'AI Fix review rounds', '3');
  await expect.poll(() => seen.puts.length).toBe(1);
  // Rounds only: no vendor choice is stored, so nothing about auto fix's model changes.
  expect(seen.puts[0]).toEqual({ fix: { rounds: 3 } });
  await expect(fix.getByRole('combobox', { name: 'AI Fix review rounds' })).toContainText('3');
  // A later vendor change keeps the stored rounds.
  await choose(page, fix, 'AI Fix vendor', 'Codex');
  await expect.poll(() => seen.puts.length).toBe(2);
  expect(seen.puts[1]).toEqual({ fix: { provider: 'codex', model: 'gpt-6.1-sol', effort: null, rounds: 3 } });
});

test('REVIEW_EFFORT locks every effort control and says so', async ({ page }) => {
  await setup(page, { codex: true, envEffort: true });
  const settings = await openAi(page);
  for (const name of ['Claude review effort', 'Codex review effort', 'AI Fix effort', 'Implement story effort']) {
    await expect(settings.getByRole('combobox', { name })).toBeDisabled();
  }
  await expect(settings.getByText('Effort is set by REVIEW_EFFORT.')).toBeVisible();
});
