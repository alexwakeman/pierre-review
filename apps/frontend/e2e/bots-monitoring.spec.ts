import { test, expect, type Page } from '@playwright/test';
import type {
  BotAnalyticsResponse,
  BotBehaviourBotStat,
  BotBehaviourResponse,
  BotBehaviourTrendPoint,
  BotVendorAnalytics,
  BotVolumeResponse,
  MeResponse,
} from '@pierre-review/shared';
import { installMockApi, ME_RESPONSE } from './mock-api.js';

// Bots Monitoring → ROI, at a density with real weekly history:
//   • the "Only a bot reviewed …" caution and the "bot-only open PRs" link are gone;
//   • no "Quality checks — excluded from ROI" section;
//   • the Inflation column and the Severity inflation chart hide when every bot is Ensemble's own;
//   • "Time to first review" is a log axis with named ticks; a zero median does not break it;
//   • "Follow-up rate"'s top tick ("100%") is drawn whole inside its chart.
// Screenshots: SHOTS_DIR (default /tmp/limn-bots-shots).

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/limn-bots-shots';
const URL = '/app/?view=activity&activityRepo=bots';

const WEEKS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 7, 31 + i * 7)).toISOString());
const iso = (d: number): string => new Date(Date.UTC(2026, 10, 20) - d * 86_400_000).toISOString();

function vendor(o: Partial<BotVendorAnalytics> & Pick<BotVendorAnalytics, 'key' | 'kind' | 'label' | 'login'>): BotVendorAnalytics {
  return {
    reviewers: 1,
    threads: 40,
    comments: 60,
    actedOn: 24,
    actedOnPct: 60,
    untouched: 10,
    medianAddressedMs: 3_600_000 * 5,
    humanFollowThroughPct: 40,
    noiseRatioPct: 25,
    mergedPastPrs: 1,
    mergedPastThreads: 2,
    overlapThreads: 0,
    overlapPct: 0,
    topOverlapPartner: null,
    mlFindings: 30,
    mlBySeverity: { nit: 10, minor: 10, major: 8, critical: 2 },
    verdict: 'keep',
    costMonthlyUsd: null,
    costPerActedOnUsd: null,
    costModel: 'flat',
    costSeatCount: 0,
    costUnitMonthlyUsd: null,
    dormant: false,
    lastActiveAt: iso(1),
    trend: WEEKS.map((w, i) => ({ weekStart: w, threads: 2 + (i % 4), actedOnPct: 50, untouched: 1 })),
    ...o,
  };
}

const CODERABBIT = vendor({
  key: 'u10',
  kind: 'coderabbit',
  label: 'CodeRabbit',
  login: 'coderabbitai[bot]',
  mlInflation: {
    badged: 20,
    overCall: 6,
    underCall: 2,
    weekly: WEEKS.map((w, i) => ({ weekStartMs: Date.parse(w), overCall: i % 3, underCall: i % 2 })),
  },
});
const ENSEMBLE = vendor({ key: 'u11', kind: 'pierre', label: 'Ensemble · alice', login: 'limn:alice' });

function analytics(vendors: BotVendorAnalytics[]): BotAnalyticsResponse {
  return {
    enabled: true,
    generatedAt: iso(0),
    window: { kind: 'rolling_14', from: iso(14), to: iso(0) },
    vendors,
    totals: { threads: 80, comments: 120, actedOn: 48, actedOnPct: 60, untouched: 20, botOnlyPrs: 3, overdueGraceMs: 36 * 3_600_000, overlapClusters: 0 },
    ml: {
      labelled: 60,
      findings: 60,
      summaries: 0,
      praise: 0,
      pending: 0,
      unscorable: 0,
      bySeverity: { nit: 20, minor: 20, major: 16, critical: 4 },
      byCategory: [],
      backends: ['onnx'],
      truncated: false,
    },
    suggestions: [],
  } as BotAnalyticsResponse;
}

function point(weekStart: string, ttfr: number | null, followup: number | null): BotBehaviourTrendPoint {
  return {
    weekStart,
    medianTtfrHours: ttfr,
    volume: 5,
    followupRatePct: followup,
    ttfrAnomaly: false,
    volumeAnomaly: false,
    followupAnomaly: false,
    findingsPerPr: null,
    findingsPerKloc: null,
    prsInWeek: 3,
    densityAnomaly: false,
  };
}

function behaviourBot(key: string, label: string, login: string, kind: BotBehaviourBotStat['kind'], ttfr: (number | null)[], followup: (number | null)[]): BotBehaviourBotStat {
  return {
    key,
    userId: Number(key.slice(1)),
    login,
    kind,
    label,
    prsReviewed: 12,
    ttfrMedianHours: 0.2,
    ttfrP90Hours: 2,
    ttfrBaseline: 'ready',
    ttfrDist: [],
    trend: WEEKS.map((w, i) => point(w, ttfr[i] ?? null, followup[i] ?? null)),
    followupLatencyMedianHours: null,
    medianLocPerComment: null,
    totalComments: 60,
    activityHeatmap: Array(168).fill(0),
    totalActivity: 0,
    dailyActivity: [],
    daySpanStart: iso(84),
    silentRuns: [],
    anomalies: [],
    followupRatePct: 60,
    avgFollowups: 1.2,
    followupDist: [],
  } satisfies BotBehaviourBotStat;
}

const BEHAVIOUR: BotBehaviourResponse = {
  enabled: true,
  generatedAt: iso(0),
  window: { kind: 'rolling_14', from: iso(14), to: iso(0) },
  bots: [
    // Minutes, with a ZERO median and a gap: must not break the log axis.
    behaviourBot('u10', 'CodeRabbit', 'coderabbitai[bot]', 'coderabbit', [0.05, 0, 0.1, null, 0.08, 0.2, 0.12, 0.05, 0.3, 0.1, 0.07, 0.04], [100, 80, 100, 90, null, 100, 70, 100, 100, 85, 100, 100]),
    // Hours to days.
    behaviourBot('u11', 'Ensemble · alice', 'limn:alice', 'pierre', [2, 5, 30, 12, null, 48, 3, 8, 20, 6, 4, 10], [20, 40, 30, null, 50, 10, 25, 30, 45, 20, 35, 40]),
  ],
  workspace: { prs: 24, ttfrMedianHours: 0.2, ttfrP90Hours: 12, ttfrBaseline: 'ready', followupRatePct: 70, avgFollowups: 1.5, trend: [] },
  overlap: { reviewedPrs: 0, multiReviewedPrs: 0, distribution: [], pairs: [], lineOverlapClusters: 0, lineOverlapPrs: 0 },
  repoBotDirs: [],
  prsOpenedPerDay: [],
  daySpanStart: iso(84),
};

const VOLUME: BotVolumeResponse = {
  workspaceId: 1,
  window: { kind: 'rolling_14', from: iso(14), to: iso(0) },
  bots: [],
  totals: { prs: 10, sizedPrs: 10, comments: 0, prsWithBotComments: 0, prsWithNoBotComments: 10, avgCommentsPerCommentedPr: null } as BotVolumeResponse['totals'],
  truncated: false,
  generatedAt: iso(0),
};

async function openBots(page: Page, vendors: BotVendorAnalytics[]): Promise<void> {
  await installMockApi(page);
  // Registered after the mock, so these answer first.
  const fulfil = (body: unknown) => (r: { fulfill: (o: { status: number; contentType: string; body: string }) => Promise<void> }) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route((u) => u.pathname === '/api/me', fulfil({ ...ME_RESPONSE, mlSeverity: true } satisfies MeResponse));
  await page.route((u) => u.pathname === '/api/bot-analytics', fulfil(analytics(vendors)));
  await page.route((u) => u.pathname === '/api/bot-analytics/volume', fulfil(VOLUME));
  await page.route((u) => u.pathname === '/api/pro/bot-behaviour', fulfil(BEHAVIOUR));
  // The mock's generic `/api/pro/*` stub has no `bots` block; the panel reads `bots.cost` (the
  // deprecated per-login price list), so it needs this much of the real shape.
  await page.route((u) => u.pathname === '/api/pro/settings', fulfil({ bots: { cost: [] } }));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('bot-roi-table')).toBeVisible({ timeout: 30_000 });
}

const card = (page: Page, title: string) =>
  page.locator('div.min-w-0.rounded-ui.bg-ui-surface').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();

/** Every label of the card's chart lies wholly inside its SVG; returns the y-axis labels. */
async function expectAxisLabelsInside(page: Page, title: string): Promise<string[]> {
  // The chart's own SVG (an icon is an <svg> too).
  const svg = card(page, title).locator('svg.block').first();
  await expect(svg).toBeVisible();
  return svg.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const out: string[] = [];
    const yLabelRects: DOMRect[] = [];
    for (const t of Array.from(el.querySelectorAll('text'))) {
      const r = t.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.top < box.top - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5)
        throw new Error(`label "${t.textContent}" is cut: ${JSON.stringify(r)} outside ${JSON.stringify(box)}`);
      // The y-axis labels are the ones centred on their gridline; the two x labels sit on a baseline.
      if (t.getAttribute('dominant-baseline') !== 'middle') continue;
      // …and no two of them overlap.
      for (const o of yLabelRects)
        if (r.top < o.bottom - 0.5 && o.top < r.bottom - 0.5) throw new Error(`label "${t.textContent}" overlaps another`);
      yLabelRects.push(r);
      out.push(t.textContent ?? '');
    }
    return out;
  });
}

test.describe('Bots Monitoring', () => {
  test.use({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 1 });

  test('with another review bot: Inflation shows; no bot-only caution or quality checks', async ({ page }) => {
    await openBots(page, [CODERABBIT, ENSEMBLE]);
    await expect(page.getByTestId('bot-only-caption')).toHaveCount(0);
    await expect(page.getByText(/bot-only open PR/)).toHaveCount(0);
    await expect(page.getByText('Quality checks', { exact: false })).toHaveCount(0);
    const table = page.getByTestId('bot-roi-table');
    await expect(table.getByRole('columnheader', { name: 'Inflation' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Severity inflation' })).toBeVisible();
    // Header and cells stay aligned: every row has as many cells as the header has columns.
    const heads = await table.locator('thead th').count();
    for (const n of await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.children.length)))
      expect(n).toBe(heads);

    const ttfr = await expectAxisLabelsInside(page, 'Time to first review');
    // A log axis of named ticks from 1m (where the zero median is drawn) to 3d (above the 2-day
    // peak); a tick too close to its neighbour is dropped, so only the ends are fixed.
    expect(ttfr[0]).toBe('1m');
    expect(ttfr.at(-1)).toBe('3d');
    for (const l of ttfr) expect(['1m', '10m', '1h', '6h', '1d', '3d']).toContain(l);
    const follow = await expectAxisLabelsInside(page, 'Follow-up rate');
    expect(follow).toContain('100%');

    await page.mouse.move(0, 0);
    await page.locator('[data-testid="bot-roi-panel"]').screenshot({ path: `${SHOTS}/bots-roi-with-coderabbit.png` });
    await card(page, 'Time to first review').screenshot({ path: `${SHOTS}/bots-ttfr-log.png` });
    await card(page, 'Follow-up rate').screenshot({ path: `${SHOTS}/bots-followup.png` });
  });

  test('only Ensemble’s own bot: no Inflation column, no Severity inflation chart', async ({ page }) => {
    await openBots(page, [ENSEMBLE]);
    const table = page.getByTestId('bot-roi-table');
    await expect(table.getByRole('columnheader', { name: 'Severity mix' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Inflation' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Severity inflation' })).toHaveCount(0);
    const heads = await table.locator('thead th').count();
    for (const n of await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.children.length)))
      expect(n).toBe(heads);
    await page.mouse.move(0, 0);
    await page.locator('[data-testid="bot-roi-panel"]').screenshot({ path: `${SHOTS}/bots-roi-ensemble-only.png` });
  });

  test('the ⌘K list has no bot-only command', async ({ page }) => {
    await openBots(page, [CODERABBIT]);
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('Bots:');
    await expect(page.getByText('Bots: review & resolve likely-addressed threads')).toBeVisible();
    await expect(page.getByText('Bots: open PRs only a bot reviewed')).toHaveCount(0);
  });
});
