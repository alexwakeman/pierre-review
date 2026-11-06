import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// Keyboard-only paths through Pending → Settings. Each defect here was invisible to a mouse: the
// click that opens a modal is an outside press (so a popover closes itself), and a pointer does not
// care where focus lands.
//   • Settings opened with Enter on "Customise" closes the board popover that was open — it used to
//     stay drawn ABOVE the modal and take its first Escape (lib/activePopover.ts)
//   • closing Settings hands focus back to "Customise", not to <body>
//   • the one My Turn switch is a real checkbox that saves on Space

async function gotoPending(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/app/?view=activity&activityRepo=attention');
  await expect(page.getByTestId('attention-view')).toBeVisible();
}

const settings = (p: Page) => p.getByRole('dialog', { name: 'Settings' });

test.describe('Pending → Settings from the keyboard', () => {
  test('Customise closes the open popover, one Escape closes Settings, focus comes back', async ({
    page,
  }) => {
    await gotoPending(page);
    await page.getByRole('button', { name: 'How Pending is ordered' }).focus();
    await page.keyboard.press('Enter');
    const popover = page.getByRole('dialog', { name: 'How Pending is ordered' });
    await expect(popover).toBeVisible();

    const customise = page.getByRole('button', { name: 'Customise' });
    await customise.focus();
    await page.keyboard.press('Enter');
    await expect(settings(page)).toBeVisible();
    await expect(popover).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(settings(page)).toHaveCount(0);
    await expect(customise).toBeFocused();
  });

  test('Customise opens Settings on the Pending tab; arrow keys move between tabs', async ({ page }) => {
    await gotoPending(page);
    await page.getByRole('button', { name: 'Customise' }).click();
    const pendingTab = settings(page).getByRole('tab', { name: 'Pending', exact: true });
    await expect(pendingTab).toHaveAttribute('aria-selected', 'true');
    const survey = settings(page).getByRole('checkbox', { name: /Also show new PRs nobody asked you about/ });
    await expect(survey).toBeVisible();

    await pendingTab.focus();
    await page.keyboard.press('ArrowUp');
    const prTab = settings(page).getByRole('tab', { name: 'Pull requests', exact: true });
    await expect(prTab).toHaveAttribute('aria-selected', 'true');
    await expect(prTab).toBeFocused();
    await expect(survey).toBeHidden();
  });

  test('the My Turn switch is one checkbox, off by default, and Space saves it', async ({ page }) => {
    await gotoPending(page);
    let sent: unknown = null;
    await page.route('**/api/me/my-turn-settings', async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { status: 'ok', myTurnSettings: { showNewPrs: true } } });
    });
    await page.getByRole('button', { name: 'Customise' }).click();
    const survey = settings(page).getByRole('checkbox', { name: /Also show new PRs nobody asked you about/ });
    await expect(survey).not.toBeChecked();
    // The sliders and presets are gone.
    await expect(settings(page).getByRole('radiogroup', { name: 'Ranking preset' })).toHaveCount(0);
    await survey.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => sent).toEqual({ settings: { showNewPrs: true } });
  });
});
