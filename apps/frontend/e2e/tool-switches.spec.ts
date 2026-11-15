import { test, expect, type Page } from '@playwright/test';
import { resolveToolSwitch, type MeResponse, type ToolSwitchesResponse } from '@pierre-review/shared';
import { installMockApi, ME_RESPONSE } from './mock-api.js';

// SETTINGS → FEATURES, AI AND BOT COMMENT ANALYSIS (components/settings/ToolsSection.tsx). The ONE place the
// app downloads either tool:
//   · a tool already downloaded says so, naming what is installed;
//   · switching ON a tool that is not downloaded ASKS first: Cancel leaves it off and downloads nothing,
//     Download stores the switch and starts the download;
//   · (each repo's Bot scoring switch lives in its panel: repo-panel.spec.ts)

const AI_FOUND = ['Claude Agent SDK 0.2.1', 'Claude Code: the copy that came with the download'];

async function setup(page: Page, botInstalled: boolean): Promise<{ puts: unknown[]; mlInstalls: number }> {
  const seen = { puts: [] as unknown[], mlInstalls: 0 };
  await installMockApi(page);
  const me: MeResponse = {
    ...ME_RESPONSE,
    mlSeverity: botInstalled,
    ml: { state: botInstalled ? 'ready' : 'absent', message: null },
    tools: {
      ai: resolveToolSwitch(null, true, AI_FOUND),
      botAnalysis: resolveToolSwitch(
        null,
        botInstalled,
        botInstalled ? ['ModernBERT category model (int8 ONNX), version 2026.11', 'ModernBERT severity model (int8 ONNX), version 2026.11'] : [],
      ),
    },
  };
  await page.route('**/api/me', (route) => route.fulfill({ json: me }));
  await page.route('**/api/me/tool-switches', (route) => {
    const body = route.request().postDataJSON() as { id: 'ai' | 'botAnalysis'; on: boolean | null };
    seen.puts.push(body);
    const tools = { ...me.tools! };
    tools[body.id] = resolveToolSwitch(body.on, tools[body.id].installed, tools[body.id].found);
    return route.fulfill({ json: { status: 'ok', toolSwitches: { [body.id]: body.on }, tools } satisfies ToolSwitchesResponse });
  });
  await page.route('**/api/ml/install', (route) => {
    seen.mlInstalls += 1;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n\n' });
  });
  return seen;
}

async function openFeatures(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.goto('/app/?workspace=1&view=activity');
  // ⌘K → "Settings: Features".
  await page.getByRole('button', { name: /^Search or jump/ }).click();
  await page.keyboard.type('Settings: Features');
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('tab', { name: 'Features', exact: true })).toHaveAttribute('aria-selected', 'true');
  return settings;
}

test('switching on a tool that is not downloaded asks first; Cancel and Escape download nothing', async ({ page }) => {
  const seen = await setup(page, false);
  const settings = await openFeatures(page);
  // AI is dark in these fixtures (ai.enabled false), so only bot comment analysis is offered.
  const bot = settings.getByTestId('tool-switch-botAnalysis');
  await expect(bot).not.toBeChecked();

  // Cancel: nothing stored, nothing downloaded, the switch stays off.
  await bot.click({ force: true });
  const ask = page.getByRole('dialog', { name: 'Download the bot comment model?' });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('About 240 MB');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(settings).toBeVisible();

  // Escape closes the question only: Settings stays open (lib/escapeOwner.ts).
  await bot.click({ force: true });
  await expect(ask).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(bot).not.toBeChecked();
  expect(seen.puts).toEqual([]);
  expect(seen.mlInstalls).toBe(0);

  // Download: the switch is stored ON and the download starts.
  await bot.click({ force: true });
  await page.getByTestId('tool-download-botAnalysis').click();
  await expect.poll(() => seen.mlInstalls).toBe(1);
  expect(seen.puts).toEqual([{ id: 'botAnalysis', on: true }]);
});

test('an installed model is named, and switching it off asks nothing', async ({ page }) => {
  const seen = await setup(page, true);
  const settings = await openFeatures(page);
  const bot = settings.getByTestId('tool-switch-botAnalysis');
  await expect(bot).toBeChecked();
  await expect(settings.getByRole('list', { name: 'Installed' })).toContainText('ModernBERT severity model (int8 ONNX)');

  // Off asks nothing (nothing is lost) and stores false.
  await bot.click({ force: true });
  await expect(page.getByRole('dialog', { name: /Download/ })).toHaveCount(0);
  await expect.poll(() => seen.puts).toEqual([{ id: 'botAnalysis', on: false }]);
});
