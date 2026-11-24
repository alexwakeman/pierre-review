// THE AI ADOPTION REPORT — the fold behind GET /api/reports/ai-adoption (docs/AI-ADOPTION-REPORT.md
// § The report; the wire is packages/shared ai-adoption-report.ts). DB only: no model, no GitHub.
//
//   • THE ONE REPORTING WINDOW. "After" is `getReportingWindow` resolved ONCE here, measured up to now
//     (`measuredTo`); "before" is the equal-length span just before it. Trend periods step back whole
//     window lengths. Never a second resolver.
//   • ONE REPO SET (coverage bias): the repos tracked since the oldest trend period's start, the
//     `buildPeriodSeries` loop (leading periods with no tracked repo are dropped). The narrowed scope
//     is built ONLY by `resolveWorkspaceScope`. A before window that starts before that set was tracked
//     has every figure withheld `partial_coverage`.
//   • THE ADOPTION POPULATION: merged PRs whose TRUE author (an Ensemble-opened PR is the person's) is
//     in the `human` lane, plus PRs an AI coding agent opened itself (a `pr_author` signal). Other
//     automation is left out and counted.
//   • UNKNOWN IS NEVER ZERO. A figure that cannot be stated honestly is withheld with a reason: no
//     data, below its floor (`ADOPTION_REPORT_FLOORS`, or the period metric's own sampleFloor), too few
//     PRs scanned by the detector, no price, no cost unit, AI off, repos not tracked yet.
//   • WINDOW-PURE: every figure is `[from, to)` on the column it counts (merged_at for PRs).
//   • NOBODY IS NAMED. The people slide counts how many people used AI (overall, per tool, per period)
//     and never says who: no user name or login is read. A count of 1 or 2 people is withheld
//     'few_people', and so is a share it could be worked back from (`ADOPTION_REPORT_FLOORS.minPeople`).
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  ADOPTION_REPORT_FLOORS,
  AI_ADOPTION_REPORT_SCHEMA_VERSION,
  AI_CODING_VENDORS,
  AI_SIGNAL_SOURCES,
  AI_SIGNALS_VERSION,
  adoptionFigure,
  aiVendorsOf,
  withheldFigure,
  type ActorLane,
  type AdoptionComparison,
  type AdoptionComparisonKey,
  type AdoptionCostSlide,
  type AdoptionCourtsSlide,
  type AdoptionDeliverySlide,
  type AdoptionDetectionCoverage,
  type AdoptionFigure,
  type AdoptionGuardrailsSlide,
  type AdoptionPeopleSlide,
  type AdoptionPeriod,
  type AdoptionPeoplePeriod,
  type AdoptionReportUnit,
  type AdoptionReviewBotRow,
  type AdoptionReviewBotsSlide,
  type AdoptionSpan,
  type AdoptionSplitSide,
  type AdoptionTrendSlide,
  type AdoptionVendorTotal,
  type AdoptionWithheldReason,
  type AiAdoptionReport,
  type AiCodingVendor,
  type AiSignal,
  type AiUsageReportResponse,
  type BotAnalyticsResponse,
  type BotVendorAnalytics,
  type FlowResponse,
  type PeriodMetricDirection,
  type PeriodMetricKey,
  type PeriodMetricValue,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes } from './actor-lanes.js';
import { getPrAiSignals, aiSignalsFirstScanMs } from './ai-signals.js';
import { getAiUsageReport, type AiUsageCostRate } from './ai-usage-report.js';
import { humanApprovedPrIds } from './human-review-coverage.js';
import { getPeriodCoverage, getPeriodMetrics, PERIOD_METRIC_META } from './period-metrics.js';
import { FLOW_DEFAULT_WINDOW_DAYS, getFlowCourts } from './pr-intervals.js';
import { getBotAnalytics, resolveWorkspaceScope, type BotScope } from './queries.js';
import { getReportingWindow, measuredTo, reportingWindowInfo, type ReportingWindow } from './reporting-window.js';
import { firstSettingEventMs, listWorkspaceSettingEvents } from './workspace-setting-events.js';

const { pullRequests, workspaces } = schema;

const DAY_MS = 86_400_000;
/** Trend periods reach back at most this far (the period series' 12 weeks). */
const TREND_REACH_MS = 12 * 7 * DAY_MS;
/** MIRRORED from sync/backfill-ai-signals.ts `AI_SIGNALS_BACKFILL_DAYS` (that module pulls in the
 *  GitHub client; adoption-report.test.ts asserts the two agree). */
export const ADOPTION_BACKFILL_DAYS = 90;
/** The merged-PR scan cap (db/period-metrics.ts PERIOD_PR_SCAN_CAP), newest kept. */
const MERGED_SCAN_CAP = 20_000;
/** A count of PEOPLE moves like a count of PRs: the merged-PR floors (PERIOD_METRIC_META). */
const PEOPLE_FLOOR = PERIOD_METRIC_META.human_merged_prs;

const F = ADOPTION_REPORT_FLOORS;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

interface Win {
  fromMs: number;
  toMs: number;
}

export interface AdoptionReportOptions {
  /** `config.aiEnabled`, passed in so the fold stays config-free. */
  aiEnabled: boolean;
  /** Claude's cost unit (api/routes/ai-usage-report.ts `costRate`). Absent or failing ⇒ no unit. */
  costRate?: () => Promise<AiUsageCostRate>;
}

// ── Figures and comparisons (pure) ──────────────────────────────────────────────────────────────

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A share of PRs: no_data on an empty population, detection_incomplete, then the `sharePrs` floor. */
export function shareFigure(numerator: number, denominator: number, detectionOk = true): AdoptionFigure {
  if (denominator <= 0) return withheldFigure('pct', 'no_data');
  if (!detectionOk) return withheldFigure('pct', 'detection_incomplete', denominator);
  if (denominator < F.sharePrs) return withheldFigure('pct', 'low_sample', denominator);
  return adoptionFigure(round2((numerator / denominator) * 100), 'pct', denominator);
}

/** A median over PRs, with the `sharePrs` floor. */
function medianFigure(xs: readonly number[], unit: AdoptionReportUnit): AdoptionFigure {
  const m = median(xs);
  if (m == null) return withheldFigure(unit, 'no_data');
  if (xs.length < F.sharePrs) return withheldFigure(unit, 'low_sample', xs.length);
  return adoptionFigure(round2(m), unit, xs.length);
}

const PERIOD_METRIC_UNIT: Record<PeriodMetricKey, AdoptionReportUnit> = {
  merged_prs: 'count',
  human_merged_prs: 'count',
  opened_prs: 'count',
  automation_merge_share_pct: 'pct',
  median_lead_time_hours: 'hours',
  median_time_to_first_human_review_hours: 'hours',
  merge_ci_success_pct: 'pct',
  median_pr_size_lines: 'lines',
  median_human_pr_size_lines: 'lines',
  review_threads_opened: 'count',
  threads_replied_within_36h_pct: 'pct',
  bot_review_comments: 'count',
  human_review_comments: 'count',
  bot_comments_per_merged_pr: 'ratio',
  reviewer_concentration_pct: 'pct',
};

/** A period metric as a figure: a count is always a count; a statistic below its floor is withheld. */
export function periodMetricFigure(m: PeriodMetricValue | undefined, key: PeriodMetricKey): AdoptionFigure {
  const unit = PERIOD_METRIC_UNIT[key];
  if (m == null || m.value == null) return withheldFigure(unit, 'no_data');
  if (unit !== 'count' && m.sampleSize < PERIOD_METRIC_META[key].sampleFloor) return withheldFigure(unit, 'low_sample', m.sampleSize);
  return adoptionFigure(m.value, unit, m.sampleSize);
}

/** The period-metrics significance rule (`buildDeltas`): both sides at the sample floor, and the
 *  change at the absolute floor. */
function floorSignificant(before: AdoptionFigure, after: AdoptionFigure, sampleFloor: number, absoluteFloor: number): boolean {
  if (!before.available || !after.available) return false;
  return before.sampleSize >= sampleFloor && after.sampleSize >= sampleFloor && Math.abs(round2(after.value - before.value)) >= absoluteFloor;
}

const shareSignificant = (b: AdoptionFigure, a: AdoptionFigure, sampleFloor: number = F.sharePrs): boolean =>
  floorSignificant(b, a, sampleFloor, F.shareChangePts);

function comparison(
  key: AdoptionComparisonKey,
  before: AdoptionFigure,
  after: AdoptionFigure,
  direction: PeriodMetricDirection,
  significant: boolean,
): AdoptionComparison {
  return { key, before, after, direction, significant: significant && before.available && after.available };
}

/** How big a change is, for ordering headlines: points for a share, else percent of the before. */
export function changeSize(c: AdoptionComparison): number {
  if (!c.before.available || !c.after.available) return -1;
  const d = Math.abs(c.after.value - c.before.value);
  if (c.after.unit === 'pct' || c.after.unit === 'week_pct') return d;
  if (c.before.value === 0) return c.after.value === 0 ? 0 : 100;
  return (d / Math.abs(c.before.value)) * 100;
}

/**
 * The summary slide's headlines: `ai_share` first when its after figure is shown, then the
 * significant comparisons by size of change, then (up to three) the comparisons with both sides
 * shown. At most five; one per key. Pure.
 */
export function summaryHeadlines(
  aiShare: AdoptionComparison,
  rest: readonly AdoptionComparison[],
): { headlines: AdoptionComparison[]; significantCount: number } {
  const seen = new Set<AdoptionComparisonKey>(['ai_share']);
  const pool: AdoptionComparison[] = [];
  for (const c of rest) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    pool.push(c);
  }
  const bySize = (a: AdoptionComparison, b: AdoptionComparison) => changeSize(b) - changeSize(a);
  const out: AdoptionComparison[] = aiShare.after.available ? [aiShare] : [];
  out.push(...pool.filter((c) => c.significant).sort(bySize));
  if (out.length < 3) {
    const shown = pool.filter((c) => !c.significant && c.before.available && c.after.available).sort(bySize);
    out.push(...shown.slice(0, 3 - out.length));
  }
  const headlines = out.slice(0, 5);
  return { headlines, significantCount: headlines.filter((c) => c.significant).length };
}

/** Withhold a before-side figure whose window starts before the measured repos were tracked. */
function coveredOr(f: AdoptionFigure, covered: boolean): AdoptionFigure {
  return covered ? f : withheldFigure(f.unit, 'partial_coverage', f.sampleSize);
}

function span(w: Win): AdoptionSpan {
  return { from: new Date(w.fromMs).toISOString(), to: new Date(w.toMs).toISOString(), days: round1((w.toMs - w.fromMs) / DAY_MS) };
}

/** The trend periods, oldest first: whole window lengths back from the window's start, the last one
 *  the report window (partial while running). At most 12, at most 12 weeks back, at least two. */
export function trendWindows(w: ReportingWindow, afterTo: number): (Win & { partial: boolean })[] {
  const len = Math.max(DAY_MS, w.toMs - w.fromMs);
  const n = Math.min(F.maxTrendPeriods, Math.max(2, Math.floor(TREND_REACH_MS / len)));
  const out: (Win & { partial: boolean })[] = [];
  for (let k = n - 1; k >= 1; k--) out.push({ fromMs: w.fromMs - k * len, toMs: w.fromMs - (k - 1) * len, partial: false });
  out.push({ fromMs: w.fromMs, toMs: afterTo, partial: afterTo < w.toMs });
  return out;
}

// ── The population ──────────────────────────────────────────────────────────────────────────────

interface PopPr {
  id: number;
  mergedAtMs: number;
  /** The true author: the person Ensemble opened it for, else the author. */
  ownerId: number | null;
  lane: ActorLane;
  /** In the adoption population. */
  inPop: boolean;
  /** In the population because an AI coding agent opened it (no person). */
  agent: boolean;
  leadHours: number;
  loc: number | null;
  ciDeterminate: boolean;
  ciSuccess: boolean;
  scanned: boolean;
  signals: AiSignal[];
  vendors: AiCodingVendor[];
}

const inWin = (p: { mergedAtMs: number }, w: Win): boolean => p.mergedAtMs >= w.fromMs && p.mergedAtMs < w.toMs;

/** Is detection complete enough over these PRs to state AI figures? (none ⇒ nothing to scan) */
function detectionOk(prs: readonly PopPr[]): boolean {
  if (prs.length === 0) return true;
  return (prs.filter((p) => p.scanned).length / prs.length) * 100 >= F.detectionScannedPct;
}

function scannedPctOf(prs: readonly PopPr[]): number | null {
  return prs.length === 0 ? null : round1((prs.filter((p) => p.scanned).length / prs.length) * 100);
}

function byVendorOf(prs: readonly PopPr[]): Partial<Record<AiCodingVendor, number>> {
  const out: Partial<Record<AiCodingVendor, number>> = {};
  for (const p of prs) for (const v of p.vendors) out[v] = (out[v] ?? 0) + 1;
  return out;
}

interface Population {
  prs: PopPr[];
  /** Ids a PERSON approved before the merge (every merged PR in range, every author). */
  approved: Set<number>;
}

async function loadPopulation(
  accountId: number,
  scope: BotScope,
  range: Win,
): Promise<Population> {
  if (scope.repoIds.length === 0 || range.toMs <= range.fromMs) return { prs: [], approved: new Set() };
  const [rows, lanes] = await Promise.all([
    db
      .select({
        id: pullRequests.id,
        authorId: pullRequests.authorId,
        limnOpenedForUserId: pullRequests.limnOpenedForUserId,
        openedAt: pullRequests.openedAt,
        mergedAt: pullRequests.mergedAt,
        additions: pullRequests.additions,
        deletions: pullRequests.deletions,
        changedFiles: pullRequests.changedFiles,
        ciStatus: pullRequests.ciStatus,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, scope.repoIds),
          gte(pullRequests.mergedAt, new Date(range.fromMs)),
          lt(pullRequests.mergedAt, new Date(range.toMs)),
        ),
      )
      .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
      .limit(MERGED_SCAN_CAP)
      .execute(),
    resolveActorLanes(accountId, scope),
  ]);
  const signals = await getPrAiSignals(accountId, rows.map((r) => r.id));
  const out: PopPr[] = [];
  for (const r of rows) {
    if (r.mergedAt == null) continue;
    const s = signals.get(r.id) ?? { scanned: false, signals: [] };
    const ownerId = r.limnOpenedForUserId ?? r.authorId;
    const lane = lanes.laneOf(ownerId);
    const agentAuthored = s.signals.some((x) => x.source === 'pr_author');
    const inPop = lane === 'human' || agentAuthored;
    // Lean storage defaults the size columns to 0: unknown size, never zero size (period-metrics rule).
    const observed = r.changedFiles > 0 || r.additions > 0 || r.deletions > 0;
    const ci = r.ciStatus;
    out.push({
      id: r.id,
      mergedAtMs: r.mergedAt.getTime(),
      ownerId,
      lane,
      inPop,
      agent: inPop && lane !== 'human',
      leadHours: (r.mergedAt.getTime() - r.openedAt.getTime()) / 3_600_000,
      loc: observed ? r.additions + r.deletions : null,
      ciDeterminate: ci === 'success' || ci === 'failure' || ci === 'error',
      ciSuccess: ci === 'success',
      scanned: s.scanned,
      signals: s.signals,
      vendors: aiVendorsOf(s.signals),
    });
  }
  // Human approvals for every merged PR in range (human review coverage needs every author).
  const approved = await humanApprovedPrIds(accountId, out.map((p) => ({ id: p.id, mergedAtMs: p.mergedAtMs })), lanes);
  return { prs: out, approved };
}

// ── The slides ──────────────────────────────────────────────────────────────────────────────────

interface Sides {
  before: PopPr[];
  after: PopPr[];
  beforeOk: boolean;
  afterOk: boolean;
  covered: boolean;
}

function adoptionSlide(all: readonly PopPr[], periods: (Win & { partial: boolean })[], sides: Sides, afterAll: readonly PopPr[]): AdoptionTrendSlide {
  const pop = all.filter((p) => p.inPop);
  const trend: AdoptionPeriod[] = periods.map((w) => {
    const prs = pop.filter((p) => inWin(p, w));
    const ai = prs.filter((p) => p.vendors.length > 0);
    return {
      from: new Date(w.fromMs).toISOString(),
      to: new Date(w.toMs).toISOString(),
      partial: w.partial,
      mergedPrs: prs.length,
      aiPrs: ai.length,
      share: shareFigure(ai.length, prs.length, detectionOk(prs)),
      byVendor: byVendorOf(prs),
      scannedPct: scannedPctOf(prs),
    };
  });
  const aiCount = (prs: readonly PopPr[]) => prs.filter((p) => p.vendors.length > 0).length;
  const beforeShare = coveredOr(shareFigure(aiCount(sides.before), sides.before.length, sides.beforeOk), sides.covered);
  const afterShare = shareFigure(aiCount(sides.after), sides.after.length, sides.afterOk);
  const aiShare = comparison('ai_share', beforeShare, afterShare, 'neutral', shareSignificant(beforeShare, afterShare));

  const beforeBy = byVendorOf(sides.before);
  const afterBy = byVendorOf(sides.after);
  const countFigure = (n: number, total: number, ok: boolean): AdoptionFigure =>
    total === 0 ? withheldFigure('count', 'no_data') : ok ? adoptionFigure(n, 'count', total) : withheldFigure('count', 'detection_incomplete', total);
  const vendors: AdoptionVendorTotal[] = AI_CODING_VENDORS.filter((v) => (beforeBy[v] ?? 0) > 0 || (afterBy[v] ?? 0) > 0).map((v) => ({
    vendor: v,
    before: coveredOr(countFigure(beforeBy[v] ?? 0, sides.before.length, sides.beforeOk), sides.covered),
    after: countFigure(afterBy[v] ?? 0, sides.after.length, sides.afterOk),
    afterShare: shareFigure(afterBy[v] ?? 0, sides.after.length, sides.afterOk),
  }));
  const sources = AI_SIGNAL_SOURCES.map((source) => ({
    source,
    prs: sides.after.filter((p) => p.signals.some((s) => s.source === source)).length,
  }));
  return {
    periods: trend,
    aiShare,
    vendors,
    sources,
    otherAutomationPrs: afterAll.filter((p) => !p.inPop).length,
  };
}

/** The distinct people (true authors) behind these PRs. Agent-opened PRs name nobody. */
function peopleOf(prs: readonly PopPr[]): Set<number> {
  const out = new Set<number>();
  for (const p of prs) if (!p.agent && p.ownerId != null) out.add(p.ownerId);
  return out;
}

/**
 * A count of PEOPLE out of `total`: 0 and `minPeople`+ are stated; 1 or 2 are withheld 'few_people'
 * (in a small team the count points at someone). Exported for tests.
 */
export function peopleCountFigure(n: number, total: number, detectionOk: boolean): AdoptionFigure {
  if (total === 0) return withheldFigure('count', 'no_data');
  if (!detectionOk) return withheldFigure('count', 'detection_incomplete', total);
  if (n > 0 && n < F.minPeople) return withheldFigure('count', 'few_people', total);
  return adoptionFigure(n, 'count', total);
}

/** `n` of `total` people as a share; withheld whenever the count is, so it cannot be worked back. */
export function peopleShareFigure(n: number, total: number, detectionOk: boolean): AdoptionFigure {
  const count = peopleCountFigure(n, total, detectionOk);
  if (!count.available) return withheldFigure('pct', count.reason, total);
  return adoptionFigure(round2((n / total) * 100), 'pct', total);
}

function peopleSlide(all: readonly PopPr[], periods: readonly (Win & { partial: boolean })[], sides: Sides): AdoptionPeopleSlide {
  const usingAi = (prs: readonly PopPr[]) => peopleOf(prs.filter((p) => p.vendors.length > 0));
  const afterPeople = peopleOf(sides.after);
  const beforePeople = peopleOf(sides.before);
  const before = coveredOr(peopleCountFigure(usingAi(sides.before).size, beforePeople.size, sides.beforeOk), sides.covered);
  const after = peopleCountFigure(usingAi(sides.after).size, afterPeople.size, sides.afterOk);
  const peopleUsingAi = comparison(
    'people_using_ai',
    before,
    after,
    'neutral',
    floorSignificant(before, after, PEOPLE_FLOOR.sampleFloor, PEOPLE_FLOOR.absoluteFloor),
  );
  const pop = all.filter((p) => p.inPop);
  const trend: AdoptionPeoplePeriod[] = periods.map((w) => {
    const prs = pop.filter((p) => inWin(p, w));
    const ok = detectionOk(prs);
    const people = peopleOf(prs).size;
    const using = usingAi(prs).size;
    return {
      from: new Date(w.fromMs).toISOString(),
      to: new Date(w.toMs).toISOString(),
      partial: w.partial,
      people,
      usingAi: peopleCountFigure(using, people, ok),
      share: peopleShareFigure(using, people, ok),
    };
  });
  const withheld: AdoptionWithheldReason | null = sides.after.length === 0 ? 'no_data' : sides.afterOk ? null : 'detection_incomplete';
  const base = {
    peopleUsingAi,
    peopleShare: peopleShareFigure(usingAi(sides.after).size, afterPeople.size, sides.afterOk),
    peopleWithMergedPrs: afterPeople.size,
    periods: trend,
  };
  if (withheld != null) return { ...base, vendors: [], agentPrs: null, withheld };
  const agents = sides.after.filter((p) => p.agent);
  const vendorSet = new Set(sides.after.flatMap((p) => p.vendors));
  return {
    ...base,
    vendors: AI_CODING_VENDORS.filter((v) => vendorSet.has(v)).map((v) => ({
      vendor: v,
      people: peopleCountFigure(peopleOf(sides.after.filter((p) => p.vendors.includes(v))).size, afterPeople.size, true),
      prShare: shareFigure(sides.after.filter((p) => p.vendors.includes(v)).length, sides.after.length, true),
    })),
    agentPrs: agents.length === 0 ? null : { mergedPrs: agents.length, byVendor: byVendorOf(agents) },
    withheld: null,
  };
}

const DELIVERY: readonly [AdoptionComparisonKey, PeriodMetricKey][] = [
  ['merged_prs', 'merged_prs'],
  ['human_merged_prs', 'human_merged_prs'],
  ['automation_share', 'automation_merge_share_pct'],
  ['lead_time', 'median_lead_time_hours'],
  ['first_review', 'median_time_to_first_human_review_hours'],
  ['pr_size', 'median_human_pr_size_lines'],
  ['ci_pass', 'merge_ci_success_pct'],
  ['reviewer_concentration', 'reviewer_concentration_pct'],
];

function metricComparison(
  key: AdoptionComparisonKey,
  metric: PeriodMetricKey,
  before: readonly PeriodMetricValue[],
  after: readonly PeriodMetricValue[],
  covered: boolean,
): AdoptionComparison {
  const meta = PERIOD_METRIC_META[metric];
  const b = coveredOr(periodMetricFigure(before.find((m) => m.key === metric), metric), covered);
  const a = periodMetricFigure(after.find((m) => m.key === metric), metric);
  return comparison(key, b, a, meta.direction, floorSignificant(b, a, meta.sampleFloor, meta.absoluteFloor));
}

function splitSide(prs: readonly PopPr[], approved: Set<number>): AdoptionSplitSide {
  const ci = prs.filter((p) => p.ciDeterminate);
  return {
    prs: prs.length,
    leadTimeHours: medianFigure(prs.map((p) => p.leadHours), 'hours'),
    prSizeLines: medianFigure(prs.flatMap((p) => (p.loc == null ? [] : [p.loc])), 'lines'),
    ciPassPct: shareFigure(ci.filter((p) => p.ciSuccess).length, ci.length),
    humanReviewCoveragePct: shareFigure(prs.filter((p) => approved.has(p.id)).length, prs.length),
  };
}

function courtFigure(f: FlowResponse | null, court: 'reviewer' | 'author' | 'landing'): AdoptionFigure {
  if (f == null || f.measuredPrs === 0) return withheldFigure('pct', 'no_data');
  if (f.measuredPrs < F.sharePrs) return withheldFigure('pct', 'low_sample', f.measuredPrs);
  const share = f.courts.find((c) => c.court === court)?.share;
  return share == null ? withheldFigure('pct', 'no_data') : adoptionFigure(round2(share * 100), 'pct', f.measuredPrs);
}

function courtsSlide(before: FlowResponse | null, after: FlowResponse | null, covered: boolean): AdoptionCourtsSlide {
  const keys = [
    ['court_reviewer', 'reviewer'],
    ['court_author', 'author'],
    ['court_landing', 'landing'],
  ] as const;
  const comparisons = keys.map(([key, court]) => {
    const b = coveredOr(courtFigure(before, court), covered);
    const a = courtFigure(after, court);
    return comparison(key, b, a, 'neutral', shareSignificant(b, a));
  });
  const refusals = after == null ? ['Where the time goes could not be measured.'] : after.refusals.filter((r) => r.kind === 'courts').map((r) => r.reason);
  // ⚠ A fold that failed is UNKNOWN (null), never zero PRs measured.
  return { comparisons, measuredPrs: { before: before?.measuredPrs ?? null, after: after?.measuredPrs ?? null }, refusals };
}

function actedOnFigure(threads: number, actedOn: number): AdoptionFigure {
  if (threads <= 0) return withheldFigure('pct', 'no_data');
  if (threads < F.botActedOnThreads) return withheldFigure('pct', 'low_sample', threads);
  return adoptionFigure(round2((actedOn / threads) * 100), 'pct', threads);
}

function perPrFigure(comments: number, mergedPrs: number): AdoptionFigure {
  if (mergedPrs <= 0) return withheldFigure('ratio', 'no_data');
  return adoptionFigure(round2(comments / mergedPrs), 'ratio', mergedPrs);
}

const isThirdParty = (v: BotVendorAnalytics): boolean => v.kind !== 'pierre';
const active = (v: BotVendorAnalytics): boolean => v.threads > 0 || v.comments > 0;

function reviewBotsSlide(
  before: BotAnalyticsResponse | null,
  after: BotAnalyticsResponse | null,
  mergedPrs: number,
  covered: boolean,
): AdoptionReviewBotsSlide {
  const afterRows = after?.vendors ?? [];
  const beforeByKey = new Map((before?.vendors ?? []).map((v) => [v.key, v] as const));
  const third = afterRows
    .filter((v) => isThirdParty(v) && active(v))
    .sort((a, b) => b.comments - a.comments || b.threads - a.threads || a.label.localeCompare(b.label, 'en-GB'))
    .slice(0, F.maxReviewBots);
  const bots: AdoptionReviewBotRow[] = third.map((v) => {
    const prior = beforeByKey.get(v.key);
    const actedOnPct = actedOnFigure(v.threads, v.actedOn);
    let costPerActedOnUsd: AdoptionFigure;
    if (v.costMonthlyUsd == null) costPerActedOnUsd = withheldFigure('usd', 'no_price');
    else if (v.threads < F.botActedOnThreads) costPerActedOnUsd = withheldFigure('usd', 'low_sample', v.threads);
    else if (v.costPerActedOnUsd == null || !Number.isFinite(v.costPerActedOnUsd)) costPerActedOnUsd = withheldFigure('usd', 'no_data', v.actedOn);
    else costPerActedOnUsd = adoptionFigure(round2(v.costPerActedOnUsd), 'usd', v.actedOn);
    return {
      key: v.key,
      label: v.label,
      kind: v.kind,
      threads: v.threads,
      comments: v.comments,
      commentsPerPr: perPrFigure(v.comments, mergedPrs),
      actedOnPct,
      actedOnPctBefore: coveredOr(prior == null ? withheldFigure('pct', 'no_data') : actedOnFigure(prior.threads, prior.actedOn), covered),
      seatPriceMonthlyUsd: v.costMonthlyUsd,
      costPerActedOnUsd,
    };
  });
  // Ensemble's own findings: the 'pierre' rows summed.
  const sum = (rows: readonly BotVendorAnalytics[]) =>
    rows.filter((v) => v.kind === 'pierre').reduce((t, v) => ({ threads: t.threads + v.threads, comments: t.comments + v.comments, actedOn: t.actedOn + v.actedOn }), { threads: 0, comments: 0, actedOn: 0 });
  const ea = sum(afterRows);
  const eb = sum(before?.vendors ?? []);
  const ensemble: AdoptionReviewBotRow | null =
    ea.threads === 0 && ea.comments === 0
      ? null
      : {
          key: 'ensemble',
          label: 'Ensemble',
          kind: 'pierre',
          threads: ea.threads,
          comments: ea.comments,
          commentsPerPr: perPrFigure(ea.comments, mergedPrs),
          actedOnPct: actedOnFigure(ea.threads, ea.actedOn),
          actedOnPctBefore: coveredOr(actedOnFigure(eb.threads, eb.actedOn), covered),
          seatPriceMonthlyUsd: null,
          costPerActedOnUsd: withheldFigure('usd', 'no_price'),
        };
  const b = coveredOr(actedOnFigure(eb.threads, eb.actedOn), covered);
  const a = actedOnFigure(ea.threads, ea.actedOn);
  return {
    bots,
    ensemble,
    ensembleActedOn: comparison('ensemble_acted_on', b, a, 'up_good', shareSignificant(b, a, F.botActedOnThreads)),
    mergedPrs,
  };
}

interface UsageSide {
  report: AiUsageReportResponse;
  /** The same fold over NO repo: exactly the machine-wide rows, subtracted from `report`. */
  machineWide: AiUsageReportResponse;
}

function costSlide(
  aiEnabled: boolean,
  unit: AdoptionCostSlide['costUnit'],
  before: UsageSide | null,
  after: UsageSide | null,
  mergedBefore: AdoptionFigure,
  mergedAfter: AdoptionFigure,
  covered: boolean,
  seats: { label: string; monthlyUsd: number }[],
): AdoptionCostSlide {
  const seatsMonthlyUsd = seats.length === 0 ? null : round2(seats.reduce((n, s) => n + s.monthlyUsd, 0));
  const net = (s: UsageSide | null) => {
    if (s == null) return null;
    const t = s.report.totals;
    const m = s.machineWide.totals;
    return {
      runs: Math.max(0, t.runs - m.runs),
      tokens: Math.max(0, t.tokens - m.tokens),
      claudeTokens: Math.max(0, t.claudeTokens - m.claudeTokens),
      codexTokens: Math.max(0, t.codexTokens - m.codexTokens),
      cost: t.claudeCost == null ? null : Math.max(0, t.claudeCost - (m.claudeCost ?? 0)),
    };
  };
  const nb = net(before);
  const na = net(after);
  if (!aiEnabled) {
    const off = (u: AdoptionReportUnit) => withheldFigure(u, 'ai_off');
    return {
      costUnit: null,
      aiEnabled: false,
      comparisons: [
        comparison('ai_cost_total', off('usd'), off('usd'), 'neutral', false),
        comparison('ai_cost_per_pr', off('usd'), off('usd'), 'neutral', false),
      ],
      runs: { before: nb?.runs ?? null, after: na?.runs ?? null },
      tokens: { before: nb?.tokens ?? null, after: na?.tokens ?? null },
      machineWideRuns: after?.machineWide.totals.runs ?? null,
      seats,
      seatsMonthlyUsd,
    };
  }
  const figUnit: AdoptionReportUnit = unit === 'week_pct' ? 'week_pct' : 'usd';
  const total = (n: ReturnType<typeof net>): AdoptionFigure => {
    if (n == null) return withheldFigure(figUnit, 'no_data');
    // ⚠ NEVER US$ ON A SUBSCRIPTION: the unit is the route's (`costRate`), converted before the fold.
    if (unit == null || n.cost == null) return withheldFigure(figUnit, 'no_cost_unit', n.runs);
    // Codex runs carry tokens only: a window spent on Codex alone has no cost to state.
    if (n.claudeTokens === 0 && n.codexTokens > 0) return withheldFigure(figUnit, 'no_cost_unit', n.runs);
    return adoptionFigure(round2(n.cost), figUnit, n.runs);
  };
  const perPr = (t: AdoptionFigure, merged: AdoptionFigure): AdoptionFigure => {
    if (!t.available) return t;
    if (!merged.available || merged.value <= 0) return withheldFigure(figUnit, 'no_data');
    if (merged.value < F.sharePrs) return withheldFigure(figUnit, 'low_sample', merged.value);
    return adoptionFigure(Math.round((t.value / merged.value) * 10_000) / 10_000, figUnit, merged.value);
  };
  const tb = coveredOr(total(nb), covered);
  const ta = total(na);
  return {
    costUnit: unit,
    aiEnabled: true,
    // Cost comparisons are shown as two figures, never as a move: spend has no floor to meet.
    comparisons: [
      comparison('ai_cost_total', tb, ta, 'neutral', false),
      comparison('ai_cost_per_pr', coveredOr(perPr(total(nb), mergedBefore), covered), perPr(ta, mergedAfter), 'neutral', false),
    ],
    // ⚠ A usage read that failed is UNKNOWN (null), never zero runs.
    runs: { before: nb?.runs ?? null, after: na?.runs ?? null },
    tokens: { before: nb?.tokens ?? null, after: na?.tokens ?? null },
    machineWideRuns: after?.machineWide.totals.runs ?? null,
    seats,
    seatsMonthlyUsd,
  };
}

/** A fold that fails yields null (its slide's figures are withheld), never a failed report. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────

/**
 * The AI adoption report for one workspace. `workspace` resolves like `?workspace=` (absent, unknown
 * or another account's ⇒ the Default workspace). DB only.
 */
export async function buildAiAdoptionReport(
  accountId: number,
  workspace: string | number | null | undefined,
  nowMs: number,
  opts: AdoptionReportOptions,
): Promise<AiAdoptionReport> {
  const scope = await resolveWorkspaceScope(accountId, workspace ?? null);
  const workspaceId = scope.workspaceId;
  // THE ONE REPORTING WINDOW, resolved once.
  const w = await getReportingWindow(accountId, workspaceId, nowMs);
  const afterTo = Math.max(w.fromMs, measuredTo(w, nowMs));
  const after: Win = { fromMs: w.fromMs, toMs: afterTo };
  const spanMs = afterTo - w.fromMs;
  const before: Win = { fromMs: w.fromMs - spanMs, toMs: w.fromMs };

  // ONE REPO SET: tracked since the oldest trend period (the buildPeriodSeries loop).
  let periods = trendWindows(w, afterTo);
  let repoSet: number[] = [];
  while (periods.length > 0) {
    const tracked = await getPeriodCoverage(accountId, scope.repoIds, periods[0]!.fromMs);
    repoSet = tracked.trackedRepoIds;
    if (repoSet.length > 0) break;
    periods = periods.slice(1);
  }
  if (periods.length === 0) {
    // No repo was tracked even when the window began: measure the workspace as it is, and say the
    // before window is not covered.
    periods = [{ ...after, partial: afterTo < w.toMs }];
    repoSet = [...scope.repoIds];
  }
  const covered = repoSet.length > 0 && periods[0]!.fromMs <= before.fromMs;
  // The narrowed scope is built ONLY by resolveWorkspaceScope (membership ∩ narrow).
  const measured = await resolveWorkspaceScope(accountId, workspaceId, repoSet);
  const range: Win = { fromMs: Math.min(periods[0]!.fromMs, before.fromMs), toMs: afterTo };
  const beforeWindow: ReportingWindow = { fromMs: before.fromMs, toMs: before.toMs, mode: w.mode };

  const rate: AiUsageCostRate = opts.aiEnabled && opts.costRate != null ? ((await orNull(opts.costRate())) ?? { unit: null, perUsd: 0 }) : { unit: null, perUsd: 0 };
  const none: BotScope = { workspaceId, repoIds: [] };
  const usage = (win: ReportingWindow): Promise<UsageSide | null> =>
    orNull(
      Promise.all([getAiUsageReport(accountId, measured, win, nowMs, rate), getAiUsageReport(accountId, none, win, nowMs, rate)]).then(
        ([report, machineWide]) => ({ report, machineWide }),
      ),
    );

  const [population, metricsBefore, metricsAfter, courtsBefore, courtsAfter, botsBefore, botsAfter, usageBefore, usageAfter, markers, historyFrom, firstScan, wsRow] =
    await Promise.all([
      loadPopulation(accountId, measured, range),
      getPeriodMetrics(accountId, measured, before),
      getPeriodMetrics(accountId, measured, after),
      orNull(getFlowCourts(accountId, measured, FLOW_DEFAULT_WINDOW_DAYS, { reporting: beforeWindow, nowMs })),
      orNull(getFlowCourts(accountId, measured, FLOW_DEFAULT_WINDOW_DAYS, { reporting: w, nowMs })),
      orNull(getBotAnalytics(accountId, { kind: 'sprint', fromMs: before.fromMs, toMs: before.toMs }, measured)),
      orNull(getBotAnalytics(accountId, { kind: 'sprint', fromMs: after.fromMs, toMs: after.toMs }, measured)),
      opts.aiEnabled ? usage(beforeWindow) : Promise.resolve(null),
      opts.aiEnabled ? usage(w) : Promise.resolve(null),
      listWorkspaceSettingEvents(accountId, workspaceId, periods[0]!.fromMs, afterTo),
      firstSettingEventMs(accountId, workspaceId),
      aiSignalsFirstScanMs(accountId, measured.repoIds),
      db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
        .limit(1)
        .execute(),
    ]);

  const { prs: all, approved } = population;
  const beforeAll = all.filter((p) => inWin(p, before));
  const afterAll = all.filter((p) => inWin(p, after));
  const beforePop = beforeAll.filter((p) => p.inPop);
  const afterPop = afterAll.filter((p) => p.inPop);
  const sides: Sides = { before: beforePop, after: afterPop, beforeOk: detectionOk(beforePop), afterOk: detectionOk(afterPop), covered };

  const both = [...beforePop, ...afterPop];
  const scannedPrs = both.filter((p) => p.scanned).length;
  const scannedPct = both.length === 0 ? null : round1((scannedPrs / both.length) * 100);
  const detection: AdoptionDetectionCoverage = {
    scannedPrs,
    totalPrs: both.length,
    scannedPct,
    complete: scannedPct == null || scannedPct >= F.detectionScannedPct,
    detectorVersion: AI_SIGNALS_VERSION,
    coversFrom: firstScan == null ? null : new Date(firstScan - ADOPTION_BACKFILL_DAYS * DAY_MS).toISOString(),
  };

  const adoption = adoptionSlide(all, periods, sides, afterAll);
  const people = peopleSlide(all, periods, sides);

  const delivery: AdoptionDeliverySlide = {
    comparisons: DELIVERY.map(([key, metric]) => metricComparison(key, metric, metricsBefore.metrics, metricsAfter.metrics, covered)),
    aiVsOther: sides.afterOk
      ? { ai: splitSide(afterPop.filter((p) => p.vendors.length > 0), approved), other: splitSide(afterPop.filter((p) => p.vendors.length === 0), approved) }
      : null,
  };
  const ciPass = delivery.comparisons.find((c) => c.key === 'ci_pass')!;

  const coverageOf = (prs: readonly PopPr[]) => shareFigure(prs.filter((p) => approved.has(p.id)).length, prs.length);
  const hrcB = coveredOr(coverageOf(beforeAll), covered);
  const hrcA = coverageOf(afterAll);
  const aiOnly = (prs: readonly PopPr[]) => prs.filter((p) => p.vendors.length > 0);
  const aiCoverage = (prs: readonly PopPr[], ok: boolean): AdoptionFigure => {
    const ai = aiOnly(prs);
    return shareFigure(ai.filter((p) => approved.has(p.id)).length, ai.length, ok);
  };
  const ahrcB = coveredOr(aiCoverage(beforePop, sides.beforeOk), covered);
  const ahrcA = aiCoverage(afterPop, sides.afterOk);
  const guardrails: AdoptionGuardrailsSlide = {
    comparisons: [
      ciPass,
      metricComparison('replied_within_day_and_half', 'threads_replied_within_36h_pct', metricsBefore.metrics, metricsAfter.metrics, covered),
      comparison('human_review_coverage', hrcB, hrcA, 'up_good', shareSignificant(hrcB, hrcA)),
      comparison('ai_human_review_coverage', ahrcB, ahrcA, 'up_good', shareSignificant(ahrcB, ahrcA)),
    ],
  };

  const mergedFig = (ms: readonly PeriodMetricValue[]) => periodMetricFigure(ms.find((m) => m.key === 'merged_prs'), 'merged_prs');
  const mergedAfterFig = mergedFig(metricsAfter.metrics);
  const mergedAfter = mergedAfterFig.available ? mergedAfterFig.value : 0;
  const reviewBots = reviewBotsSlide(botsBefore, botsAfter, mergedAfter, covered);
  const courts = courtsSlide(courtsBefore, courtsAfter, covered);

  // Review-bot seat prices as entered, in THIS workspace (never summed across workspaces).
  const seats = (botsAfter?.vendors ?? [])
    .filter((v) => isThirdParty(v) && v.costMonthlyUsd != null)
    .map((v) => ({ label: v.label, monthlyUsd: v.costMonthlyUsd! }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en-GB'));
  const cost = costSlide(opts.aiEnabled, rate.unit, usageBefore, usageAfter, coveredOr(mergedFig(metricsBefore.metrics), covered), mergedAfterFig, covered, seats);

  const summary = summaryHeadlines(adoption.aiShare, [
    people.peopleUsingAi,
    ...delivery.comparisons,
    ...courts.comparisons,
    reviewBots.ensembleActedOn,
    ...guardrails.comparisons,
    ...cost.comparisons,
  ]);

  return {
    schemaVersion: AI_ADOPTION_REPORT_SCHEMA_VERSION,
    workspaceId,
    workspaceName: wsRow[0]?.name ?? 'Workspace',
    generatedAt: new Date(nowMs).toISOString(),
    window: reportingWindowInfo(w, nowMs),
    after: span(after),
    before: span(before),
    repos: { measured: measured.repoIds.length, total: scope.repoIds.length },
    detection,
    markers: markers.map((m) => ({ at: new Date(m.occurredAtMs).toISOString(), kind: m.kind, summary: m.summary })),
    settingHistoryFrom: historyFrom == null ? null : new Date(historyFrom).toISOString(),
    summary,
    adoption,
    people,
    delivery,
    courts,
    reviewBots,
    guardrails,
    cost,
  };
}

/** Pure pieces, exported for the unit tests. */
export const __adoptionTesting = { median, comparison, shareSignificant, floorSignificant, coveredOr, reviewBotsSlide, costSlide, courtsSlide };
