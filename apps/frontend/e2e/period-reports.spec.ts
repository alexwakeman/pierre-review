import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi } from './mock-api.js';
import { PERIOD_METRIC_KEYS, type PeriodMetricKey, type PeriodSeriesPoint, type PeriodSeriesResponse } from '@pierre-review/shared';

// REPORTS → PERIOD REPORTS, the chart (docs/FRONTEND.md § Period reports). CODE ONLY: one read
// (`/api/pro/insights/period-series`), no Generate and no write-up. Change is the default reading,
// Merged PRs the default metric; a metric with no usable baseline is named, not drawn; Values puts
// one unit per chart; a band's popover shows its figures, and selecting a band moves Effort vs
// automation to that period.

const DAY = 86_400_000;
const START = Date.parse('2026-08-03T00:00:00Z');
const VALUES: Partial<Record<PeriodMetricKey, (number | null)[]>> = {
  merged_prs: [20, 22, 25, 24, 30, 33],
  bot_review_comments: [400, 420, 500, 480, 600, 640],
  reviewer_concentration_pct: [null, null, null, null, null, null],
};

function point(i: number): PeriodSeriesPoint {
  const from = START + i * 14 * DAY;
  return {
    periodKey: `sprint-${new Date(from).toISOString().slice(0, 10)}`,
    periodStart: new Date(from).toISOString(),
    periodEnd: new Date(from + 14 * DAY).toISOString(),
    cadenceDays: 14,
    metrics: PERIOD_METRIC_KEYS.map((key) => {
      const v = VALUES[key]?.[i] ?? null;
      return { key, value: v, sampleSize: v ?? 0 };
    }),
    deltas:
      i === 0
        ? []
        : (['merged_prs'] as const).map((key) => {
            const value = VALUES[key]![i]!;
            const prior = VALUES[key]![i - 1]!;
            return { key, value, prior, absoluteChange: value - prior, percentChange: Math.round(((value - prior) / prior) * 1000) / 10, significant: i === 4, direction: 'up_good' as const };
          }),
    lanes: {
      lanes: [{ lane: 'human', mergedPrs: 10 + i, openedPrs: 12, medianPrSizeLines: 120, medianLeadTimeHours: 20, comments: 30, approvals: 8 }],
      automationMergeSharePct: 10 + i,
      medianTimeToFirstHumanReviewHours: 4,
      silentAutomation: [],
    },
  };
}

const SERIES: PeriodSeriesResponse = {
  enabled: true,
  workspaceId: fixtures.WORKSPACE.id,
  grain: 'sprint',
  cadenceConfigured: true,
  cadenceDays: 14,
  periods: [0, 1, 2, 3, 4, 5].map(point),
  repos: { measured: 3, total: 4 },
  next: { periodKey: 'sprint-2026-10-26', periodStart: new Date(START + 84 * DAY).toISOString(), periodEnd: new Date(START + 98 * DAY).toISOString() },
  forecasts: PERIOD_METRIC_KEYS.map((key) =>
    key === 'merged_prs'
      ? { available: true as const, key, point: 36, low: 31, high: 41, basis: 'Theil–Sen', periodsUsed: 6 }
      : { available: false as const, key, reason: 'insufficient_history' as const },
  ),
  forecastDisclosure: 'fitted on 6 periods',
};

async function open(page: Page): Promise<string[]> {
  await installMockApi(page);
  const calls: string[] = [];
  await page.route(
    (u) => u.pathname.startsWith('/api/pro/insights/'),
    (r) => {
      const path = new URL(r.request().url()).pathname;
      calls.push(`${r.request().method()} ${path}`);
      if (path === '/api/pro/insights/period-series') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SERIES) });
      return r.fallback();
    },
  );
  await page.goto('/app/?activityRepo=insights');
  await expect(page.getByTestId('period-reports')).toBeVisible();
  return calls;
}

test.describe('Period reports', () => {
  test('one chart of every period, Change by default, Merged PRs on, no AI anywhere', async ({ page }) => {
    const calls = await open(page);
    const panel = page.getByTestId('period-reports');
    await expect(panel.getByRole('button', { name: 'Change' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('[data-metric="merged_prs"]')).toHaveAttribute('aria-pressed', 'true');
    // Six period bands plus the projected one.
    await expect(panel.getByTestId('period-chart-band')).toHaveCount(7);
    await expect(panel.getByTestId('period-series-repos')).toHaveText('3 of 4 repos: the ones tracked across every period. Projection fitted on 6 periods.');
    // No period picker, no Generate, no write-up.
    await expect(panel.getByRole('button', { name: /Generate/ })).toHaveCount(0);
    await expect(panel).not.toContainText('write-up');
    expect(calls.every((c) => c === 'GET /api/pro/insights/period-series')).toBe(true);
  });

  test('a band’s popover shows its figures; selecting a band moves Effort vs automation', async ({ page }) => {
    await open(page);
    const panel = page.getByTestId('period-reports');
    const bands = panel.getByTestId('period-chart-band');
    await bands.nth(4).hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('30');
    // Significant: a percentage. Change since the baseline (the first period, 20 → 30).
    await expect(tip).toContainText('+25% vs the period before');
    await expect(tip).toContainText('+50% since');
    // The projection band.
    await bands.nth(6).hover();
    await expect(page.getByRole('tooltip')).toContainText('36 projected · 31–41');
    // Selecting the second period: the lanes follow it.
    await bands.nth(1).click();
    await expect(panel.getByTestId('period-lanes')).toContainText('11% of merges were automated');
  });

  test('a metric with no baseline is named, and Values puts one unit per chart', async ({ page }) => {
    await open(page);
    const panel = page.getByTestId('period-reports');
    await panel.locator('[data-metric="bot_review_comments"]').click();
    await panel.locator('[data-metric="reviewer_concentration_pct"]').click();
    await expect(panel.getByTestId('period-no-baseline')).toContainText('No baseline for Reviewer concentration');
    await panel.getByRole('button', { name: 'Values' }).click();
    await expect(panel.getByTestId('period-chart-count')).toBeVisible();
    await expect(panel.getByTestId('period-chart-pct')).toBeVisible();
    // The last metric cannot be switched off.
    await panel.getByRole('button', { name: 'Change' }).click();
    await panel.locator('[data-metric="bot_review_comments"]').click();
    await panel.locator('[data-metric="reviewer_concentration_pct"]').click();
    await panel.locator('[data-metric="merged_prs"]').click();
    await expect(panel.locator('[data-metric="merged_prs"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

