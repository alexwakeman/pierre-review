import {
  AI_ADOPTION_REPORT_SCHEMA_VERSION,
  adoptionFigure,
  withheldFigure,
  type AdoptionComparison,
  type AdoptionComparisonKey,
  type AdoptionFigure,
  type AdoptionPeriod,
  type AdoptionReportUnit,
  type AiAdoptionReport,
} from '@pierre-review/shared';

// A whole AiAdoptionReport for the deck tests (deckModel, renderDeckPdf). Not a test file:
// `vitest.config.ts` collects `*.test.ts` only.

const DAY = 86_400_000;
const AFTER_FROM = Date.parse('2026-11-09T00:00:00Z');
const AFTER_TO = Date.parse('2026-11-23T00:00:00Z');
const iso = (t: number): string => new Date(t).toISOString();

export function cmp(key: AdoptionComparisonKey, unit: AdoptionReportUnit, before: number | null, after: number | null, significant = true, n = 40): AdoptionComparison {
  const f = (v: number | null): AdoptionFigure => (v == null ? withheldFigure(unit, 'low_sample', 2) : adoptionFigure(v, unit, n));
  return { key, before: f(before), after: f(after), direction: 'up_good', significant };
}

function period(i: number, share: number | null, merged: number): AdoptionPeriod {
  const from = AFTER_FROM - (5 - i) * 14 * DAY;
  const ai = share == null ? 0 : Math.round((share / 100) * merged);
  return {
    from: iso(from),
    to: iso(from + 14 * DAY),
    partial: i === 5,
    mergedPrs: merged,
    aiPrs: ai,
    share: share == null ? withheldFigure('pct', 'detection_incomplete', merged) : adoptionFigure(share, 'pct', merged),
    byVendor: share == null ? {} : { claude: Math.ceil(ai * 0.6), copilot: Math.floor(ai * 0.4) },
    scannedPct: share == null ? 40 : 100,
  };
}

export function makeReport(over: Partial<AiAdoptionReport> = {}): AiAdoptionReport {
  const peoplePeriods = [null, 40, 50, 55, 60, 67].map((share, i) => {
    const p = period(i, share == null ? null : 1, 10);
    return {
      from: p.from,
      to: p.to,
      partial: p.partial,
      people: 15,
      usingAi: share == null ? withheldFigure('count', 'detection_incomplete', 15) : adoptionFigure(Math.round((share / 100) * 15), 'count', 15),
      share: share == null ? withheldFigure('pct', 'detection_incomplete', 15) : adoptionFigure(share, 'pct', 15),
    };
  });
  const base: AiAdoptionReport = {
    schemaVersion: AI_ADOPTION_REPORT_SCHEMA_VERSION,
    workspaceId: 1,
    workspaceName: 'Acme Platform',
    generatedAt: iso(AFTER_TO),
    window: { mode: 'rolling_14', from: iso(AFTER_FROM), to: iso(AFTER_TO), end: iso(AFTER_TO), days: 14, elapsedDays: 14 },
    after: { from: iso(AFTER_FROM), to: iso(AFTER_TO), days: 14 },
    before: { from: iso(AFTER_FROM - 14 * DAY), to: iso(AFTER_FROM), days: 14 },
    repos: { measured: 3, total: 4 },
    detection: { scannedPrs: 96, totalPrs: 100, scannedPct: 96, complete: true, detectorVersion: 1, coversFrom: iso(AFTER_FROM - 90 * DAY) },
    markers: [{ at: iso(AFTER_FROM - 10 * DAY), kind: 'auto_review', summary: 'Auto review switched on' }],
    settingHistoryFrom: iso(AFTER_FROM - 60 * DAY),
    summary: {
      headlines: [cmp('ai_share', 'pct', 20, 34), cmp('lead_time', 'hours', 30, 22), cmp('human_review_coverage', 'pct', 90, 88, false)],
      significantCount: 2,
    },
    adoption: {
      periods: [period(0, null, 30), period(1, 12, 32), period(2, 18, 35), period(3, 20, 31), period(4, 20, 40), period(5, 34, 44)],
      aiShare: cmp('ai_share', 'pct', 20, 34),
      vendors: [
        { vendor: 'claude', before: adoptionFigure(5, 'count', 40), after: adoptionFigure(9, 'count', 44), afterShare: adoptionFigure(20, 'pct', 44) },
        { vendor: 'copilot', before: adoptionFigure(3, 'count', 40), after: adoptionFigure(6, 'count', 44), afterShare: adoptionFigure(14, 'pct', 44) },
        { vendor: 'ensemble', before: withheldFigure('count', 'detection_incomplete'), after: adoptionFigure(1, 'count', 44), afterShare: adoptionFigure(2, 'pct', 44) },
      ],
      sources: [
        { source: 'commit_trailer', prs: 10 },
        { source: 'pr_body', prs: 4 },
        { source: 'ensemble', prs: 1 },
      ],
      otherAutomationPrs: 7,
    },
    people: {
      peopleUsingAi: cmp('people_using_ai', 'count', 4, 10),
      peopleShare: adoptionFigure(66.67, 'pct', 15),
      peopleWithMergedPrs: 15,
      vendors: [
        { vendor: 'claude', people: adoptionFigure(8, 'count', 15), prShare: adoptionFigure(20, 'pct', 44) },
        { vendor: 'copilot', people: adoptionFigure(4, 'count', 15), prShare: adoptionFigure(14, 'pct', 44) },
        { vendor: 'ensemble', people: withheldFigure('count', 'few_people', 15), prShare: adoptionFigure(2, 'pct', 44) },
      ],
      periods: peoplePeriods,
      agentPrs: { mergedPrs: 2, byVendor: { copilot: 2 } },
      withheld: null,
    },
    delivery: {
      comparisons: [
        cmp('merged_prs', 'count', 40, 44, false),
        cmp('human_merged_prs', 'count', 36, 40, false),
        cmp('automation_share', 'pct', 10, 9, false),
        cmp('lead_time', 'hours', 30, 22),
        cmp('first_review', 'hours', 5, 3),
        cmp('pr_size', 'lines', 220, 180),
        cmp('ci_pass', 'pct', 88, 91, false),
        cmp('reviewer_concentration', 'pct', null, 40),
      ],
      aiVsOther: {
        ai: { prs: 15, leadTimeHours: adoptionFigure(18, 'hours', 15), prSizeLines: adoptionFigure(240, 'lines', 15), ciPassPct: adoptionFigure(93, 'pct', 15), humanReviewCoveragePct: adoptionFigure(87, 'pct', 15) },
        other: { prs: 29, leadTimeHours: adoptionFigure(25, 'hours', 29), prSizeLines: adoptionFigure(150, 'lines', 29), ciPassPct: adoptionFigure(90, 'pct', 29), humanReviewCoveragePct: withheldFigure('pct', 'low_sample', 3) },
      },
    },
    courts: {
      comparisons: [cmp('court_reviewer', 'pct', 50, 40), cmp('court_author', 'pct', 30, 35), cmp('court_landing', 'pct', 20, 25)],
      measuredPrs: { before: 30, after: 38 },
      refusals: [],
    },
    reviewBots: {
      bots: [
        {
          key: 'coderabbit',
          label: 'CodeRabbit',
          kind: 'coderabbit',
          threads: 40,
          comments: 120,
          commentsPerPr: adoptionFigure(2.7, 'ratio', 44),
          actedOnPct: adoptionFigure(45, 'pct', 40),
          actedOnPctBefore: adoptionFigure(38, 'pct', 30),
          seatPriceMonthlyUsd: 24,
          costPerActedOnUsd: adoptionFigure(1.33, 'usd', 18),
        },
        {
          key: 'bot-2',
          label: 'In-house linter',
          kind: 'in_house',
          threads: 6,
          comments: 9,
          commentsPerPr: adoptionFigure(0.2, 'ratio', 44),
          actedOnPct: withheldFigure('pct', 'low_sample', 6),
          actedOnPctBefore: withheldFigure('pct', 'low_sample', 2),
          seatPriceMonthlyUsd: null,
          costPerActedOnUsd: withheldFigure('usd', 'no_price'),
        },
      ],
      ensemble: {
        key: 'pierre',
        label: 'Ensemble',
        kind: 'pierre',
        threads: 20,
        comments: 30,
        commentsPerPr: adoptionFigure(0.7, 'ratio', 44),
        actedOnPct: adoptionFigure(60, 'pct', 20),
        actedOnPctBefore: adoptionFigure(50, 'pct', 15),
        seatPriceMonthlyUsd: null,
        costPerActedOnUsd: withheldFigure('usd', 'no_price'),
      },
      ensembleActedOn: cmp('ensemble_acted_on', 'pct', 50, 60),
      mergedPrs: 44,
    },
    guardrails: {
      comparisons: [
        cmp('ci_pass', 'pct', 88, 91, false),
        cmp('replied_within_day_and_half', 'pct', 70, 80),
        cmp('human_review_coverage', 'pct', 90, 88, false),
        cmp('ai_human_review_coverage', 'pct', null, 87),
      ],
    },
    cost: {
      costUnit: 'week_pct',
      aiEnabled: true,
      comparisons: [cmp('ai_cost_total', 'week_pct', 12, 18), cmp('ai_cost_per_pr', 'week_pct', 0.3, 0.41)],
      runs: { before: 20, after: 31 },
      tokens: { before: 100_000, after: 150_000 },
      machineWideRuns: 2,
      seats: [],
      seatsMonthlyUsd: null,
    },
  };
  return { ...base, ...over };
}
