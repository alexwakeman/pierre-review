import { test, expect, type Page } from '@playwright/test';
import type { ReferenceDocSectionResponse } from '@pierre-review/shared';
import { fixtures, installMockApi } from './mock-api.js';

// Activity → Docs: a deep link carrying `quote=` (a review reference, a story-docs point, a chat
// citation) highlights the passage in the section and says so on ONE strip; a quote that is no
// longer in the section says that instead. The highlight is the CSS Custom Highlight API, so the
// check reads `CSS.highlights` — the DOM React owns is never changed.

const SECTION: ReferenceDocSectionResponse = {
  workspaceId: 1,
  path: 'billing-handbook/sections/04-refunds.md',
  docId: 1,
  docSlug: 'billing-handbook',
  docTitle: 'Billing handbook',
  title: 'Refunds',
  markdown: [
    '<!-- limn reference section 4 of 9 -->',
    '# Refunds',
    '',
    '> **[Billing handbook](../CONTENTS.md)** › Payments',
    '> [Previous](03-payments.md) · [Contents](../CONTENTS.md)',
    '',
    '## Refunds',
    '',
    'Refunds are paid **within fourteen days** of the request being approved.',
    '',
    '| Priority | Weight |',
    '| --- | --- |',
    '| High (Formally identified in local strategy) | 1.15 |',
    '',
  ].join('\n'),
  prev: 'billing-handbook/sections/03-payments.md',
  next: null,
};

async function open(page: Page, quote: string): Promise<void> {
  await installMockApi(page);
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route(
    (u) => u.pathname.endsWith('/api/me'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  await page.route(
    (u) => u.pathname.endsWith('/api/docs/section'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...SECTION, workspaceId: fixtures.WORKSPACE.id }) }),
  );
  const q = new URLSearchParams({
    view: 'activity',
    workspace: String(fixtures.WORKSPACE.id),
    activityRepo: 'docs',
    doc: 'billing-handbook',
    section: '04-refunds.md',
    quote,
  });
  await page.goto(`/app/?${q.toString()}`);
  await expect(page.getByTestId('docs-viewer')).toContainText('within fourteen days');
}

const highlighted = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights;
    const h = reg?.get('doc-quote');
    if (h == null) return null;
    return [...h].map((r) => r.toString()).join(' / ');
  });

test.describe('Docs quote highlight', () => {
  test('a table-row quote is highlighted across its cells, and the strip clears it', async ({ page }) => {
    await open(page, 'High (Formally identified in local strategy) | 1.15');
    const strip = page.getByTestId('docs-quote-strip');
    await expect(strip).toHaveText('The quoted passage is highlighted.');
    await expect.poll(() => highlighted(page)).toContain('High (Formally identified in local strategy)');
    expect(await highlighted(page)).toContain('1.15');
    await strip.getByRole('button', { name: 'Clear the highlight' }).click();
    await expect(strip).toHaveCount(0);
    expect(await highlighted(page)).toBeNull();
  });

  test('emphasis in the quote still matches, never in the header', async ({ page }) => {
    await open(page, 'paid **within fourteen days** of the request');
    await expect.poll(() => highlighted(page)).toBe('paid within fourteen days of the request');
  });

  test('words no longer in the section say so', async ({ page }) => {
    await open(page, 'Refunds are paid within thirty working days');
    await expect(page.getByTestId('docs-quote-strip')).toHaveText('The quoted words are no longer in this section.');
    expect(await highlighted(page)).toBeNull();
  });
});
