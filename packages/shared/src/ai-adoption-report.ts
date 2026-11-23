import type { AiProviderId, AutomatedReviewerKind, PeriodMetricDirection, PrCourt, ReportingWindowInfo } from './types.js';
import type { AiUsageCostUnit } from './ai-usage-report.js';
import type { WorkspaceSettingEventKind } from './flow-trend.js';
import { reportingWindowPhrase } from './reporting-window.js';
import { AI_CODING_VENDOR_LABEL, AI_SIGNAL_SOURCE_LABEL, type AiCodingVendor, type AiSignalSource } from './ai-vendor-detect.js';

// THE AI ADOPTION REPORT (Reports → Download report; docs/AI-ADOPTION-REPORT.md).
//
//   GET  /api/reports/ai-adoption?workspace=<id>        DB only → AiAdoptionReport
//   POST /api/reports/ai-adoption/commentary            ONE completion per slide → AdoptionCommentaryResponse
//
// The SPA turns the report into a PDF shaped like a slide deck, on the reader's machine.
//
// ⚠ UNKNOWN IS NEVER ZERO. A figure that cannot be stated honestly is an `AdoptionFigure` with
//   `available: false` and a named reason — drawn as "—" with the reason, never as 0.
// ⚠ GROUNDING IS CODE'S. The model writes text with `{{key}}` placeholders only; `validateCommentary`
//   rejects any numeral (Unicode too), any number or multiplying word ("three", "half", "twice"), a
//   move word beside a change that is not clear, any unknown or unusable key, markup, handles and causal
//   claims. Code substitutes every number (`fillCommentary`). A rejected or failed slide uses
//   `fallbackCommentary`, built from the same figure table.
// ⚠ THE REPORT NAMES NOBODY. No name, login or per-person row is on this wire, in the PDF or sent to
//   the model: only how many people used AI, per tool and per period. A count of 1 or 2 people is
//   withheld as 'few_people' ("fewer than 3"), and so is any share it could be worked back from.

export const AI_ADOPTION_REPORT_SCHEMA_VERSION = 1;

// ── Floors (ONE place) ──────────────────────────────────────────────────────────────────────────

export const ADOPTION_REPORT_FLOORS = {
  /** A share of merged PRs (adoption, human review coverage, an AI-vs-other side) needs this many. */
  sharePrs: 5,
  /** A share's change is "significant" only when it moved at least this many percentage points. */
  shareChangePts: 5,
  /** A trend period, or a before/after side, shows AI figures only when at least this share of its
   *  merged PRs has been scanned by the current detector. */
  detectionScannedPct: 90,
  /** A review bot's acted-on share needs this many threads. */
  botActedOnThreads: 10,
  /** At most this many trend periods (and never fewer than two). */
  maxTrendPeriods: 12,
  /** At most this many third-party review bots on the slide (by comment count; bots, not people). */
  maxReviewBots: 8,
  /** A count of PEOPLE below this (and above zero) is withheld as 'few_people': in a small team, "1
   *  person used Devin" points at someone as surely as a name. */
  minPeople: 3,
} as const;

// ── Figures ─────────────────────────────────────────────────────────────────────────────────────

/** `pct` and `week_pct` are 0..100. `hours` are wall-clock hours. `usd` is US$ (API key, or a seat
 *  price as entered). `week_pct` is a share of a week's subscription allowance — NEVER US$. */
export type AdoptionReportUnit = 'count' | 'pct' | 'hours' | 'lines' | 'ratio' | 'usd' | 'week_pct';

export type AdoptionWithheldReason =
  /** Nothing in the population. */
  | 'no_data'
  /** Below its floor (ADOPTION_REPORT_FLOORS, or the period metric's own sampleFloor). */
  | 'low_sample'
  /** Too few of these PRs have been scanned for AI signals yet (the backfill is still running). */
  | 'detection_incomplete'
  /** No seat price entered for this bot. */
  | 'no_price'
  /** No cost unit: no credential kind known, or the runs were Codex (tokens only). */
  | 'no_cost_unit'
  /** AI is switched off on this install. */
  | 'ai_off'
  /** The before window starts before the repos were tracked. */
  | 'partial_coverage'
  /** 1 or 2 people (below `minPeople`): withheld so the figure cannot point at anyone. */
  | 'few_people';

export type AdoptionFigure =
  | { available: true; value: number; unit: AdoptionReportUnit; sampleSize: number }
  | { available: false; unit: AdoptionReportUnit; sampleSize: number; reason: AdoptionWithheldReason };

export type AvailableAdoptionFigure = Extract<AdoptionFigure, { available: true }>;

/** Keys of every before/after comparison. ⚠ Lowercase letters and `_` only (placeholder keys). */
export type AdoptionComparisonKey =
  | 'ai_share'
  | 'people_using_ai'
  | 'merged_prs'
  | 'human_merged_prs'
  | 'automation_share'
  | 'lead_time'
  | 'first_review'
  | 'pr_size'
  | 'ci_pass'
  | 'reviewer_concentration'
  | 'replied_within_day_and_half'
  | 'human_review_coverage'
  | 'ai_human_review_coverage'
  | 'court_reviewer'
  | 'court_author'
  | 'court_landing'
  | 'ensemble_acted_on'
  | 'ai_cost_total'
  | 'ai_cost_per_pr';

/** The ONE label of each comparison (slides, tables and the model's figure table). */
export const ADOPTION_COMPARISON_LABEL: Readonly<Record<AdoptionComparisonKey, string>> = {
  ai_share: 'Merged PRs with AI involved',
  people_using_ai: 'People who merged a PR with AI involved',
  merged_prs: 'Merged PRs',
  human_merged_prs: 'Merged PRs written by people',
  automation_share: 'Merged PRs written by automation',
  lead_time: 'Median lead time',
  first_review: 'Median time to first human review',
  pr_size: 'Median PR size (people)',
  ci_pass: 'CI passing at merge',
  reviewer_concentration: 'Reviews done by the busiest reviewer',
  replied_within_day_and_half: 'Review threads answered within 36 hours',
  human_review_coverage: 'Merged PRs approved by a person',
  ai_human_review_coverage: 'PRs with AI involved, approved by a person',
  court_reviewer: 'Open time waiting on reviewers',
  court_author: 'Open time waiting on authors',
  court_landing: 'Open time waiting to land',
  ensemble_acted_on: "Ensemble's findings acted on",
  ai_cost_total: 'Ensemble AI spend',
  ai_cost_per_pr: 'Ensemble AI spend per merged PR',
};

export interface AdoptionComparison {
  key: AdoptionComparisonKey;
  before: AdoptionFigure;
  after: AdoptionFigure;
  direction: PeriodMetricDirection;
  /** Both sides meet their floor AND the change meets its absolute floor (the period-metrics rule;
   *  shares use `shareChangePts`). A non-significant change is shown as figures, never as a move. */
  significant: boolean;
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────

/** A half-open span `[from, to)`, ISO-8601. */
export interface AdoptionSpan {
  from: string;
  to: string;
  /** Length in days, one decimal. */
  days: number;
}

export interface AdoptionDetectionCoverage {
  /** Merged PRs (both windows, the adoption population) scanned by the current detector. */
  scannedPrs: number;
  totalPrs: number;
  /** null when totalPrs is 0. */
  scannedPct: number | null;
  /** scannedPct ≥ ADOPTION_REPORT_FLOORS.detectionScannedPct. */
  complete: boolean;
  detectorVersion: number;
  /** The oldest date the one-time backfill reaches (90 days before it ran); null if unknown. */
  coversFrom: string | null;
}

/** A dated workspace setting change, drawn as a dashed line on the trend slides. */
export interface AdoptionSettingMarker {
  at: string;
  kind: WorkspaceSettingEventKind;
  summary: string;
}

export interface AdoptionPeriod {
  from: string;
  to: string;
  /** The current window while it is still running (a sprint so far). */
  partial: boolean;
  /** The adoption population: merged PRs written by a person or by an AI coding agent. */
  mergedPrs: number;
  /** Of those, PRs with at least one AI signal. */
  aiPrs: number;
  /** aiPrs / mergedPrs, withheld below `sharePrs` or `detectionScannedPct`. */
  share: AdoptionFigure;
  /** PRs per vendor (a PR with two vendors counts in both; the share counts it once). */
  byVendor: Partial<Record<AiCodingVendor, number>>;
  scannedPct: number | null;
}

export interface AdoptionVendorTotal {
  vendor: AiCodingVendor;
  /** PRs with this vendor involved (count). */
  before: AdoptionFigure;
  after: AdoptionFigure;
  /** Share of the after window's adoption population (pct). */
  afterShare: AdoptionFigure;
}

export interface AdoptionSourceCount {
  source: AiSignalSource;
  /** After-window PRs where this source showed any vendor. */
  prs: number;
}

export interface AdoptionTrendSlide {
  /** Oldest first; the last one is the report window. Leading periods with no tracked repo dropped. */
  periods: AdoptionPeriod[];
  aiShare: AdoptionComparison;
  /** Vendors seen in either window, in AI_CODING_VENDORS order. */
  vendors: AdoptionVendorTotal[];
  sources: AdoptionSourceCount[];
  /** After-window merged PRs left out of the population (dependency, release, housekeeping bots). */
  otherAutomationPrs: number;
}

/** One tool's reach this period. ⚠ Counts of people, never who. */
export interface AdoptionPeopleVendor {
  vendor: AiCodingVendor;
  /** People who merged a PR with this tool involved (count, of `peopleWithMergedPrs`); 'few_people'
   *  at 1 or 2. */
  people: AdoptionFigure;
  /** The share of merged PRs with this tool involved (pct of the adoption population). */
  prShare: AdoptionFigure;
}

/** How many people used AI in one trend period (the adoption slide's periods, same order). */
export interface AdoptionPeoplePeriod {
  from: string;
  to: string;
  partial: boolean;
  /** People who merged a PR in the period (not agent-opened PRs). */
  people: number;
  /** Of those, people with at least one PR with AI involved; 'few_people' at 1 or 2. */
  usingAi: AdoptionFigure;
  /** usingAi / people (pct); withheld whenever `usingAi` is, so the count cannot be worked back. */
  share: AdoptionFigure;
}

/**
 * "How widely AI is used": adoption breadth, never who. ⚠ No name, login or per-person row, by
 * design (the owner's decision, 2026-11-23): the report is shared outside the team.
 */
export interface AdoptionPeopleSlide {
  /** People who merged a PR with AI involved, before and after (counts; 'few_people' at 1 or 2). */
  peopleUsingAi: AdoptionComparison;
  /** The after window's peopleUsingAi as a share of `peopleWithMergedPrs` (pct). */
  peopleShare: AdoptionFigure;
  /** People with at least one merged PR in the after window. */
  peopleWithMergedPrs: number;
  /** Tools with at least one after-window PR, in vendor order. */
  vendors: AdoptionPeopleVendor[];
  /** Per trend period, oldest first (the adoption slide's periods). */
  periods: AdoptionPeoplePeriod[];
  /** PRs an AI coding agent opened with no person named (Copilot coding agent, Devin…); null if none. */
  agentPrs: { mergedPrs: number; byVendor: Partial<Record<AiCodingVendor, number>> } | null;
  /** Set when the after window's detection coverage is below the floor: nothing per tool is drawn. */
  withheld: AdoptionWithheldReason | null;
}

export interface AdoptionSplitSide {
  prs: number;
  leadTimeHours: AdoptionFigure;
  prSizeLines: AdoptionFigure;
  ciPassPct: AdoptionFigure;
  humanReviewCoveragePct: AdoptionFigure;
}

export interface AdoptionDeliverySlide {
  /** merged_prs, human_merged_prs, automation_share, lead_time, first_review, pr_size, ci_pass,
   *  reviewer_concentration — in that order. */
  comparisons: AdoptionComparison[];
  /** After window: PRs with AI involved vs the rest of the adoption population. Null when detection
   *  is incomplete for the window. A comparison, not a cause. */
  aiVsOther: { ai: AdoptionSplitSide; other: AdoptionSplitSide } | null;
}

export interface AdoptionCourtsSlide {
  /** court_reviewer, court_author, court_landing (pct of open hours). */
  comparisons: AdoptionComparison[];
  /** ⚠ Null when the Chronology fold could not run for that window: unknown, never zero. */
  measuredPrs: { before: number | null; after: number | null };
  /** Plain-English refusals from the Chronology fold, as it words them. */
  refusals: string[];
}

export interface AdoptionReviewBotRow {
  key: string;
  label: string;
  kind: AutomatedReviewerKind;
  threads: number;
  comments: number;
  commentsPerPr: AdoptionFigure;
  actedOnPct: AdoptionFigure;
  actedOnPctBefore: AdoptionFigure;
  /** The seat price as entered (US$ per month); null when none entered. */
  seatPriceMonthlyUsd: number | null;
  costPerActedOnUsd: AdoptionFigure;
}

export interface AdoptionReviewBotsSlide {
  /** Third-party review bots (role 'review', kind ≠ 'pierre'), by comments, at most `maxReviewBots`. */
  bots: AdoptionReviewBotRow[];
  /** Ensemble's own review findings (the 'pierre' rows summed); null when Ensemble posted none. */
  ensemble: AdoptionReviewBotRow | null;
  ensembleActedOn: AdoptionComparison;
  /** After-window merged PRs (the comments-per-PR denominator). */
  mergedPrs: number;
}

export interface AdoptionGuardrailsSlide {
  /** ci_pass, replied_within_day_and_half, human_review_coverage, ai_human_review_coverage. */
  comparisons: AdoptionComparison[];
}

export interface AdoptionCostSlide {
  /** Claude's ONE cost unit; null = tokens only. ⚠ 'week_pct' never carries US$. */
  costUnit: AiUsageCostUnit | null;
  aiEnabled: boolean;
  /** ai_cost_total, ai_cost_per_pr (unit = costUnit). */
  comparisons: AdoptionComparison[];
  /** ⚠ Null when the usage records could not be read for that window: unknown, never zero. */
  runs: { before: number | null; after: number | null };
  tokens: { before: number | null; after: number | null };
  /** Runs tied to no repo (counted in every workspace): left out of the figures, disclosed. Null = unknown. */
  machineWideRuns: number | null;
  /** Review-bot seat prices as entered (US$ per month), in this workspace. */
  seats: { label: string; monthlyUsd: number }[];
  seatsMonthlyUsd: number | null;
}

export interface AiAdoptionReport {
  schemaVersion: typeof AI_ADOPTION_REPORT_SCHEMA_VERSION;
  workspaceId: number;
  workspaceName: string;
  /** Also the commentary route's memo key: send it back on every commentary request. */
  generatedAt: string;
  /** The workspace's ONE reporting window (the "after"). */
  window: ReportingWindowInfo;
  after: AdoptionSpan;
  /** The equal-length span just before `after`. */
  before: AdoptionSpan;
  /** Repos measured (tracked since before.from) of the workspace's repos. */
  repos: { measured: number; total: number };
  detection: AdoptionDetectionCoverage;
  /** Setting changes between the first trend period's start and after.to, oldest first. */
  markers: AdoptionSettingMarker[];
  /** Setting history exists only from here on; null when none recorded. */
  settingHistoryFrom: string | null;
  /** 3–5 comparisons (fewer when fewer are significant), significant first. */
  summary: { headlines: AdoptionComparison[]; significantCount: number };
  adoption: AdoptionTrendSlide;
  people: AdoptionPeopleSlide;
  delivery: AdoptionDeliverySlide;
  courts: AdoptionCourtsSlide;
  reviewBots: AdoptionReviewBotsSlide;
  guardrails: AdoptionGuardrailsSlide;
  cost: AdoptionCostSlide;
}

// ── Slides and commentary wire ──────────────────────────────────────────────────────────────────

/** Every slide, in deck order. 'people' may continue over several pages; 'method' is fixed text. */
export type AdoptionSlideId =
  | 'title'
  | 'summary'
  | 'adoption'
  | 'people'
  | 'delivery'
  | 'courts'
  | 'review_bots'
  | 'guardrails'
  | 'cost'
  | 'method';

export const ADOPTION_SLIDES: readonly AdoptionSlideId[] = [
  'title',
  'summary',
  'adoption',
  'people',
  'delivery',
  'courts',
  'review_bots',
  'guardrails',
  'cost',
  'method',
];

/** The slides that carry commentary (written by AI or by template). */
export type AdoptionCommentarySlide = Exclude<AdoptionSlideId, 'title' | 'method'>;

export const ADOPTION_COMMENTARY_SLIDES: readonly AdoptionCommentarySlide[] = [
  'summary',
  'adoption',
  'people',
  'delivery',
  'courts',
  'review_bots',
  'guardrails',
  'cost',
];

export const ADOPTION_SLIDE_TITLE: Readonly<Record<AdoptionSlideId, string>> = {
  title: 'AI adoption report',
  summary: 'Summary',
  adoption: 'AI adoption',
  people: 'How widely AI is used',
  delivery: 'Delivery flow',
  courts: 'Where the time goes',
  review_bots: 'AI review',
  guardrails: 'Guardrails',
  cost: 'Cost',
  method: 'Method and limits',
};

/** POST /api/reports/ai-adoption/commentary. */
export interface AdoptionCommentaryRequest {
  workspaceId: number;
  slide: AdoptionCommentarySlide;
  /** The report's `generatedAt`, so the server reads the same figures the PDF shows. */
  generatedAt: string;
}

export type AdoptionCommentaryResponse =
  | {
      slide: AdoptionCommentarySlide;
      source: 'ai';
      /** Validated text with `{{key}}` placeholders. The client fills it (`fillCommentary`). */
      template: string;
      provider: AiProviderId;
      model: string;
      /** The run's cost in US$ as recorded (word it only through the SPA's run-cost formatter). */
      costUsd: number | null;
    }
  | {
      slide: AdoptionCommentarySlide;
      source: 'fallback';
      /** rejected: the model's text broke a rule; failed: the call failed; nothing_to_say: no usable
       *  figure; stale: the server no longer holds this report's figures (no call was made). */
      reason: 'rejected' | 'failed' | 'nothing_to_say' | 'stale';
    };

// ── Formatting (code's numbers) ─────────────────────────────────────────────────────────────────

/** Turns an available figure into words. The SPA may inject its own cost wording (usageCostText)
 *  for 'usd' / 'week_pct'; everything else uses `formatAdoptionFigure`. */
export type AdoptionFigureFormatter = (f: AvailableAdoptionFigure) => string;

const round1 = (v: number): string => (Math.round(v * 10) / 10).toLocaleString('en-GB');
const whole = (v: number): string => Math.round(v).toLocaleString('en-GB');
const plural = (n: string, one: string, many: string): string => `${n} ${n === '1' ? one : many}`;

/** The default wording of a figure. Pure. */
export function formatAdoptionFigure(f: AvailableAdoptionFigure): string {
  const v = f.value;
  switch (f.unit) {
    case 'count':
      return whole(v);
    case 'pct':
      // Never round a share to "none" or "all" when it is neither.
      if (v > 0 && v < 1) return 'under 1%';
      if (v >= 99.5 && v < 100) return 'over 99%';
      return `${whole(v)}%`;
    case 'hours':
      if (v < 1) return plural(whole(v * 60), 'minute', 'minutes');
      if (v < 48) return plural(round1(v), 'hour', 'hours');
      return plural(round1(v / 24), 'day', 'days');
    case 'lines':
      return plural(whole(v), 'line', 'lines');
    case 'ratio':
      return round1(v);
    case 'usd':
      if (v > 0 && v < 0.01) return 'under US$0.01';
      return v < 100 ? `US$${v.toFixed(2)}` : `US$${whole(v)}`;
    case 'week_pct':
      if (v > 0 && v < 0.1) return 'under 0.1% of a week';
      return `${v < 10 ? round1(v) : whole(v)}% of a week`;
  }
}

/** "up 4 points" / "down 12%" / "unchanged" / "up from none". Null when either side is withheld. */
export function formatAdoptionChange(c: AdoptionComparison): string | null {
  if (!c.before.available || !c.after.available) return null;
  const b = c.before.value;
  const a = c.after.value;
  const d = a - b;
  if (c.after.unit === 'pct') {
    const pts = Math.round(Math.abs(d));
    if (pts === 0) return 'unchanged';
    return `${d > 0 ? 'up' : 'down'} ${plural(String(pts), 'point', 'points')}`;
  }
  if (b === 0) return a === 0 ? 'unchanged' : 'up from none';
  const rel = Math.round((Math.abs(d) / Math.abs(b)) * 100);
  if (rel === 0) return 'unchanged';
  return `${d > 0 ? 'up' : 'down'} ${rel}%`;
}

// ── The figure table (what the model may name, and what code substitutes) ───────────────────────

/** One placeholder the commentary may use. `text` is code's words for it; null when withheld. */
export interface CommentaryFigure {
  /** `{{key}}` — lowercase letters, `_` and `.` only. */
  key: string;
  label: string;
  text: string | null;
  /** May the commentary name it? False when withheld, or for a `.change` that is not significant. */
  usable: boolean;
}

export const COMMENTARY_KEY_RE = /^[a-z_]+(?:\.[a-z_]+)*$/;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function figureEntry(key: string, label: string, f: AdoptionFigure, fmt: AdoptionFigureFormatter): CommentaryFigure {
  return f.available ? { key, label, text: fmt(f), usable: true } : { key, label, text: null, usable: false };
}

function textEntry(key: string, label: string, text: string): CommentaryFigure {
  return { key, label, text, usable: true };
}

function countEntry(key: string, label: string, n: number): CommentaryFigure {
  return textEntry(key, label, whole(n));
}

/** A count that may be unknown: null is NOT usable (never "0"). */
function maybeCountEntry(key: string, label: string, n: number | null): CommentaryFigure {
  return n == null ? { key, label, text: null, usable: false } : countEntry(key, label, n);
}

function comparisonEntries(c: AdoptionComparison, fmt: AdoptionFigureFormatter): CommentaryFigure[] {
  const label = ADOPTION_COMPARISON_LABEL[c.key];
  const change = formatAdoptionChange(c);
  return [
    figureEntry(`${c.key}.before`, `${label}, before`, c.before, fmt),
    figureEntry(`${c.key}.after`, `${label}, this period`, c.after, fmt),
    {
      key: `${c.key}.change`,
      label: `${label}, change (significant: ${c.significant ? 'yes' : 'no'})`,
      text: change,
      usable: change != null && c.significant,
    },
    countEntry(`${c.key}.sample`, `${label}, sample size this period`, c.after.sampleSize),
  ];
}

const pick = (cs: readonly AdoptionComparison[], key: AdoptionComparisonKey): AdoptionComparison | undefined =>
  cs.find((c) => c.key === key);

/**
 * The figure table for one slide: every placeholder the commentary may use, with code's words. The
 * server sends `label` + `text` + `usable` to the model; the client fills with `text`. Both build it
 * from the SAME report, so keys agree. ⚠ Never a person's name or login. Pure.
 */
export function commentaryFigures(
  r: AiAdoptionReport,
  slide: AdoptionCommentarySlide,
  fmt: AdoptionFigureFormatter = formatAdoptionFigure,
): CommentaryFigure[] {
  const out: CommentaryFigure[] = [
    textEntry('period.after', 'The report period, as a phrase', reportingWindowPhrase(r.window)),
    textEntry('period.before', 'The period before it, as a phrase', `in the ${round1(r.before.days)} days before`),
  ];
  const add = (...e: CommentaryFigure[]) => out.push(...e);
  switch (slide) {
    case 'summary':
      for (const c of r.summary.headlines) add(...comparisonEntries(c, fmt));
      break;
    case 'adoption': {
      add(...comparisonEntries(r.adoption.aiShare, fmt));
      if (r.detection.scannedPct != null) add(textEntry('detection.scanned', 'Share of merged PRs scanned for AI signals', `${whole(r.detection.scannedPct)}%`));
      for (const v of r.adoption.vendors) {
        const name = AI_CODING_VENDOR_LABEL[v.vendor];
        add(figureEntry(`vendor.${v.vendor}.prs`, `${name}: PRs this period`, v.after, fmt));
        add(figureEntry(`vendor.${v.vendor}.share`, `${name}: share of merged PRs this period`, v.afterShare, fmt));
      }
      for (const s of r.adoption.sources) {
        if (s.prs > 0) add(countEntry(`source.${s.source}.prs`, `PRs where AI was seen in: ${AI_SIGNAL_SOURCE_LABEL[s.source]}`, s.prs));
      }
      break;
    }
    case 'people': {
      add(...comparisonEntries(r.people.peopleUsingAi, fmt));
      add(countEntry('people.total', 'People who merged a PR this period', r.people.peopleWithMergedPrs));
      add(figureEntry('people.share', 'Share of those people who merged a PR with AI involved', r.people.peopleShare, fmt));
      if (r.people.withheld == null) {
        for (const v of r.people.vendors) {
          add(figureEntry(`vendor.${v.vendor}.people`, `${AI_CODING_VENDOR_LABEL[v.vendor]}: people using it this period`, v.people, fmt));
        }
        if (r.people.agentPrs != null) add(countEntry('agent.prs', 'PRs opened by an AI coding agent with no person named', r.people.agentPrs.mergedPrs));
      }
      break;
    }
    case 'delivery': {
      for (const c of r.delivery.comparisons) add(...comparisonEntries(c, fmt));
      const s = r.delivery.aiVsOther;
      if (s != null) {
        for (const [side, label] of [['ai', 'PRs with AI involved'], ['other', 'Other PRs']] as const) {
          const v = s[side];
          add(countEntry(`split.${side}.prs`, `${label}: count this period`, v.prs));
          add(figureEntry(`split.${side}.lead_time`, `${label}: median lead time`, v.leadTimeHours, fmt));
          add(figureEntry(`split.${side}.pr_size`, `${label}: median size`, v.prSizeLines, fmt));
          add(figureEntry(`split.${side}.ci_pass`, `${label}: CI passing at merge`, v.ciPassPct, fmt));
          add(figureEntry(`split.${side}.human_review`, `${label}: approved by a person`, v.humanReviewCoveragePct, fmt));
        }
      }
      break;
    }
    case 'courts':
      for (const c of r.courts.comparisons) add(...comparisonEntries(c, fmt));
      add(maybeCountEntry('courts.measured.before', 'PRs measured, before', r.courts.measuredPrs.before));
      add(maybeCountEntry('courts.measured.after', 'PRs measured, this period', r.courts.measuredPrs.after));
      break;
    case 'review_bots': {
      add(...comparisonEntries(r.reviewBots.ensembleActedOn, fmt));
      r.reviewBots.bots.forEach((b, i) => {
        const id = LETTERS.charAt(i);
        if (id === '') return;
        add(textEntry(`bot.${id}.name`, `Review bot ${id.toUpperCase()}: its name`, b.label));
        add(figureEntry(`bot.${id}.comments_per_pr`, `Review bot ${id.toUpperCase()}: comments per merged PR`, b.commentsPerPr, fmt));
        add(figureEntry(`bot.${id}.acted_on`, `Review bot ${id.toUpperCase()}: share of its threads acted on`, b.actedOnPct, fmt));
        add(figureEntry(`bot.${id}.cost_per_acted_on`, `Review bot ${id.toUpperCase()}: seat price per thread acted on`, b.costPerActedOnUsd, fmt));
      });
      break;
    }
    case 'guardrails':
      for (const c of r.guardrails.comparisons) add(...comparisonEntries(c, fmt));
      break;
    case 'cost':
      for (const c of r.cost.comparisons) add(...comparisonEntries(c, fmt));
      add(maybeCountEntry('cost.runs.after', 'Ensemble AI runs this period', r.cost.runs.after));
      if (r.cost.seatsMonthlyUsd != null) {
        add(figureEntry('seats.monthly', 'Review bot seat prices as entered, per month', { available: true, value: r.cost.seatsMonthlyUsd, unit: 'usd', sampleSize: r.cost.seats.length }, fmt));
      }
      break;
  }
  return out;
}

// ── The grounding gate ──────────────────────────────────────────────────────────────────────────

/** The D4 digit gate: no ASCII digit and no other Unicode numeral ('٣', '³', 'Ⅻ'). */
export const COMMENTARY_NO_NUMERALS = /^[^\p{Nd}\p{No}\p{Nl}]*$/u;
const MARKUP = /[`*_#<>[\]|~]|https?:\/\/|www\./i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const PLACEHOLDER = /\{\{([^{}]{1,80})\}\}/g;
/** Before/after is not proof of cause: the commentary may not claim one. */
const CAUSAL = /\b(?:caus(?:e|ed|es|ing)|thanks to|because of|due to|prov(?:e|es|ed|en)|led to|result(?:ed|s)? in|driven by)\b/i;

/**
 * Number WORDS and multiplying words: a quantity no code computed ("double the share", "three times
 * as many", "half of the team"). Case-blind, whole words. ⚠ "one" is in: "one in five" is a figure.
 */
const NUMBER_WORDS =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|half|halves|halved|halving|thirds?|quarters?|double|doubled|doubles|doubling|triple|tripled|triples|tripling|quadrupled?|twice|thrice|percent|per cent|percentage points?|(?:two|three|four|five|ten|many|several)?-?fold)\b|[×%]/i;

/**
 * Words that say a figure MOVED. Refused in a sentence that names a comparison whose `.change` is not
 * usable (not significant) while its before and after are: the figures may be shown side by side,
 * never narrated as a move.
 */
const MOVEMENT_WORDS =
  /\b(?:ris(?:e|es|en|ing)|rose|f[ae]ll(?:s|en|ing)?|gr[eo]w(?:s|n|ing)?|growth|drop(?:s|ped|ping)?|jump(?:s|ed|ing)?|climb(?:s|ed|ing)?|declin(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|surg(?:e|es|ed|ing)|halved|improv(?:e|es|ed|ing|ement)|worsen(?:s|ed|ing)?|shrank|shrunk|shrink(?:s|ing)?|went (?:up|down)|up from|down from)\b/i;

/** Comparisons (`<key>`) whose before and after are usable but whose change is not. */
function unnarratableComparisons(figures: readonly CommentaryFigure[]): Set<string> {
  const usable = new Set(figures.filter((f) => f.usable).map((f) => f.key));
  const out = new Set<string>();
  for (const f of figures) {
    if (!f.key.endsWith('.change') || f.usable) continue;
    const base = f.key.slice(0, -'.change'.length);
    if (usable.has(`${base}.before`) && usable.has(`${base}.after`)) out.add(base);
  }
  return out;
}

export const COMMENTARY_LIMITS = { minSentences: 1, maxSentences: 4, maxChars: 600 } as const;

export type CommentaryValidation = { ok: true; template: string } | { ok: false; problems: string[] };

/**
 * Validate the model's commentary for one slide against that slide's figure table. Never repaired
 * beyond trimming and folding whitespace (and one pair of wrapping quotes): any broken rule refuses
 * the whole text, and the slide uses `fallbackCommentary`. Pure.
 */
export function validateCommentary(raw: string, figures: readonly CommentaryFigure[]): CommentaryValidation {
  const problems: string[] = [];
  let text = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (/^(["'“‘]).*(["'”’])$/.test(text)) text = text.slice(1, -1).trim();
  if (text === '') return { ok: false, problems: ['The text is empty.'] };
  if (text.length > COMMENTARY_LIMITS.maxChars) problems.push(`The text is ${text.length} characters; keep it to ${COMMENTARY_LIMITS.maxChars}.`);

  const byKey = new Map(figures.map((f) => [f.key, f]));
  let used = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const key = m[1]!.trim();
    const f = byKey.get(key);
    if (f == null || !COMMENTARY_KEY_RE.test(key)) problems.push(`"{{${key}}}" is not a figure on this slide.`);
    else if (!f.usable) problems.push(`"{{${key}}}" has no figure to show (withheld, or not a significant change).`);
    else used++;
  }
  const rest = text.replace(PLACEHOLDER, ' ');
  if (/[{}]/.test(rest)) problems.push('A placeholder is malformed: write it as {{key}}.');
  if (used === 0) problems.push('Name at least one figure with a placeholder.');
  if (!COMMENTARY_NO_NUMERALS.test(rest)) problems.push('The text contains a digit or numeral. Every number must be a placeholder.');
  if (NUMBER_WORDS.test(rest)) problems.push('The text states a quantity in words (such as "three", "half" or "twice"). Every number must be a placeholder.');
  const still = unnarratableComparisons(figures);
  if (still.size > 0) {
    for (const sentence of text.split(/[.!?](?:\s|$)/)) {
      const named = [...sentence.matchAll(PLACEHOLDER)].map((m) => m[1]!.trim().replace(/\.(?:before|after)$/, ''));
      if (!named.some((k) => still.has(k))) continue;
      if (MOVEMENT_WORDS.test(sentence.replace(PLACEHOLDER, ' '))) {
        problems.push('A change that is not clear is described as a move. Show the two figures side by side instead.');
        break;
      }
    }
  }
  if (MARKUP.test(rest)) problems.push('Plain text only: no Markdown, HTML or links.');
  if (rest.includes('@')) problems.push('Do not name accounts or handles.');
  if (CAUSAL.test(rest)) problems.push('Do not claim a cause: a before-and-after comparison does not show one.');
  const sentences = text.split(/[.!?](?:\s|$)/).filter((s) => s.trim() !== '').length;
  if (sentences < COMMENTARY_LIMITS.minSentences || sentences > COMMENTARY_LIMITS.maxSentences) {
    problems.push(`Write ${COMMENTARY_LIMITS.minSentences} to ${COMMENTARY_LIMITS.maxSentences} sentences; this is ${sentences}.`);
  }
  return problems.length === 0 ? { ok: true, template: text } : { ok: false, problems };
}

/** Substitute code's words for every placeholder. A key with no text (never after validation) becomes
 *  "—". Pure. */
export function fillCommentary(template: string, figures: readonly CommentaryFigure[]): string {
  const byKey = new Map(figures.map((f) => [f.key, f]));
  return template.replace(PLACEHOLDER, (_m, k: string) => byKey.get(k.trim())?.text ?? '—');
}

// ── The fallback (deterministic, the same sentences with AI on or off) ──────────────────────────

/** One candidate sentence: used only when every key it names is usable. */
type Candidate = readonly [keys: readonly string[], template: string];

const NOTHING_TO_SAY = 'There is not enough data in this period to say more.';

/** The first candidate whose keys are all usable, or null. */
function firstHit(usable: ReadonlySet<string>, candidates: readonly Candidate[]): string | null {
  return candidates.find(([keys]) => keys.every((k) => usable.has(k)))?.[1] ?? null;
}

/** A comparison in one sentence, the most specific form its usable keys allow. */
function comparisonCandidates(key: AdoptionComparisonKey): Candidate[] {
  const label = ADOPTION_COMPARISON_LABEL[key];
  return [
    [[`${key}.before`, `${key}.after`, `${key}.change`], `${label}: {{${key}.after}} {{period.after}}, against {{${key}.before}} before ({{${key}.change}}).`],
    [[`${key}.before`, `${key}.after`], `${label}: {{${key}.after}} {{period.after}}, against {{${key}.before}} before; not a clear change.`],
    [[`${key}.after`], `${label}: {{${key}.after}} {{period.after}}.`],
  ];
}

/**
 * The template commentary for one slide (placeholders; fill with `fillCommentary`). Used with AI off,
 * with no credential, and for any slide whose model text failed or was rejected. Pure.
 */
export function fallbackCommentary(
  r: AiAdoptionReport,
  slide: AdoptionCommentarySlide,
  fmt: AdoptionFigureFormatter = formatAdoptionFigure,
): string {
  const usable = new Set(commentaryFigures(r, slide, fmt).filter((f) => f.usable).map((f) => f.key));
  const out: string[] = [];
  const one = (...candidates: Candidate[]) => {
    const hit = firstHit(usable, candidates);
    if (hit != null) out.push(hit);
  };
  const cmp = (key: AdoptionComparisonKey) => one(...comparisonCandidates(key));
  switch (slide) {
    case 'summary':
      for (const c of r.summary.headlines.slice(0, 4)) cmp(c.key);
      break;
    case 'adoption': {
      cmp('ai_share');
      let top: AdoptionVendorTotal | null = null;
      for (const v of r.adoption.vendors) {
        if (!v.after.available || v.after.value <= 0) continue;
        if (top == null || (top.after.available && v.after.value > top.after.value)) top = v;
      }
      if (top != null) one([[`vendor.${top.vendor}.prs`], `${AI_CODING_VENDOR_LABEL[top.vendor]} was involved in the most PRs: {{vendor.${top.vendor}.prs}}.`]);
      one([['detection.scanned'], 'Only declared AI use is counted; {{detection.scanned}} of merged PRs have been scanned.']);
      break;
    }
    case 'people':
      one(
        [['people_using_ai.after', 'people.total', 'people_using_ai.before'], '{{people_using_ai.after}} of {{people.total}} people merged a PR with AI involved {{period.after}}, against {{people_using_ai.before}} before.'],
        [['people_using_ai.after', 'people.total'], '{{people_using_ai.after}} of {{people.total}} people merged a PR with AI involved {{period.after}}.'],
      );
      {
        // The tool most people used, when its count is shown and no other tool ties it.
        const n = (v: AdoptionPeopleVendor): number => (v.people.available ? v.people.value : 0);
        const ranked = r.people.vendors.filter((v) => n(v) > 0).sort((x, y) => n(y) - n(x));
        const top = ranked[0];
        if (top != null && (ranked[1] == null || n(ranked[1]) < n(top))) {
          one([[`vendor.${top.vendor}.people`], `${AI_CODING_VENDOR_LABEL[top.vendor]} was the most widely used tool, by {{vendor.${top.vendor}.people}} people.`]);
        }
      }
      one([['agent.prs'], 'PRs opened by an AI coding agent with no person named: {{agent.prs}}.']);
      break;
    case 'delivery':
      one(
        [['split.ai.lead_time', 'split.other.lead_time', 'split.ai.pr_size', 'split.other.pr_size'], 'PRs with AI involved had a median lead time of {{split.ai.lead_time}}, against {{split.other.lead_time}} for other PRs, and a median size of {{split.ai.pr_size}}, against {{split.other.pr_size}}.'],
        [['split.ai.lead_time', 'split.other.lead_time'], 'PRs with AI involved had a median lead time of {{split.ai.lead_time}}, against {{split.other.lead_time}} for other PRs.'],
        [['split.ai.pr_size', 'split.other.pr_size'], 'PRs with AI involved had a median size of {{split.ai.pr_size}}, against {{split.other.pr_size}} for other PRs.'],
      );
      cmp('lead_time');
      if (out.length < 3) cmp('first_review');
      break;
    case 'courts':
      cmp('court_reviewer');
      cmp('court_author');
      cmp('court_landing');
      break;
    case 'review_bots':
      one([['bot.a.name', 'bot.a.acted_on'], 'People acted on {{bot.a.acted_on}} of the threads {{bot.a.name}} opened.']);
      one([['bot.b.name', 'bot.b.acted_on'], 'For {{bot.b.name}} it was {{bot.b.acted_on}}.']);
      one([['ensemble_acted_on.after'], "People acted on {{ensemble_acted_on.after}} of Ensemble's findings {{period.after}}."]);
      break;
    case 'guardrails':
      cmp('human_review_coverage');
      cmp('ai_human_review_coverage');
      cmp('ci_pass');
      break;
    case 'cost':
      one([['ai_cost_per_pr.after'], "Ensemble's AI spend came to {{ai_cost_per_pr.after}} per merged PR {{period.after}}."]);
      one([['ai_cost_total.after', 'cost.runs.after'], 'Ensemble AI runs {{period.after}}: {{cost.runs.after}}, costing {{ai_cost_total.after}} in all.']);
      one([['seats.monthly'], 'Review bot seats, as entered, cost {{seats.monthly}} a month.']);
      break;
  }
  return out.length > 0 ? out.slice(0, 4).join(' ') : NOTHING_TO_SAY;
}

// ── Small helpers both sides use ────────────────────────────────────────────────────────────────

/** The comparison with this key on a list, if present. */
export const adoptionComparison = pick;

/** A withheld figure. */
export function withheldFigure(unit: AdoptionReportUnit, reason: AdoptionWithheldReason, sampleSize = 0): AdoptionFigure {
  return { available: false, unit, sampleSize, reason };
}

/** An available figure. */
export function adoptionFigure(value: number, unit: AdoptionReportUnit, sampleSize: number): AdoptionFigure {
  return { available: true, value, unit, sampleSize };
}

/** The reason in words, for a "—" cell's note and the method slide. */
export const ADOPTION_WITHHELD_TEXT: Readonly<Record<AdoptionWithheldReason, string>> = {
  no_data: 'No data',
  low_sample: 'Too few to show',
  detection_incomplete: 'Still scanning for AI use',
  no_price: 'No price entered',
  no_cost_unit: 'No cost known',
  ai_off: 'AI is off',
  partial_coverage: 'Repos not tracked yet',
  few_people: 'Fewer than 3',
};
