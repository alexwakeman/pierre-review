import { test, expect } from '@playwright/test';
import type { AiReviewCard, AttentionCardsResponse } from '@pierre-review/shared';
import { fixtures, installMockApi } from './mock-api.js';

// Pending → "AI reviews": the SEEN BLOCKS (lib/aiReviewsLedger.ts; docs/FRONTEND.md § The AI
// reviews list). With a stamp from an hour ago and this browser's ledger holding two earlier visits:
//   • the review newer than the stamp is under New (its tag), on top;
//   • then one block per earlier visit, newest first, with its "Seen …" heading;
//   • then the review with no ledger entry, under no heading;
//   • the new row is written to the ledger at this visit's start.
// Screenshot: SHOTS_DIR (default /tmp/limn-pending-shots).

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/limn-pending-shots';
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

const card = (reviewId: number, atMs: number, title: string): AiReviewCard => ({
  id: `ai_review:${reviewId}`,
  kind: 'ai_review',
  severity: 'info',
  reviewId,
  prId: reviewId + 100,
  repoId: fixtures.REPO.id,
  repoFullName: fixtures.REPO.fullName,
  prNumber: reviewId,
  prTitle: title,
  githubUrl: `https://github.com/${fixtures.REPO.fullName}/pull/${reviewId}`,
  ranByUserId: null,
  auto: true,
  verdict: 'COMMENT',
  findingCount: 1,
  at: iso(atMs),
});

const CARDS = [
  card(904, NOW - 10 * 60_000, 'New since the last look'),
  card(903, NOW - 3 * HOUR, 'Seen this morning'),
  card(902, NOW - 30 * HOUR, 'Seen yesterday'),
  card(901, NOW - 50 * HOUR, 'Never recorded'),
];
const MORNING = NOW - 2 * HOUR;
const YESTERDAY = NOW - 26 * HOUR;

function attention(): AttentionCardsResponse {
  const base = fixtures.ATTENTION;
  const ids = CARDS.map((c) => c.id);
  return {
    ...base,
    cards: [...base.cards.filter((c) => c.kind !== 'ai_review'), ...CARDS],
    tabs: (base.tabs ?? []).map((t) => (t.key === 'claude' ? { ...t, total: CARDS.length, cardIds: ids, newTotal: 1, kindTotals: { ai_review: CARDS.length } } : t)),
    aiReviewsSeenAt: iso(NOW - HOUR),
  };
}

test('AI reviews: New on top, one block per earlier visit, then the unrecorded rest', async ({ page }) => {
  await page.addInitScript(
    ([ledger]) => {
      if (window.sessionStorage.getItem('seeded') == null) {
        window.localStorage.setItem('pierre:aiReviewsSeen:v1', ledger!);
        window.sessionStorage.setItem('seeded', '1');
      }
    },
    [JSON.stringify({ v: 1, seen: { '903': [MORNING, 1003], '902': [YESTERDAY, 1002] } })],
  );
  await installMockApi(page);
  await page.route(
    (u) => u.pathname === '/api/attention',
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(attention()) }),
  );
  await page.goto('/app/?view=activity&activityRepo=attention&attnTab=claude', { waitUntil: 'domcontentloaded' });
  const list = page.getByTestId('pending-ai-reviews');
  await expect(list).toBeVisible({ timeout: 30_000 });

  const blocks = list.locator('[data-testid^="pending-ai-block-"]');
  await expect(blocks).toHaveCount(4);
  await expect(blocks.nth(0)).toHaveAttribute('data-testid', 'pending-ai-block-new');
  await expect(blocks.nth(0)).toContainText('New since the last look');
  await expect(blocks.nth(1)).toContainText('Seen this morning');
  await expect(blocks.nth(1).getByTestId('pending-ai-seen-label')).toHaveText(/^Seen (today|yesterday) \d\d:\d\d$/);
  await expect(blocks.nth(2)).toContainText('Seen yesterday');
  await expect(blocks.nth(2).getByTestId('pending-ai-seen-label')).toHaveText(/^Seen (yesterday|\w{3} \d{1,2} \w{3}) \d\d:\d\d$/);
  await expect(blocks.nth(3)).toHaveAttribute('data-testid', 'pending-ai-block-rest');
  await expect(blocks.nth(3)).toContainText('Never recorded');
  await expect(blocks.nth(3).getByTestId('pending-ai-seen-label')).toHaveCount(0);

  // This visit recorded the new review, at the visit's start (after the page loaded).
  await expect
    .poll(async () => page.evaluate(() => JSON.parse(window.localStorage.getItem('pierre:aiReviewsSeen:v1') ?? '{}').seen?.['904']?.[1] ?? null))
    .toBe(1004);
  await list.screenshot({ path: `${SHOTS}/ai-reviews-seen-blocks.png` });
});
