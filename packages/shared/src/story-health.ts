// REPORTS → STORIES → STORY HEALTH — the wire contract for `GET /api/story-health` and the label run
// (`/api/story-health/label*`). docs/API.md § Story health, docs/FRONTEND.md § Story health.
//
// Thirteen weeks (Monday 00:00 in the workspace's WORKING time zone, `localWeeksEndingAt`), two
// panels on one x axis:
//
//   • REFINEMENT — how stories were WRITTEN, each story in the week its ticket was CREATED
//     (`tracker_tickets.issue_created_at`; a ticket with no created date falls back to the week its
//     first pull request was opened, and the response says how many fell back).
//   • DELIVERY — how stories LANDED, each story in the week of its LAST merge.
//
// Pro with the rest of Reports (`periodReports`): the GET 402s before any DB work.
//
// ⚠ "LAST 90 DAYS" IS A FIXED, LABELLED SPAN — it follows no window picker and no reporting window
// (the same labelled-exception rule as Chronology's "Over time"). The SPA prints `STORY_HEALTH_SPAN_LABEL`.
//
// ⚠ TWO KINDS OF MEASURE, LABELLED APART. `source: 'code'` series are computed from the ticket text
// and the merged pull requests by deterministic code. `source: 'label'` series come from STORED
// model labels (`story_labels`, Haiku 5.5 over a FIXED rubric, `STORY_RUBRIC_VERSION`). Labels are
// made only by the local agentic run (POST /api/story-health/label, `registerAgenticRoutes`), so in
// cloud — or with `LIMN_AI_DISABLED=true` — the server OMITS every label series (`labels: false`) and
// only code measures render. A label series is never drawn from a partial guess: a week's value is
// over the stories that HAVE a current label, and the coverage (`labelled` of `labellable`) rides
// every week.
//
// ⚠ A RUBRIC CHANGE IS A NEW METRIC. `STORY_RUBRIC_VERSION` is folded into a label's identity
// (unique `(account_id, ident, rubric_version, text_hash)`), so a bump relabels from scratch and old
// rows stop counting. A label is never redefined in place: a changed question gets a NEW series id.
//
// ⚠ UNKNOWN IS NEVER ZERO: a week with no measurable items carries `value: null` (a gap), and a
// story whose size is unknown is left out of the size-band lines and COUNTED (`unsizedStories`).

// ── Constants (the ONE spelling the folds and the page's copy both read) ───────────────────────────

/** The labelling rubric's version. Bump = every story is relabelled; never redefine a label in place. */
export const STORY_RUBRIC_VERSION = 1;

/** Weeks on the chart, the current (partial) week included. 13 × 7 = 91 days ≈ "Last 90 days". */
export const STORY_HEALTH_WEEKS = 13;

/** The span's label, printed beside the heading ("Story health · Last 90 days"). */
export const STORY_HEALTH_SPAN_LABEL = 'Last 90 days';

/** A week whose series has fewer items (`n`) than this is THIN: drawn faint, left out of the rolling
 *  line and of the time / count shift test (a rate shift pools every week's units). */
export const STORY_HEALTH_THIN_N = 3;

/** Weeks the rolling line pools (the week itself and the three before it), non-thin weeks only. */
export const STORY_HEALTH_ROLLING_WEEKS = 4;

// ── The shift rule (the ONE spelling db/story-health-fold.ts tests against and the ⓘ prints) ──────
//
// RATE series (every refinement series, and criteria met) are tested on POOLED COUNTS, never on
// weekly percentages: for each split week, the units before and after are summed and compared with a
// two-proportion z-test. The units are STORIES for a story-weighted series and CRITERIA for a
// criterion-weighted one (criteria met is criterion-weighted too: met ÷ judged). TIME and COUNT
// series run `detectChangepoints` over the server's ROLLING values of non-thin weeks, and must also
// move by a minimum amount.

/** Rate series: stories needed on EACH side of a split (criterion-weighted series too: stories decide
 *  the floor; the test then counts criteria). */
export const STORY_SHIFT_MIN_STORIES = 15;

/** Rate series: the pooled shares must differ by at least this many percentage points. */
export const STORY_SHIFT_MIN_POINTS = 10;

/** Rate series: |z| of the two-proportion test must reach this (p < 0.01, two-sided). */
export const STORY_SHIFT_Z = 2.58;

/** Time series: the medians of the rolling values each side must differ by at least this many
 *  working hours. */
export const STORY_SHIFT_MIN_HOURS = 8;

/** Count series (pull requests per story): the medians must differ by at least this much. */
export const STORY_SHIFT_MIN_PRS = 1;

/** Size bands for the delivery lines, on Σ(additions + deletions) over the story's MERGED pull
 *  requests (`StoryRow.linesChanged`). S < 300 · M 300–1499 · L ≥ 1500. Unknown size → no band. */
export const STORY_SIZE_BANDS = {
  /** Lines changed below this → S. */
  mediumFrom: 300,
  /** Lines changed at or above this → L; between → M. */
  largeFrom: 1500,
} as const;

export type StorySizeBand = 'S' | 'M' | 'L';

/** The ONE band fold (server and copy). null size → null band (left out and counted, never S). */
export function storySizeBand(linesChanged: number | null): StorySizeBand | null {
  if (linesChanged == null || !Number.isFinite(linesChanged)) return null;
  if (linesChanged < STORY_SIZE_BANDS.mediumFrom) return 'S';
  if (linesChanged < STORY_SIZE_BANDS.largeFrom) return 'M';
  return 'L';
}

/** The labeller's model — Haiku 5.5 through the core cheap seam (`review/llm.ts` `cheapComplete`). */
export const STORY_LABEL_MODEL = 'claude-haiku-5-5';

/** Stories one label run will label at most (the rest wait for the next press). */
export const STORY_LABEL_RUN_CAP = 150;

/** Labelling calls in flight at once within one run. */
export const STORY_LABEL_CONCURRENCY = 4;

/** Default per-run spending cap (US$); the server's config may override it. The run stops — never
 *  overspends — once its recorded cost reaches the cap. */
export const STORY_LABEL_BUDGET_USD_DEFAULT = 1;

/** The labeller's MEASURED run-to-run noise on a weekly percentage (40 stories × 2 runs, the
 *  prototype): median 2–4 points, 90th percentile 7–12. The ⓘ quotes `typicalPoints`. */
export const STORY_LABEL_NOISE = {
  typicalPoints: 4,
  p90Points: 12,
} as const;

// ── The model's labels (what `story_labels` stores; shared so both halves name the fields once) ────

/** Per numbered criterion, in order (`criteria_json`). */
export interface StoryCriterionLabel {
  /** 1-based, = the criterion's position in `extractCriteria(...)`. */
  n: number;
  testable: boolean;
  bundled: boolean;
  dependsOnOtherWork: boolean;
}

/** Per story (`story_json`). `userValueStated` is NOT here — it is CODE (`db/story-user-value.ts`). */
export interface StoryLevelLabels {
  outOfScopeStated: boolean;
  dependencyNamed: boolean;
  nonCodeWork: boolean;
}

// ── Series metadata ────────────────────────────────────────────────────────────────────────────────

export type StoryHealthPanel = 'refinement' | 'delivery';

export type StoryHealthSeriesId =
  // REFINEMENT — label, criterion-weighted (over every criterion of the week's labelled stories)
  | 'criteriaTestable'
  | 'criteriaBundled'
  | 'criteriaDependent'
  // REFINEMENT — code, story-weighted (over every story created that week)
  | 'criteriaInField'
  | 'userValueStated'
  // REFINEMENT — label, story-weighted (over the week's labelled stories)
  | 'outOfScopeStated'
  | 'dependencyNamed'
  | 'nonCodeWork'
  // DELIVERY — code (stories by last-merge week)
  | 'workingTimeS'
  | 'workingTimeM'
  | 'workingTimeL'
  | 'prsPerStory'
  | 'criteriaMet';

/** `pct` = 0–100; `hours` = median working hours; `count` = a median count. */
export type StoryHealthUnit = 'pct' | 'hours' | 'count';

export interface StoryHealthSeriesMeta {
  id: StoryHealthSeriesId;
  panel: StoryHealthPanel;
  /** Legend text, plain English. */
  label: string;
  /** `label` = stored model labels (omitted from the response when `labels: false`); `code` = deterministic. */
  source: 'label' | 'code';
  unit: StoryHealthUnit;
  /** What each week's value is computed over: `criteria` = criterion-weighted (n is still the number of
   *  STORIES, which decides thinness); `stories` = story-weighted; `reviewed` = reviewed stories only. */
  over: 'criteria' | 'stories' | 'reviewed';
  /** Which way is better, for colouring a DETECTED shift only. null = neither (no green/red ever). */
  better: 'higher' | 'lower' | null;
  /** TIME / COUNT series only (rate series are tested on pooled counts): the floor for the change-point
   *  scale (`detectChangepoints`' `minScale`) and the smallest before/after change that may be
   *  reported (`STORY_SHIFT_MIN_HOURS` / `STORY_SHIFT_MIN_PRS`), in the series' unit. */
  minScale?: number;
  minShift?: number;
  /** Drawn dotted (criteria met: a reviewed subset with its own n). */
  dotted?: boolean;
}

/** The change-point bar for TIME / COUNT series: a step of at least this many robust SDs (sigma
 *  floored at the series' `minScale`). The ONE spelling — backend db/changepoint.ts re-exports it as
 *  `CHANGEPOINT_Z`, and the Before-and-after ⓘ prints it, so the copy cannot drift from the test. */
export const CHANGEPOINT_Z = 3;

/** Every series, in legend order. The server sends values for these ids; the SPA reads labels here. */
export const STORY_HEALTH_SERIES: readonly StoryHealthSeriesMeta[] = [
  { id: 'criteriaTestable', panel: 'refinement', label: 'Criteria a tester could check', source: 'label', unit: 'pct', over: 'criteria', better: 'higher' },
  { id: 'criteriaBundled', panel: 'refinement', label: 'Criteria holding more than one outcome', source: 'label', unit: 'pct', over: 'criteria', better: 'lower' },
  { id: 'criteriaDependent', panel: 'refinement', label: 'Criteria waiting on other work', source: 'label', unit: 'pct', over: 'criteria', better: 'lower' },
  { id: 'criteriaInField', panel: 'refinement', label: 'Stories with criteria in the criteria field', source: 'code', unit: 'pct', over: 'stories', better: 'higher' },
  { id: 'userValueStated', panel: 'refinement', label: 'Stories saying who benefits and why', source: 'code', unit: 'pct', over: 'stories', better: 'higher' },
  { id: 'outOfScopeStated', panel: 'refinement', label: 'Stories saying what is out of scope', source: 'label', unit: 'pct', over: 'stories', better: 'higher' },
  { id: 'dependencyNamed', panel: 'refinement', label: 'Stories naming a dependency', source: 'label', unit: 'pct', over: 'stories', better: null },
  { id: 'nonCodeWork', panel: 'refinement', label: 'Stories with work code cannot show', source: 'label', unit: 'pct', over: 'stories', better: 'lower' },
  { id: 'workingTimeS', panel: 'delivery', label: 'Working time, small stories', source: 'code', unit: 'hours', over: 'stories', better: 'lower', minScale: 1, minShift: STORY_SHIFT_MIN_HOURS },
  { id: 'workingTimeM', panel: 'delivery', label: 'Working time, medium stories', source: 'code', unit: 'hours', over: 'stories', better: 'lower', minScale: 1, minShift: STORY_SHIFT_MIN_HOURS },
  { id: 'workingTimeL', panel: 'delivery', label: 'Working time, large stories', source: 'code', unit: 'hours', over: 'stories', better: 'lower', minScale: 1, minShift: STORY_SHIFT_MIN_HOURS },
  { id: 'prsPerStory', panel: 'delivery', label: 'Pull requests per story', source: 'code', unit: 'count', over: 'stories', better: null, minScale: 0.5, minShift: STORY_SHIFT_MIN_PRS },
  { id: 'criteriaMet', panel: 'delivery', label: 'Criteria met (reviewed stories)', source: 'code', unit: 'pct', over: 'reviewed', better: 'higher', dotted: true },
];

export const STORY_HEALTH_SERIES_BY_ID: Readonly<Record<StoryHealthSeriesId, StoryHealthSeriesMeta>> =
  Object.fromEntries(STORY_HEALTH_SERIES.map((s) => [s.id, s])) as Record<StoryHealthSeriesId, StoryHealthSeriesMeta>;

/** The labeller's measured agreement with itself (Cohen's κ, two runs over 40 stories / 388
 *  criteria) per label series — for the ⓘ only. Labels under κ 0.6 were dropped from the rubric. */
export const STORY_LABEL_AGREEMENT: Readonly<Partial<Record<StoryHealthSeriesId, number>>> = {
  criteriaTestable: 0.73,
  criteriaBundled: 0.67,
  criteriaDependent: 0.73,
  outOfScopeStated: 0.85,
  dependencyNamed: 0.83,
  nonCodeWork: 0.68,
};

// ── GET /api/story-health?workspace=<id> ─────────────────────────────────────────────────────────

export interface StoryHealthWeek {
  /** Local Monday, `YYYY-MM-DD`, in the workspace's working time zone. */
  weekStart: string;
  /** ISO instants of the half-open span `[from, to)`. */
  from: string;
  to: string;
  /** The current week: measured so far. */
  partial: boolean;
  /** REFINEMENT population: stories with an open or merged PR in the workspace, bucketed into this
   *  week by created date (or the fallback) — merged or not. */
  storiesCreated: number;
  /** …of which bucketed by first-PR-opened because the ticket has no created date. */
  createdFallback: number;
  /** …of which have criteria text to label (the label coverage denominator). */
  labellable: number;
  /** …of which have a CURRENT label (this rubric version, this text hash). "12 of 15 stories labelled"
   *  = `labelled` of `labellable`. Always 0 when `labels: false`. */
  labelled: number;
  /** DELIVERY population: stories whose last merge fell in this week. */
  storiesMerged: number;
  /** …of which have unknown size (left out of the three working-time lines). */
  unsizedStories: number;
  /** …of which have a succeeded ticket review (the criteria-met denominator). */
  reviewedStories: number;
}

export interface StoryHealthPoint {
  /** The week's value in the series' unit; null when nothing was measurable (a gap, never 0). */
  value: number | null;
  /** Items behind the value: stories (or reviewed stories for `criteriaMet`). Decides `thin`. */
  n: number;
  /** For `over: 'criteria'` series: criteria behind the percentage. Absent otherwise. */
  criteria?: number;
  /** `n < STORY_HEALTH_THIN_N`: drawn faint, excluded from the rolling line and the time / count shift test. */
  thin: boolean;
  /** The rolling 4-week value ending this week, POOLED over the underlying items of the non-thin
   *  weeks among it (pct: Σ numerators ÷ Σ denominators; hours/count: median of the pooled items).
   *  null when none of those weeks is non-thin. */
  rolling: number | null;
  /** Non-thin weeks the rolling value pooled (0–4). */
  rollingWeeks: number;
}

export interface StoryHealthSeries {
  id: StoryHealthSeriesId;
  /** One per `weeks` entry, same order. */
  points: StoryHealthPoint[];
}

/** A step change in one series — at most one per series (docs/API.md § GET /api/story-health).
 *  RATE series (`unit: 'pct'`): the split week with the largest |z| of a two-proportion test over the
 *  POOLED units each side (`STORY_SHIFT_MIN_STORIES` stories a side, `STORY_SHIFT_MIN_POINTS` points
 *  apart, |z| ≥ `STORY_SHIFT_Z`). TIME / COUNT series: `detectChangepoints` over the ROLLING values of
 *  non-thin weeks, the medians each side at least the series' `minShift` apart. */
export interface StoryHealthShift {
  series: StoryHealthSeriesId;
  /** Index into `weeks` where the AFTER segment begins. */
  week: number;
  /** = `weeks[week].weekStart`. */
  weekStart: string;
  /** Rate: the POOLED share each side (percent). Time / count: the median of the rolling values each side. */
  before: number;
  after: number;
  /** Weeks each side that carried any data (rate) / a rolling value (time, count). */
  beforeWeeks: number;
  afterWeeks: number;
  /** The units behind `before` / `after`: stories or criteria (rate), weeks (time, count). */
  beforeN: number;
  afterN: number;
  nOf: 'stories' | 'criteria' | 'weeks';
  /** Rate series: the stories each side (equal to `beforeN`/`afterN` when `nOf` is 'stories'). */
  beforeStories?: number;
  afterStories?: number;
  direction: 'up' | 'down';
  /** `better` applied to `direction`: 'better' | 'worse', or null when the series declares no better
   *  direction (render neutral). The SPA colours green/red from this alone. */
  verdict: 'better' | 'worse' | null;
}

export interface StoryHealthResponse {
  workspaceId: number;
  /** false = no tracker on the workspace: `weeks` still spans the 13 weeks, every series is empty
   *  (all `value: null`), and the SPA prints one sentence instead of the panels. */
  trackerOn: boolean;
  /** The fixed span: `label` = `STORY_HEALTH_SPAN_LABEL`; `from`/`to` ISO = first week's start → now. */
  span: { label: string; from: string; to: string; weeks: number };
  /** The working time zone the weeks are keyed in. */
  timeZone: string;
  /** Oldest first; the last is the current, partial week. Length `STORY_HEALTH_WEEKS`. */
  weeks: StoryHealthWeek[];
  /** false (cloud, or `LIMN_AI_DISABLED`) → every `source: 'label'` series is OMITTED from `series`
   *  and `shifts`, and the label run is not offered. */
  labels: boolean;
  /** Present series in `STORY_HEALTH_SERIES` order. */
  series: StoryHealthSeries[];
  shifts: StoryHealthShift[];
  /** Refinement: stories over the 13 weeks bucketed by first-PR-opened (no created date). */
  createdFallbackTotal: number;
  /** Delivery: stories with unknown size over the 13 weeks. */
  unsizedTotal: number;
  /** Labellable stories in the span with no CURRENT label — what "Label N stories" would label
   *  (min(this, `STORY_LABEL_RUN_CAP`) per press). 0 when `labels: false`. */
  unlabelled: number;
  /** The account's label run in flight, or null (so a reload re-attaches the progress bar). */
  labelRun: StoryLabelRunStatus | null;
  /** A scan cap was hit (the stories fold's `STORIES_MAX`): the oldest stories are not counted. */
  truncated: boolean;
}

// ── The label run (core, agentic, LOCAL-ONLY: registered only via `registerAgenticRoutes`) ────────
//
//   POST /api/story-health/label         {workspaceId}  → 202 StoryLabelRunResponse   (ai + ai_hourly)
//   GET  /api/story-health/label                         → StoryLabelRunResponse       (read)
//   POST /api/story-health/label/cancel                  → StoryLabelRunResponse       (read)
//
// ONE run in flight per ACCOUNT, claimed SYNCHRONOUSLY (before any await). The run's state lives in
// process memory (the labels it writes are the durable part); a restart loses the progress, never a
// label. Each label call's cost is recorded via `recordAiUsage` (feature 'story_labels'); the run stops
// at `budgetUsd`. A failed label (bad JSON, wrong criterion count) is NOT stored and is retried on the
// next press.

export type StoryLabelRunState = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Why a run stopped short. 'budget' = hit `budgetUsd`; 'auth' / 'runtime' = no Claude credential /
 *  AI runtime; 'failed' = anything else (the log has the detail). */
export type StoryLabelRunStop = 'budget' | 'cancelled' | 'auth' | 'runtime' | 'failed';

export interface StoryLabelRunStatus {
  /** Opaque, unique per process. */
  id: string;
  workspaceId: number;
  state: StoryLabelRunState;
  /** Stories this run set out to label (≤ `STORY_LABEL_RUN_CAP`). */
  total: number;
  /** Stories finished (labelled + failed). `done / total` drives the progress bar. */
  done: number;
  labelled: number;
  /** Labels refused by validation or a failed call (not stored). */
  failed: number;
  /** Recorded spend so far (US$; local spend is shown in US$, never credits). */
  costUsd: number;
  budgetUsd: number;
  stoppedBy: StoryLabelRunStop | null;
  /** ISO-8601. */
  startedAt: string;
  finishedAt: string | null;
}

export interface StartStoryLabelRunBody {
  workspaceId: number;
}

export interface StoryLabelRunResponse {
  /** GET: the account's current run, else its most recent finished run this process, else null. */
  run: StoryLabelRunStatus | null;
}

/** Refusals are HTTP errors with `StoryLabelRunErrorBody`: 409 'busy' (`runningId` set),
 *  400 'no_tracker', 422 'nothing_to_label', 402 not entitled. */
export type StoryLabelRunRefusal = 'busy' | 'no_tracker' | 'nothing_to_label';

export interface StoryLabelRunErrorBody {
  error: StoryLabelRunRefusal | string;
  message: string;
  runningId?: string;
}

