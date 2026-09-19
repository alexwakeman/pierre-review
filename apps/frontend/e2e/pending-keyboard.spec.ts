import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from './mock-api.js';

// Keyboard-only paths through Pending → Settings. Each defect here was invisible to a mouse: the
// click that opens a modal is an outside press (so a popover closes itself), and a pointer does not
// care where focus lands.
//   • Settings opened with Enter on "Customise" closes the board popover that was open — it used to
//     stay drawn ABOVE the modal and take its first Escape (lib/activePopover.ts)
//   • closing Settings hands focus back to "Customise", not to <body>
//   • "Ranking preset" is a real radio group: one Tab stop, arrows move AND apply a preset

async function gotoPending(page: Page): Promise<void> {
  await installMockApi(page);
  await page.goto('/app/');
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

  test('the ranking preset is one Tab stop, and an arrow key applies the next preset', async ({
    page,
  }) => {
    await gotoPending(page);
    await page.getByRole('button', { name: 'Customise' }).click();
    const group = settings(page).getByRole('radiogroup', { name: 'Ranking preset' });
    const radios = group.getByRole('radio');
    await expect(radios).toHaveCount(4);
    await expect(group.getByRole('radio', { name: 'Balanced' })).toBeChecked();

    await group.getByRole('radio', { name: 'Balanced' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { name: 'Mine first' })).toBeChecked();
    await expect(group.getByRole('radio', { name: 'Mine first' })).toBeFocused();
    await expect(settings(page).locator('#my-turn-weight-relevance')).toHaveValue('60');

    // One Tab stop: the next Tab leaves the group for the first weight slider.
    await page.keyboard.press('Tab');
    await expect(settings(page).locator('#my-turn-weight-proximity')).toBeFocused();
  });
});
