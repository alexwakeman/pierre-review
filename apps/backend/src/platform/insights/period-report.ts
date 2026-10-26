import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PERIOD_METRIC_KEYS } from '@pierre-review/shared';
import type {
  PeriodArchivedReport,
  PeriodCoverage,
  PeriodForecast,
  PeriodGrain,
  PeriodLanes,
  PeriodMetricDelta,
  PeriodMetricDirection,
  PeriodMetricKey,
  PeriodMetricValue,
  PeriodMovement,
  PeriodRefusalReason,
  PeriodReport,
  PeriodReportCostEstimate,
  PeriodReportListItem,
  PeriodReportSpend,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { proSchemaFor } from '../db.js';
import { currentSprintWindow, type SprintCadence } from '../settings/store.js';
import { estimateReportCost, type ReportModel } from '../llm/seam.js';
import {
  buildSuggestedQuestions,
  formatPeriodRange,
  movementPhrase,
  periodDayKey,
  periodMonthKey,
  PERIOD_METRIC_LABEL,
  PERIOD_METRIC_UNIT,
} from './period-questions.js';
import { tsToIso, tsToMs } from '../llm/gate.js';
import { groundingFigureSet, templatedNarrative, ungroundedNumerals } from './grounded-figures.js';

// ── PERIOD-OVER-PERIOD REPORTING: generation, storage, hashing, backfill ─────────────────────
//
// The stored, forwardable artifact behind Insights → Reports. One row per
// (account, workspace, period, MODEL); the numbers are CORE's window-pure vector, the coverage
// rule and the forecast estimator; the narration, the history and the routes are ours.
//
// Modelled on `sprint-report.ts` — same credit gate (`.blocked`), same in-flight guard, same
// payload-hash $0-on-unchanged cache, same `recordAiUsage` row shape. What differs is the GRAIN:
// the sprint report is ONE mutable row per workspace that always describes "now", while this is
// an APPEND-ONLY HISTORY keyed by period, and a stored period is IMMUTABLE once generated.
//
// ⚠ A STORED REPORT IS NEVER SILENTLY REGENERATED. The free GET recomputes the data fingerprint
// and sets `stale: true` when it differs; regeneration is a user action. Someone has already
// forwarded that document, and quietly changing the numbers under a copy in someone's inbox is
// worse than showing a stale badge next to a regenerate button.
//
// ⚠ THE PAYLOAD HASH FOLDS IN THE MODEL, AND SO DOES THE ROW KEY — both, for two different
// reasons. Model OUT of the hash ⇒ switching to Sonnet hits the cache and the toggle looks
// broken. Model out of the ROW KEY ⇒ the Sonnet run overwrites the Haiku row and the cheaper
// artifact is gone. Nothing `Date.now()`-derived may enter either (the digest cost trap: a hash
// carrying a moving value re-bills a dormant workspace on every click).

// MIRRORED from @pierre-review/shared (`PERIOD_METRICS_SCHEMA_VERSION`) and from core's
// `db/period-metrics.ts` copy of it. Three spellings of one number, for the reason stated in
// core's file: the shared package is TYPES ONLY and cannot be imported for a runtime value.
//
// ⚠ THIS CONSTANT IS FOLDED INTO `payloadHashFor`, which is what makes a bump self-executing:
// every stored row's hash moves the moment it changes, so the next read sees `stale` and
// regenerates. That is deliberate for 1 → 2, because a v1 row's
// `median_time_to_first_review_hours` (time until ANYONE reviewed — the push time, on a workspace
// with an auto-approving CI bot) is not the same measurement as a v2 row's
// `median_time_to_first_human_review_hours` and the two must never be subtracted.
//
// The hash PREFIX (`p3`) deliberately does NOT move with it: the prefix versions the FORMULA, and
// the formula is unchanged — the same inputs go in, one of them just holds a different number.
const PERIOD_METRICS_SCHEMA_VERSION = 2;

// The SIGNIFICANCE table, MIRRORED from `PERIOD_METRIC_META` in core's db/period-metrics.ts.
//
// ⚠ IT IS A COPY, AND THAT IS A KNOWN COST. The floors belong beside the metric definitions in
// core, but the plugin computes the deltas — it is the side that holds the stored history and
// therefore the only side that has both periods — and `ProHostQueries` carries no seam for the
// meta. `Record<PeriodMetricKey, …>` at least makes a metric added at schema version 2 a COMPILE
// error here rather than a silently unrankable one; if the two ever disagree, CORE WINS and this
// table is the one to fix.
interface PeriodMetricMeta {
  direction: PeriodMetricDirection;
  /** Minimum items behind the statistic on BOTH sides before a change may be called significant. */
  sampleFloor: number;
  /** Minimum |change|, in the metric's OWN units (hours, points, lines, count, ratio). */
  absoluteFloor: number;
}

export const PERIOD_METRIC_META: Record<PeriodMetricKey, PeriodMetricMeta> = {
  merged_prs: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 3 },
  human_merged_prs: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 3 },
  opened_prs: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 3 },
  automation_merge_share_pct: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 5 },
  median_lead_time_hours: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 2 },
  median_time_to_first_human_review_hours: {
    direction: 'down_good',
    sampleFloor: 5,
    absoluteFloor: 1,
  },
  merge_ci_success_pct: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 5 },
  median_pr_size_lines: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 20 },
  median_human_pr_size_lines: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 20 },
  review_threads_opened: { direction: 'neutral', sampleFloor: 10, absoluteFloor: 5 },
  threads_replied_within_36h_pct: { direction: 'up_good', sampleFloor: 10, absoluteFloor: 5 },
  bot_review_comments: { direction: 'neutral', sampleFloor: 10, absoluteFloor: 5 },
  human_review_comments: { direction: 'up_good', sampleFloor: 10, absoluteFloor: 5 },
  bot_comments_per_merged_pr: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 0.5 },
  reviewer_concentration_pct: { direction: 'down_good', sampleFloor: 10, absoluteFloor: 5 },
};

// How many PRIOR periods the first generate computes metrics for (§8). Bounded and never
// unbounded: this is what gives the forecast a series on day one, and it costs ~2 indexed scans
// per period with NO model call and NO credits. 8 periods of a 14-day cadence is ~4 months —
// enough for MIN_FORECAST_POINTS (4) even when half the window fails the coverage test.
const BACKFILL_PERIODS = 8;

// The forecast series length: the target period plus the 7 before it, matching the backfill so
// the two can never disagree about how much history exists.
const FORECAST_HISTORY = BACKFILL_PERIODS;

// How many completed periods the list surface offers when nothing is stored yet. Same bound as
// the backfill so a fresh workspace's list and its first backfill cover the same span.
const LIST_PERIODS = BACKFILL_PERIODS;

// ⚠ A CEILING, NOT AN EXPECTATION — and it is NOT the number the pre-flight quote uses.
//
// It was sized when this was the one feature able to run something other than Haiku, and the two
// models spent the budget completely differently. Measured on the real dev corpus at 1100: Haiku
// produced the whole three-part report in 197 output tokens, while Sonnet consumed all 1100 and
// emitted one headline followed by the word "Note" — cut off mid-document. A reasoning-capable
// model draws its thinking from the same allowance, so a cap sized for the visible prose truncates
// it. Sized so the LONGEST model has room; the quote below is sized on what a run TYPICALLY costs,
// because quoting the ceiling would price a 5-credit Haiku report at 24.
//
// Narration is Haiku-only again (REPORT_MODELS in llm/seam.ts), and the ceiling STAYS at 3000
// regardless: an unused output allowance bills nothing — only emitted tokens do — so the only
// thing a lower cap could buy is a truncated report the day the prompt grows.
const REPORT_MAX_TOKENS = 3_000;

// A typical report run, in tokens, for the PRE-FLIGHT estimate. The payload is a fixed-shape
// JSON — 12 metrics, 12 deltas, 12 forecasts, a ranked movement list and a bounded history table
// — so its size barely moves with workspace size, and the figure that actually matters to the
// reader is the RATIO between models, which a fixed token count captures exactly. The ACTUAL
// spend is recorded on the row and reported after the run.
//
// ⚠ THE OUTPUT FIGURE IS DELIBERATELY NOT `REPORT_MAX_TOKENS`. That constant is a ceiling sized so
// the most verbose model cannot be cut off; pricing every quote at it would tell a reader that a
// Haiku report costs 24 credits when it measurably costs 5. This is the TYPICAL cost, set above
// the observed spread (Haiku ≈ 200 output tokens, Sonnet's thinking + prose an order more) so a
// quote still rounds towards over-quoting rather than under. It stays at 1100 now that only the
// Haiku end of that spread is reachable: the quote is a promise about money, and the direction it
// may be wrong in is HIGH. Lowering it towards the measured Haiku figure is a separate, deliberate
// decision about how tight a promise to make — not a tidy-up to fold into a model retirement.
const ESTIMATED_INPUT_TOKENS = 4_000;
const ESTIMATED_OUTPUT_TOKENS = 1_100;

// Per-(account, workspace, period, model) in-flight guard + last-run clock. Keyed at the ARTIFACT
// grain rather than sprint-report's per-workspace grain on purpose: generating the narration for
// August must not lock out September, and a user narrating a freshly backfilled history does
// exactly that in sequence. The generate route is always an explicit manual action, so it FORCES
// past the cooldown (the "don't tell a user who clicked Regenerate to wait 60s" lesson) while
// keeping the in-flight guard, which is what actually prevents a double-click double-billing.
const reportInFlight = new Set<string>();
const reportLastRunAt = new Map<string, number>();
const MIN_INTERVAL_SEC = 20;
const runKeyFor = (
  accountId: number,
  workspaceId: number,
  periodKey: string,
  model: string,
): string => `${accountId}:${workspaceId}:${periodKey}:${model}`;

const REPORT_SYSTEM_HEAD = `You write the narrative for an engineering team's PERIOD REPORT — a document the team lead forwards to other people. You are given ONE JSON object describing a single completed period and nothing else.

The JSON carries:
  • \`period\`: the explicit date range, the grain, and the cadence in days.
  • \`coverage\`: how many repos in the current workspace were already being tracked when the period began. When \`complete\` is false, say so plainly ("N of M repos were tracked for the whole period") — the headline figures cover fewer repos than the workspace has today.
  • \`metrics\`: the period's twelve HEADLINE figures, over the workspace's FULL membership today. \`value: null\` means NO DATA — never write it as 0, never call it a drop to zero.
  • \`comparison\`: the like-for-like comparison against the previous period, recomputed over the repos tracked in BOTH periods (\`subsetDisclosure\` states which). \`refusal\` non-null means there is NO honest comparison: say why in one clause and give the headline figures only.
  • \`forecasts\`: next-period projections with a band. \`available: false\` carries a named \`reason\`; report the refusal, never a number.
  • \`movements\`: the significant changes, already ranked. \`rank: 0\` is the biggest mover.

⚠ THE TWO POPULATIONS RULE — THE EASIEST WAY TO WRITE A FALSE SENTENCE HERE. \`metrics[].value\` counts the WHOLE workspace as it stands today. \`comparison.deltas[]\` and \`movements[]\` count only the coverage-stable SUBSET — the repos present in BOTH periods — so for the same metric key their \`thisPeriod\` legitimately differs from \`metrics[].value\`, and that gap is repo onboarding, not team output. A comparison pair is ALWAYS \`thisPeriod\` against \`priorPeriod\` from the SAME object. NEVER pair a \`metrics[].value\` with a \`priorPeriod\`, and never present a headline figure as one side of a change: they are different populations and the subtraction would be meaningless.

THE LOAD-BEARING RULE — SIGNIFICANCE. Each delta carries \`significant\`. When it is FALSE, state the two raw figures and NOTHING else: no percentage, no multiple, no direction, no trend word (never "collapsed", "surged", "halved", "spiked"). A percentage off a tiny base is noise wearing a suit. Only a delta with \`significant: true\` may be described as a change at all.

%%GRAIN_RULE%%

Ground EVERY number in the JSON — copy it, never recompute or re-round beyond one decimal, never invent a figure that is not there. Every figure carries a \`unit\`: quote it with that unit, so a percentage is never read as a count. Do not name people, repos or PRs: this payload contains none, so any you write would be fabricated.

Output GitHub-flavoured markdown in three short parts:
1. A one-line **headline** in bold: the period's range, then the two or three things that actually moved (significant only), or "no significant change" when nothing did.
2. **What moved** — one bullet per entry in \`movements\`, in rank order, as "<metric>: <phrase> — <4-8 word read>". \`phrase\` is ALREADY WRITTEN OUT for you, UNITS INCLUDED: copy it CHARACTER FOR CHARACTER and put no other number in the bullet. Do not substitute a figure from \`metrics\` (a different population — see the rule above), do not re-round it, do not reorder it, and do not add or change a unit — the \`unit\` field beside it names what the figures are already quoted in, it is not a suffix for you to append. Skip this section entirely when \`movements\` is empty and say so in one line.
3. **Watch next** — at most three bullets: any available forecast worth naming (with its band), any refusal the reader should know about (coverage, comparison, forecast), and nothing else.

Be terse and factual — no preamble, no restating the JSON, no advice you cannot ground. Under ~200 words, always ending on a complete sentence.`;

/**
 * ⚠ THE MONTH-WORD BAN LIVES IN THE MODEL'S SYSTEM PROMPT, NOT ONLY IN UI COPY — and it is now
 * GRAIN-CONDITIONAL rather than deleted.
 *
 * At SPRINT grain the ban stands exactly as it did: a 14-day cadence gives ~2.17 periods per
 * calendar month, so "month on month" is a false label on a document somebody forwards, and the
 * model will reach for it unprompted because it is the register these documents are written in.
 * Deleting the sentence to make the calendar grain work would hand every 14-day report permission
 * to call itself monthly again — a silent regression with no test that could see it.
 *
 * At MONTH grain the period IS a calendar month, so the ban is replaced by the rule that actually
 * bites there: months are 28-31 days long, so a change between two of them is NOT a like-for-like
 * rate change, and the model must not annualise or extrapolate from one.
 */
function reportSystemFor(grain: PeriodGrain): string {
  const rule =
    grain === 'month'
      ? 'This report covers ONE CALENDAR MONTH, and `period.range` names it (e.g. "August 2026"). Use that exact string. Calendar months run 28 to 31 days, so NEVER treat a difference between two months as a like-for-like rate change, never annualise, and never project from one month to a year.'
      : 'NEVER write "month", "monthly", or "month on month". The grain is the team\'s sprint cadence, and the period is named by its date range. Use the exact `period.range` string when you name it.';
  return REPORT_SYSTEM_HEAD.replace('%%GRAIN_RULE%%', rule);
}

// ── Period identity + the cadence grid ───────────────────────────────────────────────────────

export interface PeriodWindow {
  /** At `'sprint'` grain: 0 = the first period after the configured sprint start (indices go
   *  NEGATIVE — the start is a phase anchor). At `'month'` grain: whole months since 1970-01 UTC,
   *  so the index is an absolute calendar address and never needs configuring. */
  index: number;
  fromMs: number;
  /** EXCLUSIVE, matching the metric vector's half-open `[from, to)` predicates. */
  toMs: number;
  key: string;
  /** The window's REAL length in days: the configured cadence at sprint grain, 28-31 at month
   *  grain. ⚠ Never a sentinel — it is a disclosure on a forwarded artifact and an input to the
   *  payload hash. */
  cadenceDays: number;
  grain: PeriodGrain;
}

/**
 * The period grid, as a UNION ON THE GRAIN rather than one shape with unused fields.
 *
 * ⚠ THE UNION IS THE ENFORCEMENT. A month grid has no phase anchor, no configured length and no
 * fixed period duration, so `startMs` / `cadenceDays` / `cadenceMs` are not merely unused there —
 * any value they could hold would be a lie (30? 0? the length of *which* month?). Making them
 * absent turns every read of them into a compile error that has to be answered per grain, which
 * is how the cadence-vs-grain confusion below gets caught at build time instead of by a reader.
 */
type PeriodGrid =
  | {
      grain: 'sprint';
      startMs: number;
      cadenceDays: number;
      cadenceMs: number;
      /** Index of the period containing `now` — IN PROGRESS, and therefore not reportable. */
      currentIndex: number;
    }
  | {
      grain: 'month';
      /** Whole months since 1970-01 (UTC) containing `now` — the OPEN month. */
      currentIndex: number;
    };

/** Whole months since 1970-01, UTC. The calendar grid's index — absolute, so it needs no anchor. */
function monthIndexOf(ms: number): number {
  const d = new Date(ms);
  return (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth();
}

/** The UTC-midnight first-of-month for a month index. */
function monthStartMs(index: number): number {
  const year = 1970 + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  return Date.UTC(year, month, 1);
}

/**
 * The period key.
 *
 *  • sprint → `'sprint-' + <period start as YYYY-MM-DD, UTC>` (§5). Deliberately NOT the plan's
 *    `s:…` form: this travels in a URL PATH SEGMENT and a colon there is needless encoding risk.
 *  • month  → `'month-' + <YYYY-MM, UTC>`.
 *
 * ⚠ THE TWO SHAPES ARE DISJOINT AND THE PREFIX IS LOAD-BEARING. One key space serves both grains
 * — one `?report=` URL parameter, one `insightsReportKey` store field, one stored `period_key`
 * column, one unique index. The prefix is what lets `grainOfKey` answer "what does this document
 * measure" from the key alone, which is why no route needs a `?grain=` parameter beside a key it
 * was already given.
 *
 * ⚠ MONTHS ALIGN TO UTC MIDNIGHT ON THE 1st, like every other boundary in this feature (the
 * sprint start is stored at UTC midnight, `periodDayKey` is UTC, the SPA titles in UTC). They are
 * deliberately NOT aligned to the Slack digest's send-time zone (`workspace_slack_targets.timezone`
 * since plugin 0030; it was `pro_settings.slack_timezone`): that column decides when a NOTIFICATION
 * goes out, and hanging the report grid off it would (a) move a stored artifact's window
 * when somebody edited an unrelated notification setting, and (b) make the period key
 * (`month-2026-08`) disagree with its own start instant for every reader east of Greenwich.
 */
export function periodKeyFor(fromMs: number, grain: PeriodGrain = 'sprint'): string {
  return grain === 'month' ? `month-${periodMonthKey(fromMs)}` : `sprint-${periodDayKey(fromMs)}`;
}

/** What a period key SAYS it measures, from its shape alone. Null for anything that is neither. */
export function grainOfKey(key: string): PeriodGrain | null {
  if (/^sprint-\d{4}-\d{2}-\d{2}$/.test(key)) return 'sprint';
  if (/^month-\d{4}-\d{2}$/.test(key)) return 'month';
  return null;
}

/**
 * The cadence grid, derived from the SAME `currentSprintWindow` machinery the Insights window
 * uses — deliberately, so a period boundary here and a sprint boundary there can never drift.
 * It takes the RESOLVED `SprintCadence` (see `resolveSprintCadence`), which is a per-WORKSPACE
 * fact: two workspaces on one account legitimately sit on two different grids.
 * Null when no cadence is configured, which is the ONE state that makes the SPRINT half of this
 * surface refuse to generate (§6.1): a period the user never chose is not an artifact they will
 * forward, so there is no silent fallback to a rolling fortnight.
 *
 * ⚠ THE MONTH GRID NEEDS NO CONFIGURATION AND THEREFORE NEVER RETURNS NULL. The calendar is not a
 * setting: a workspace that has never chosen a sprint length still has an August. `cadence` is
 * ignored entirely at that grain — reading it would be the beginning of the coupling the grain is
 * kept out of the settings row to avoid. `grain` is a TRAILING OPTIONAL parameter, so every
 * existing sprint call site is byte-identical.
 */
export function periodGrid(
  cadence: SprintCadence,
  nowMs: number,
  grain: PeriodGrain = 'sprint',
): PeriodGrid | null {
  if (grain === 'month') return { grain: 'month', currentIndex: monthIndexOf(nowMs) };
  const current = currentSprintWindow(cadence, nowMs);
  const cadenceDays = cadence.cadenceDays;
  const startMs = cadence.startAtMs;
  if (current == null || cadenceDays == null || cadenceDays < 1 || !startMs) return null;
  const cadenceMs = cadenceDays * 86_400_000;
  return {
    grain: 'sprint',
    startMs,
    cadenceDays,
    cadenceMs,
    currentIndex: Math.round((current.fromMs - startMs) / cadenceMs),
  };
}

/**
 * The window at one index. ⚠ THE ONLY PLACE THE TWO GRAINS' ARITHMETIC FORKS — everything above
 * it (which indices exist, how far back the grid reaches) and everything below it (metrics,
 * coverage, comparison, storage) is grain-agnostic and stays that way.
 *
 * At month grain `cadenceDays` is the REAL length of that month, computed from the two boundaries
 * rather than assumed: February 2026 stores 28 and January stores 31, and a stored artifact must
 * carry the number of days it actually measured.
 */
function windowAt(grid: PeriodGrid, index: number): PeriodWindow {
  if (grid.grain === 'month') {
    const fromMs = monthStartMs(index);
    const toMs = monthStartMs(index + 1);
    return {
      index,
      fromMs,
      toMs,
      key: periodKeyFor(fromMs, 'month'),
      cadenceDays: Math.round((toMs - fromMs) / 86_400_000),
      grain: 'month',
    };
  }
  const fromMs = grid.startMs + index * grid.cadenceMs;
  return {
    index,
    fromMs,
    toMs: fromMs + grid.cadenceMs,
    key: periodKeyFor(fromMs),
    cadenceDays: grid.cadenceDays,
    grain: 'sprint',
  };
}

/**
 * How far back the grid may be extrapolated, in periods. At a 14-day cadence this is a year; at
 * calendar-month grain it is a little over two years.
 *
 * It exists only so a hand-typed `?report=sprint-1970-01-01` cannot ask us to scan a window from
 * before the product existed; the real limit on useful history is the data (and the coverage rule),
 * not this number.
 */
const MAX_HISTORY_PERIODS = 26;

/**
 * The shortest series worth choosing a repo subset for. MIRRORS core's `MIN_FORECAST_POINTS`
 * (db/forecast.ts), which cannot be imported across the open-core boundary.
 *
 * Drift here is SAFE IN ONE DIRECTION and that is why a mirrored constant is acceptable: core is
 * the enforcer, so if core's minimum rose above this we would hand it a short series and get an
 * `insufficient_history` refusal — the honest answer, just reached a step later. It can never
 * produce a forecast core would have declined.
 */
const MIN_FORECAST_POINTS = 4;

/**
 * The most recent COMPLETED periods, newest first. The in-progress period is excluded on purpose:
 * its numbers move under the reader, so every free GET would recompute a different fingerprint and
 * flag the stored row stale forever — inviting a regeneration that changes and re-bills daily.
 *
 * ⚠ THE SPRINT START DATE IS A PHASE ANCHOR, NOT A PROJECT START — indices go NEGATIVE.
 *
 * This used to stop at index 0, treating the configured `sprintStartAt` as the beginning of
 * recorded history. It is not: it is the date the team happened to enter when they set their
 * cadence, and it says only WHERE the fortnightly boundaries fall, not when the team started
 * working. A workspace with two years of PRs and a sprint start entered six weeks ago had three
 * reportable periods and could never forecast, while all the data needed sat in the database.
 *
 * Extending backward on the same phase keeps every boundary aligned with the team's real sprint
 * rhythm — a period before the anchor is the same fortnight the team would have called a sprint,
 * just one they had not written down yet.
 */
export function completedWindows(grid: PeriodGrid, limit: number): PeriodWindow[] {
  const out: PeriodWindow[] = [];
  const earliest = grid.currentIndex - MAX_HISTORY_PERIODS;
  for (let i = grid.currentIndex - 1; i >= earliest && out.length < limit; i -= 1) {
    out.push(windowAt(grid, i));
  }
  return out;
}

/**
 * A URL path segment → the window it names, or null. Null covers every wrong shape at once:
 * unparseable, off the cadence grid (the key came from a different cadence), before the sprint
 * start, and the in-progress or future periods. The routes render `report: null` rather than
 * 404ing, matching how `?workspace=` degrades — no existence oracle, nothing leaks.
 */
export function windowForKey(grid: PeriodGrid, key: string): PeriodWindow | null {
  // ⚠ GRAIN FIRST. A `month-…` key asked of a sprint grid (and vice versa) is not a near-miss to
  // be snapped to a boundary — it names a period on the OTHER grid, and answering it here would
  // put a calendar month's numbers under a fortnight's heading. The routes reach the right grid by
  // reading `grainOfKey` off the key itself, so this is the belt to that braces.
  if (grainOfKey(key) !== grid.grain) return null;
  if (grid.grain === 'month') {
    const ym = /^month-(\d{4})-(\d{2})$/.exec(key);
    if (ym == null) return null;
    const year = Number.parseInt(ym[1]!, 10);
    const month = Number.parseInt(ym[2]!, 10);
    if (!Number.isFinite(year) || month < 1 || month > 12) return null;
    const index = (year - 1970) * 12 + (month - 1);
    // The open month is excluded for the same reason the in-progress sprint is: its numbers move
    // under the reader, so every free GET would recompute a different fingerprint and flag the
    // stored row stale forever. Month-TO-DATE is a separate, never-stored read.
    if (index >= grid.currentIndex) return null;
    if (index < grid.currentIndex - MAX_HISTORY_PERIODS) return null;
    return windowAt(grid, index);
  }
  const day = /^sprint-(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1];
  if (day == null) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  const raw = (ms - grid.startMs) / grid.cadenceMs;
  const index = Math.round(raw);
  // Exact alignment only. A key half a period out is a key from a DIFFERENT cadence, and
  // snapping it to the nearest boundary would silently answer about a window nobody asked for.
  //
  // A NEGATIVE index is legal — the sprint start is a phase anchor, not the start of history (see
  // `completedWindows`). The floor is the same look-back horizon, so a hand-typed key from the
  // 1970s is refused rather than scanned.
  if (!Number.isInteger(raw) || index >= grid.currentIndex) return null;
  if (index < grid.currentIndex - MAX_HISTORY_PERIODS) return null;
  return windowAt(grid, index);
}

// ── Host-seam result shapes (cast locally; the seam is typed `Promise<unknown>`) ─────────────

interface PeriodMetricsResult {
  metrics: PeriodMetricValue[];
  fingerprint: string;
}

interface PeriodCoverageResult {
  trackedRepoIds: number[];
}

type ForecastOutcome =
  | { point: number; low: number; high: number; basis: string; periodsUsed: number }
  | { refused: 'insufficient_history' | 'too_volatile' };

// Effort vs automation for one window. Its comment count spans inline comments, PR comments AND
// review bodies — unlike the metric vector's inline-only figure, which is what made a workspace
// with 786 SonarQube comments report zero bot activity.
const lanesFor = async (
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  window: PeriodWindow,
): Promise<PeriodLanes> =>
  (await ctx.queries.getPeriodLanes(accountId, scope, window)) as PeriodLanes;

const metricsFor = (
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  window: { fromMs: number; toMs: number },
): Promise<PeriodMetricsResult> =>
  ctx.queries.getPeriodMetrics(accountId, scope, window) as Promise<PeriodMetricsResult>;

const coverageFor = (
  ctx: ProContext,
  accountId: number,
  repoIds: number[],
  atMs: number,
): Promise<PeriodCoverageResult> =>
  ctx.queries.getPeriodCoverage(accountId, repoIds, atMs) as Promise<PeriodCoverageResult>;

// ── Storage ──────────────────────────────────────────────────────────────────────────────────

interface ReportRow {
  periodKey: string;
  periodStart: Date | number | null;
  periodEnd: Date | number | null;
  grain: string;
  cadenceDays: number;
  repoIdsJson: string;
  coverageJson: string;
  metricsJson: string;
  metricsSchemaVersion: number;
  comparisonJson: string | null;
  forecastJson: string | null;
  lanesJson: string | null;
  movementsJson: string | null;
  suggestedJson: string | null;
  narrativeMd: string | null;
  model: string | null;
  // What wrote the narrative (platform migration 0043); NULL on older and un-narrated rows.
  ranModel?: string | null;
  provider?: string | null;
  payloadHash: string;
  dataFingerprint: string;
  creditsSpent: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  generatedAt: Date | number | null;
}

/** Tolerant JSON column read — a corrupt cell degrades to the fallback rather than throwing in a
 *  listing path (the `chat.ts` precedent). */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function loadRows(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<ReportRow[]> {
  const pro = proSchemaFor();
  return (await ctx.db
    .select()
    .from(pro.workspacePeriodReports)
    .where(
      and(
        eq(pro.workspacePeriodReports.accountId, accountId),
        eq(pro.workspacePeriodReports.workspaceId, workspaceId),
      ),
    )
    .execute()) as ReportRow[];
}

/** The rows for ONE period, any model. Callers pick: the narrated one for display, the newest for
 *  the history series (where every model's metrics are identical by construction). */
function rowsForPeriod(rows: ReportRow[], periodKey: string): ReportRow[] {
  return rows.filter((r) => r.periodKey === periodKey);
}

/**
 * Restrict a period's rows to the CURRENT metrics schema whenever any current row exists.
 *
 * The unique key deliberately lets one period hold several rows (one per narration model, plus
 * the '' backfill), and a schema bump adds another axis: rows regenerated under the new version
 * coexist with their pre-bump siblings. Every pick MUST run inside this pool — the model
 * preference is PROSE, the schema is the CONTRACT. This shipped as a real bug: with the account's
 * narration model set to Sonnet, `exact` model-matched a stale v1 Sonnet row over its fresh v2
 * Haiku twin, and v1's renamed metric key (`median_time_to_first_review_hours`) reached the SPA,
 * whose meta table no longer holds it. An old-schema row is only ever served when the period has
 * nothing current — the designed stale-plus-regenerate path.
 */
function schemaCurrentPool(rows: ReportRow[]): ReportRow[] {
  const current = rows.filter((r) => r.metricsSchemaVersion === PERIOD_METRICS_SCHEMA_VERSION);
  return current.length > 0 ? current : rows;
}

/**
 * Rows measured at the CURRENTLY-CONFIGURED cadence. The sibling of `schemaCurrentPool` above, and
 * every read of a period's rows runs inside BOTH.
 *
 * ⚠ IT HAS NO FALLBACK, AND THAT IS THE DIFFERENCE FROM `schemaCurrentPool`. That helper degrades
 * to the whole set when no current-schema row exists, because an old-schema row is still a report
 * about the same window — stale, regenerable, honest. A row at a DIFFERENT CADENCE is not: it
 * measures a different number of days. Serving it under the new grid's heading is the same
 * two-populations lie the rest of this feature exists to refuse, one dimension over.
 *
 * THE THREE DEFECTS THIS CLOSES, all of which a cadence change used to produce silently:
 *   (a) SILENT OVERWRITE — `loadStoredReport` matched on `periodKey` ALONE and `persistReport`
 *       upserted on a key without the cadence, so a 14→7 change destroyed a stored artifact.
 *       Fixed structurally by migration 0029's wider unique index; this filter is the read half.
 *   (b) LISTED-BUT-BLANK — `listPeriods` emitted every stored row regardless of grid alignment
 *       while the detail GET refused a non-aligned key, so most of the history stayed CLICKABLE
 *       and opened as the ordinary "not generated yet" empty state.
 *   (c) PERMANENT STALENESS — the staleness probe recomputed the fingerprint over the NEW window
 *       and compared it to the stored one, so every colliding row read `stale: true` forever,
 *       inviting exactly the regenerate that performed (a).
 *
 * ⚠ NOTHING DELETES OR REWRITES THE FILTERED-OUT ROWS. They stay in the table and stay readable at
 * their archived key (`archivedKeyFor`): a stored report only stops being listed when it is
 * ERASED, never because a setting changed.
 */
function cadenceCurrentPool(rows: ReportRow[], cadenceDays: number): ReportRow[] {
  return rows.filter((r) => r.cadenceDays === cadenceDays);
}

/**
 * The stored row's GRAIN, tolerantly.
 *
 * ⚠ THE COLUMN HAS ALWAYS EXISTED AND WAS NEVER READ. `grain` was added with the table
 * (`DEFAULT 'sprint'`, "so a second grain does not need a migration to tell the two apart") and
 * four sites then hard-coded `grain: 'sprint'` on the way OUT — `rowToReport`, `buildPeriod`'s
 * report, `backfillHistory`'s report and `persistReport`'s values. Writing a month row today
 * would therefore have PERSISTED `grain = 'month'` and SERVED `grain: 'sprint'` on the wire, a
 * lie no test could see because nothing compared the two. All four now read or carry the real
 * value; this helper is the read half.
 *
 * Anything that is not exactly `'month'` reads as `'sprint'`: that is what every row written
 * before the calendar grain existed holds, and a blank or corrupt cell must degrade to the grain
 * the rest of the row's shape implies rather than throwing in a listing path.
 */
function rowGrain(row: ReportRow): PeriodGrain {
  return row.grain === 'month' ? 'month' : 'sprint';
}

/**
 * ⚠ THE POOL RULE, AND THE ORDER OF ITS TWO TESTS IS THE WHOLE FEATURE.
 *
 * GRAIN FIRST, `cadenceDays` ONLY WITHIN THE SPRINT GRAIN. A sprint row's day count is the
 * configured cadence and is identical on every row, so a difference means the setting moved and
 * the two rows measure different-length windows — the refuse-and-preserve rule. A MONTH row's day
 * count is the length of that calendar month: January stores 31 and February stores 28, and they
 * are the SAME grain measuring adjacent periods exactly as intended.
 *
 * Keying the pool (or the comparison refusal) on the day count alone would therefore make EVERY
 * month-over-month comparison answer `cadence_changed` — silently, with no error, and it is
 * precisely the comparison a calendar grain exists to provide.
 */
function grainPool(rows: ReportRow[], grain: PeriodGrain, sprintCadenceDays: number): ReportRow[] {
  return rows.filter(
    (r) => rowGrain(r) === grain && (grain !== 'sprint' || r.cadenceDays === sprintCadenceDays),
  );
}

/** The pool for a whole GRID (the listing, the history, the backfill). */
function grainCurrentPool(rows: ReportRow[], grid: PeriodGrid): ReportRow[] {
  return grainPool(rows, grid.grain, grid.grain === 'sprint' ? grid.cadenceDays : 0);
}

/** The pool for ONE window (the detail read and the generate path, which are handed a window
 *  rather than a grid). Same rule, same order: a sprint window's `cadenceDays` IS its grid's. */
function windowCurrentPool(rows: ReportRow[], window: PeriodWindow): ReportRow[] {
  return grainPool(rows, window.grain, window.cadenceDays);
}

/**
 * The explicit key an OLD-CADENCE artifact stays readable at: `<periodKey>@cad<days>`.
 *
 * A period key names a START DAY, which is not enough to identify a row once the cadence has
 * moved — the same day can begin a 14-day period and a 7-day one. Qualifying it with the cadence
 * makes the archived reference unambiguous, and makes it VISIBLY not a live period key, so a
 * reader (or a bookmark) cannot mistake one for the other.
 */
export function archivedKeyFor(periodKey: string, cadenceDays: number): string {
  return `${periodKey}@cad${cadenceDays}`;
}

/** The inverse. Null for anything that is not an archived key — including a plain period key,
 *  which must keep flowing down the live path. */
export function parseArchivedKey(key: string): { periodKey: string; cadenceDays: number } | null {
  // ⚠ BOTH KEY SHAPES. A calendar-month row can age past the look-back horizon exactly like a
  // sprint one, and when it does it is readable only at its archived key. Leaving the month form
  // out of this regex would have made `archivedKeyFor` emit a key nothing could parse — the row
  // listed, clickable, and answering `report: null`, which is defect (b) in a new costume.
  const m = /^((?:sprint-\d{4}-\d{2}-\d{2})|(?:month-\d{4}-\d{2}))@cad(\d{1,3})$/.exec(key);
  if (m == null) return null;
  const days = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(days) || days < 1) return null;
  return { periodKey: m[1]!, cadenceDays: days };
}

function newestRow(rows: ReportRow[]): ReportRow | null {
  let best: ReportRow | null = null;
  for (const r of rows) {
    if (best == null || tsToMs(r.generatedAt) > tsToMs(best.generatedAt)) best = r;
  }
  return best;
}

interface PersistInput {
  accountId: number;
  workspaceId: number;
  window: PeriodWindow;
  model: string;
  report: PeriodReport;
  // What wrote the narrative (Phase 4). Omitted ⇒ NULL (an un-narrated row).
  ranModel?: string | null;
  provider?: string | null;
  repoIds: number[];
  payloadHash: string;
  dataFingerprint: string;
  creditsSpent: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  generatedAt: Date;
}

async function persistReport(ctx: ProContext, input: PersistInput): Promise<void> {
  const pro = proSchemaFor();
  const values = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    periodKey: input.window.key,
    periodStart: new Date(input.window.fromMs),
    periodEnd: new Date(input.window.toMs),
    // ⚠ THE WINDOW'S OWN GRAIN, never the literal. See `rowGrain`: this was one of four sites that
    // hard-coded 'sprint', which would have stored a month row under the wrong grain forever.
    //
    // It does NOT need to join the unique index: a month key (`month-2026-08`) and a sprint key
    // (`sprint-2026-08-01`) are disjoint by construction, so `period_key` already discriminates
    // the grain and no migration is required for the calendar grid.
    grain: input.window.grain,
    cadenceDays: input.window.cadenceDays,
    repoIdsJson: JSON.stringify(input.repoIds),
    coverageJson: JSON.stringify(input.report.coverage),
    metricsJson: JSON.stringify(input.report.metrics),
    metricsSchemaVersion: PERIOD_METRICS_SCHEMA_VERSION,
    comparisonJson: JSON.stringify(input.report.comparison),
    // ⚠ AN OBJECT, NOT THE BARE ARRAY. The forecast's DISCLOSURE ("fitted on the 6 of 8 repos
    // tracked across all 4 periods") is part of the forecast, not decoration: the projection is
    // fitted on a stable repo subset, and a band whose subset the reader cannot see is exactly the
    // over-claim this feature is built to avoid. Storing only the array dropped it on every read,
    // so it appeared on the generate response and vanished the moment the page was reloaded.
    // `readForecastJson` accepts the legacy bare-array shape, so no migration is needed.
    forecastJson: JSON.stringify({
      forecasts: input.report.forecasts,
      disclosure: input.report.forecastDisclosure ?? null,
    }),
    lanesJson: input.report.lanes ? JSON.stringify(input.report.lanes) : null,
    movementsJson: JSON.stringify(input.report.movements),
    suggestedJson: JSON.stringify(input.report.suggested),
    narrativeMd: input.report.narrative,
    // ⚠ EMPTY STRING, NEVER NULL, on an un-narrated row. NULL never compares equal to NULL in
    // either dialect, so NULL-modelled rows do not collide in the unique index and a re-run of
    // the backfill would insert a fresh duplicate set every time.
    model: input.model,
    ranModel: input.ranModel ?? null,
    provider: input.provider ?? null,
    payloadHash: input.payloadHash,
    dataFingerprint: input.dataFingerprint,
    creditsSpent: input.creditsSpent,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    generatedAt: input.generatedAt,
  };
  await ctx.db
    .insert(pro.workspacePeriodReports)
    .values(values)
    .onConflictDoUpdate({
      // ⚠ EXACTLY the table's unique index. A stale conflict target type-checks perfectly and
      // raises "no unique or exclusion constraint matching the ON CONFLICT specification" at
      // RUNTIME, in both dialects, only when a row is actually written (the 0042/0045 lesson).
      //
      // ⚠ `cadenceDays` JOINED THE INDEX IN PLUGIN MIGRATION 0029, and this line moved with it.
      // Without it, a 14 → 7 cadence change whose new period start day collides with an old one
      // overwrote the stored artifact IN PLACE — `set: values` carries `periodEnd` and
      // `cadenceDays`, so the row kept its name and silently acquired a different window's
      // numbers, in a document somebody may already have forwarded. With it the two coexist.
      target: [
        pro.workspacePeriodReports.accountId,
        pro.workspacePeriodReports.workspaceId,
        pro.workspacePeriodReports.periodKey,
        pro.workspacePeriodReports.model,
        pro.workspacePeriodReports.cadenceDays,
      ],
      set: values,
    })
    .execute();
}

// ── Deltas, movements, forecasts ─────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

function metricMap(metrics: PeriodMetricValue[]): Map<PeriodMetricKey, PeriodMetricValue> {
  return new Map(metrics.map((m) => [m.key, m]));
}

/**
 * This-vs-prior for every metric, over the coverage-stable subset.
 *
 * ⚠ THE THIRD SIGNIFICANCE CONDITION — "both periods are coverage-comparable" — IS ENFORCED
 * STRUCTURALLY, not by a flag here. `buildPeriod` only reaches this function once it has a
 * non-empty intersection of the two tracked sets and a matching cadence; every other case
 * short-circuits into a named `refusal` with NO deltas at all. A `coverageComparable` parameter
 * lived here briefly and was always passed `true` — a guard that cannot fire looks like coverage
 * and provides none, so it was removed rather than left as decoration.
 *
 * Both other conditions are applied per metric: the sample floor on BOTH sides (a swing measured
 * over four items is not a trend on either end of it) and the absolute floor on the change. A
 * delta that fails them is still CARRIED — the raw figures are real — it just may not be called
 * a change.
 */
function buildDeltas(
  current: PeriodMetricValue[],
  prior: PeriodMetricValue[],
): PeriodMetricDelta[] {
  const priorByKey = metricMap(prior);
  return current.map((cur) => {
    const meta = PERIOD_METRIC_META[cur.key];
    const pri = priorByKey.get(cur.key);
    const priorValue = pri?.value ?? null;
    const absoluteChange =
      cur.value != null && priorValue != null ? round2(cur.value - priorValue) : null;
    const percentChange =
      absoluteChange != null && priorValue != null && priorValue !== 0
        ? round2((absoluteChange / priorValue) * 100)
        : null;
    const significant =
      absoluteChange != null &&
      cur.sampleSize >= meta.sampleFloor &&
      (pri?.sampleSize ?? 0) >= meta.sampleFloor &&
      Math.abs(absoluteChange) >= meta.absoluteFloor;
    return {
      key: cur.key,
      value: cur.value,
      prior: priorValue,
      absoluteChange,
      percentChange,
      significant,
      direction: meta.direction,
      // The thinness of the figure the ROW ACTUALLY SHOWS. When a comparison exists the row
      // renders `delta.value` (the coverage-stable subset), so it must be the SUBSET's sample
      // that is marked — the headline's `lowSample` describes a different, larger population and
      // would under-report thinness on exactly the workspaces where the subset is small.
      lowSample: cur.sampleSize < meta.sampleFloor,
    } satisfies PeriodMetricDelta;
  });
}

/**
 * Significant deltas only, ranked by |percentChange| with |absoluteChange| as the tiebreak.
 *
 * ⚠ `favourable` IS FALSE FOR EVERY `neutral` METRIC, and that is not a bug: a neutral metric has
 * no good direction, so "the change is in the good direction" is simply not true of it. A renderer
 * must read `direction` alongside it and colour neutral movements as neither — treating
 * `favourable: false` as "bad" would paint every change in opened-PR count red.
 *
 * Pure, and exported so a future CORE `db/period-movements.ts` can replace it wholesale. It lives
 * here today because `ProHostQueries` carries no seam for it and the plugin is the side that owns
 * the two periods being compared.
 */
export function rankMovements(deltas: PeriodMetricDelta[]): PeriodMovement[] {
  const rows: { key: PeriodMetricKey; abs: number; pct: number | null; fav: boolean }[] = [];
  for (const d of deltas) {
    if (!d.significant || d.absoluteChange == null) continue;
    const fav =
      d.direction === 'up_good'
        ? d.absoluteChange > 0
        : d.direction === 'down_good'
          ? d.absoluteChange < 0
          : false;
    rows.push({ key: d.key, abs: d.absoluteChange, pct: d.percentChange, fav });
  }
  rows.sort((a, b) => {
    const pa = Math.abs(a.pct ?? 0);
    const pb = Math.abs(b.pct ?? 0);
    if (pb !== pa) return pb - pa;
    return Math.abs(b.abs) - Math.abs(a.abs);
  });
  return rows.map((r, i) => ({
    key: r.key,
    absoluteChange: r.abs,
    percentChange: r.pct,
    rank: i,
    favourable: r.fav,
  }));
}

/** One period's stored (or freshly computed) figures, for the forecast series and the chat's
 *  history slice. */
/** The metrics measured on a 0–100 scale. Their forecast declares a ceiling of 100; without it a
 *  rising series projects "CI success ≈ 104% (98–110%)", which is not a bold call but an
 *  impossible number. Kept beside the forecast rather than in core because the SCALE is a property
 *  of the metric definition, and core's estimator is deliberately told nothing about the metric. */
const PCT_METRIC_KEYS = new Set<PeriodMetricKey>([
  'merge_ci_success_pct',
  'threads_replied_within_36h_pct',
  'reviewer_concentration_pct',
  // ⚠ ADDING A `_pct` METRIC WITHOUT ADDING IT HERE is a silent defect, not a compile error: the
  // series fits fine and simply projects an impossible number. A rising automation share would
  // forecast "112% of merges authored by automation".
  'automation_merge_share_pct',
]);

/**
 * The series the forecast is fitted on: ONE repo set, measured consistently across every period.
 *
 * ⚠ WHY THIS RECOMPUTES INSTEAD OF READING STORED HISTORY.
 *
 * Requiring the full CURRENT membership to have been tracked across the whole series is correct
 * but far too strict to be useful: one repo onboarded last week disqualifies every period, and the
 * workspace can never forecast no matter how many years of data sit behind the repos that HAVE
 * been there. Measured on the real dev corpus, a workspace with 8 repos — 7 of them tracked for
 * 51–86 days — produced zero forecastable periods because the eighth arrived 12 days ago.
 *
 * So the series is fitted on the largest repo subset that was tracked across enough periods, and
 * the metrics are RE-MEASURED over exactly that subset for every period in it. That is what makes
 * the slots comparable: not a promise that membership never changed, but a measurement taken over
 * the same repos each time. The subset is disclosed — a forecast over 6 of 8 repos is a useful
 * statement only if the reader knows that is what it is.
 *
 * The selection rule maximises REPOS first, then history: take the largest subset that still
 * yields `MIN_FORECAST_POINTS` periods, then extend the depth for as long as that subset is
 * unchanged (extra history at no cost in coverage).
 */
interface ForecastSeries {
  windows: PeriodWindow[];
  repoIds: number[];
  /** Non-null when no honest series exists; the reason travels to every metric's forecast slot. */
  refusal: PeriodRefusalReason | null;
}

interface HistoryPeriod {
  key: string;
  fromMs: number;
  toMs: number;
  metrics: PeriodMetricValue[];
  coverage: PeriodCoverage;
  /** The repo set the row's metrics were actually computed over, from the stored
   *  `repo_ids_json`. Load-bearing for the forecast — see the second warning on
   *  `buildForecasts`. Empty for a row written before the column carried a value. */
  repoIds: number[];
}

/**
 * Next-period projections for all twelve metrics.
 *
 * ⚠ THE SERIES ONLY CONSUMES PERIODS WHOSE COVERAGE WAS COMPLETE (§4). Everything else is a
 * `null` slot — NOT dropped, because core's estimator uses the array INDEX as its x axis and
 * compacting the gaps would invent a cadence that never happened. This is the whole reason the
 * feature computes coverage at all: measured on the real dev corpus, merged-PR counts by 14-day
 * period read 39 → 570 over six months while the number of repos CONTRIBUTING went 4 → 18. Fit a
 * line through that and you forecast growth that is purely repo onboarding.
 */
/**
 * Choose the repo subset and depth the forecast will be fitted on. Pure selection — no metrics are
 * read here, only coverage, which is an indexed `repos.createdAt` lookup per candidate period.
 */
async function chooseForecastSeries(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  grid: PeriodGrid,
  window: PeriodWindow,
): Promise<ForecastSeries> {
  // Candidate windows, oldest first, ending at the target period.
  const all: PeriodWindow[] = [];
  for (let i = window.index - (FORECAST_HISTORY - 1); i <= window.index; i += 1) {
    if (i < grid.currentIndex - MAX_HISTORY_PERIODS) continue;
    all.push(windowAt(grid, i));
  }
  if (all.length < MIN_FORECAST_POINTS) {
    return { windows: [], repoIds: [], refusal: 'insufficient_history' };
  }

  // The subset tracked at the start of the Nth-from-last period, for each candidate depth.
  const subsetAtDepth = async (depth: number): Promise<number[]> => {
    const oldest = all[all.length - depth]!;
    const tracked = await coverageFor(ctx, accountId, scope.repoIds, oldest.fromMs);
    return [...tracked.trackedRepoIds].sort((a, b) => a - b);
  };

  // REPOS FIRST: the shallowest allowed depth keeps the most repos.
  const base = await subsetAtDepth(MIN_FORECAST_POINTS);
  if (base.length === 0) {
    // Not one repo in this workspace has been tracked long enough to span the minimum series.
    return { windows: [], repoIds: [], refusal: 'partial_coverage' };
  }

  // THEN HISTORY: extend while the subset is unchanged — deeper history costs nothing here.
  let depth = MIN_FORECAST_POINTS;
  const baseKey = base.join(',');
  for (let d = MIN_FORECAST_POINTS + 1; d <= all.length; d += 1) {
    if ((await subsetAtDepth(d)).join(',') !== baseKey) break;
    depth = d;
  }
  return { windows: all.slice(all.length - depth), repoIds: base, refusal: null };
}

/**
 * `forecast_json` in either shape: the current `{forecasts, disclosure}` object, or the legacy
 * bare array written before the disclosure existed. Two shapes in one column beats a migration
 * that rewrites regenerable model-adjacent output, and the legacy branch simply carries no
 * disclosure — which renders as no line, never as a false claim about what the fit covered.
 */
function readForecastJson(raw: string | null): {
  forecasts: PeriodForecast[];
  forecastDisclosure?: string;
} {
  const parsed = parseJson<unknown>(raw, []);
  if (Array.isArray(parsed)) return { forecasts: parsed as PeriodForecast[] };
  const obj = parsed as { forecasts?: PeriodForecast[]; disclosure?: string | null };
  return {
    forecasts: Array.isArray(obj?.forecasts) ? obj.forecasts : [],
    ...(typeof obj?.disclosure === 'string' && obj.disclosure.length > 0
      ? { forecastDisclosure: obj.disclosure }
      : {}),
  };
}

/** Exported for its unit test only — the belt-and-braces membership gate below is worth pinning
 *  independently of the series `buildPeriod` now hands it. */
export async function buildForecasts(
  ctx: ProContext,
  history: HistoryPeriod[],
  scopeRepoIds: number[],
): Promise<PeriodForecast[]> {
  const keys = history[history.length - 1]?.metrics.map((m) => m.key) ?? [];
  // ⚠ `coverage.complete` ALONE IS NOT A COMPARABILITY TEST, and using it as one reintroduced the
  // exact artifact this feature exists to refuse.
  //
  // A stored row is immutable (§6.3), so its `coverage` records the membership it was written
  // UNDER: `{trackedRepos: 2, totalRepos: 2, complete: true}` and
  // `{trackedRepos: 3, totalRepos: 3, complete: true}` are both "complete" and are two different
  // workspaces' worth of repos. Seven sprints at 2 repos (20 merges each) followed by one at 3
  // repos (120 merges) therefore produced the series [20,20,20,20,20,20,20,120] with NO nulls and
  // no refusal — a forecast fitted straight through a repo onboarding, which is the failure the
  // coverage rule was written to prevent, arriving by a different door.
  //
  // The comparable test is the repo SET, which is why `repo_ids_json` is on the row (§6.4). It was
  // being written and read nowhere.
  const scopeKey = [...scopeRepoIds].sort((a, b) => a - b).join(',');
  return Promise.all(
    keys.map(async (key): Promise<PeriodForecast> => {
      const values = history.map((h) => {
        if (!h.coverage.complete) return null;
        // A row predating the column has no set to compare and cannot be shown to be comparable.
        // Excluding it costs a forecast point; including it risks fitting across a membership
        // change, which is the error that matters.
        if (h.repoIds.length === 0) return null;
        if ([...h.repoIds].sort((a, b) => a - b).join(',') !== scopeKey) return null;
        return metricMap(h.metrics).get(key)?.value ?? null;
      });
      // The three 0–100 metrics declare their ceiling; everything else has none. Core will not
      // infer one — see the seam's comment for why inferring would truncate a real count forecast.
      const outcome = (await ctx.queries.computePeriodForecast(
        values,
        PCT_METRIC_KEYS.has(key) ? { max: 100 } : undefined,
      )) as ForecastOutcome;
      if ('refused' in outcome) return { available: false, key, reason: outcome.refused };
      return {
        available: true,
        key,
        point: outcome.point,
        low: outcome.low,
        high: outcome.high,
        basis: outcome.basis,
        periodsUsed: outcome.periodsUsed,
      };
    }),
  );
}

// ── The payload hash ─────────────────────────────────────────────────────────────────────────

/**
 * The $0-on-unchanged key.
 *
 * Folds: the metric values, the comparison, the forecast, the cadence, the repo id set, the
 * metrics schema version AND the model. Folds NOTHING `Date.now()`-derived — every input is a
 * function of stored rows and the fixed period window.
 *
 * The `p1|` prefix versions the FORMULA itself: changing what goes in bumps it, exactly like the
 * annotations hash's `t1|…t4|` walk, so a formula change invalidates once rather than leaving
 * two writers computing different hashes for the same row forever.
 */
function payloadHashFor(
  workspaceId: number,
  window: PeriodWindow,
  repoIds: number[],
  model: string,
  report: PeriodReport,
): string {
  const parts = [
    // p1 → p2 → p3: the forecast's fit basis, then the lane breakdown, joined the formula. A
    // prefix bump on a formula change is deliberate — every stored row's hash moves once, so the
    // next open regenerates it rather than serving a row hashed under different rules forever.
    'p3',
    `ws:${workspaceId}`,
    // ⚠ THE GRAIN NEEDS NO PART OF ITS OWN, AND ADDING ONE WOULD COST A TABLE OF ARTIFACTS.
    // `k:` already carries it — `sprint-2026-08-18` and `month-2026-08` are disjoint key shapes —
    // and `cad:` carries the window's real length. A `g:` part would discriminate nothing new
    // while forcing a `p3` → `p4` prefix bump (a formula change invalidates once, by design), and
    // that bump would flip every stored sprint report to `stale` at once, inviting a regenerate
    // that BILLS, to express a distinction the key already makes.
    `k:${window.key}`,
    `cad:${window.cadenceDays}`,
    `v:${PERIOD_METRICS_SCHEMA_VERSION}`,
    `m:${model}`,
    `repos:${[...repoIds].sort((a, b) => a - b).join(',')}`,
    `cov:${report.coverage.trackedRepos}/${report.coverage.totalRepos}`,
    ...report.metrics.map((m) => `met:${m.key}=${m.value ?? '~'}/${m.sampleSize}`),
    `cmp:${report.comparison.refusal ?? 'ok'}:${report.comparison.subsetRepoIds.join(',')}`,
    ...report.comparison.deltas.map(
      (d) => `d:${d.key}=${d.value ?? '~'}<${d.prior ?? '~'}:${d.significant ? 1 : 0}`,
    ),
    ...report.forecasts.map((f) =>
      f.available ? `f:${f.key}=${f.point}/${f.low}/${f.high}` : `f:${f.key}=x:${f.reason}`,
    ),
    // WHAT THE PROJECTION WAS FITTED ON — the repo subset and the depth, via the disclosure
    // string that states both. It belongs in the hash because it is a real INPUT to the forecast,
    // not a caption: the same bands fitted on 6 of 8 repos and on all 8 are different claims, and
    // without this a subset that changed (a repo crossing the tracking threshold) could leave a
    // stale sentence sitting under numbers that happened to round the same way.
    `fit:${report.forecastDisclosure ?? 'none'}`,
    // WHO DID THE WORK. In the hash because it is a claim the report makes, not a caption: a
    // reclassified actor (a bot someone marks human, a newly-recognised dependency bot) moves
    // real numbers on the page, and without this the stored row would keep asserting the old
    // split under figures that no longer match it.
    ...(report.lanes
      ? [
          ...report.lanes.lanes.map(
            (l) => `lane:${l.lane}=${l.mergedPrs}/${l.openedPrs}/${l.comments}/${l.approvals}`,
          ),
          // The human-only first-review median. In the hash because it is the figure that
          // CONTRADICTS the table above it (0h reported vs 18.3h real, where a CI bot
          // auto-approves), so a stored row must never keep serving a stale one.
          `humanTtfr:${report.lanes.medianTimeToFirstHumanReviewHours ?? '~'}`,
        ]
      : ['lane:none']),
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

// ── Building one period ──────────────────────────────────────────────────────────────────────

export interface BuiltPeriod {
  report: PeriodReport;
  payloadHash: string;
  dataFingerprint: string;
  repoIds: number[];
}

/**
 * The full computation for one period: headline metrics over the workspace's CURRENT membership,
 * coverage, the like-for-like comparison over the coverage-stable subset, forecasts, ranked
 * movements and bound questions. No model call, no credits — narration is layered on afterwards.
 *
 * ⚠ IT COSTS THREE METRIC SCANS (headline + both sides of the subset comparison) BY DESIGN, and
 * §4 says not to optimise that away. The headline is what the reader means by "this period"; the
 * comparison has to be recomputed over the intersection of the two tracked sets or it is
 * measuring repo onboarding. Generation is manual and cached, so the cost is paid once per
 * artifact.
 */
export async function buildPeriod(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  grid: PeriodGrid,
  window: PeriodWindow,
  model: string,
  history: HistoryPeriod[],
  priorRows: ReportRow[],
): Promise<BuiltPeriod> {
  const repoIds = scope.repoIds;
  const [headline, trackedNow, lanes] = await Promise.all([
    metricsFor(ctx, accountId, scope, window),
    coverageFor(ctx, accountId, repoIds, window.fromMs),
    // Over the FULL current membership, like the headline — "how much of this period was a
    // person" is a question about the workspace as it is, not about the comparison subset.
    lanesFor(ctx, accountId, scope, window),
  ]);
  const coverage: PeriodCoverage = {
    trackedRepos: trackedNow.trackedRepoIds.length,
    totalRepos: repoIds.length,
    complete: trackedNow.trackedRepoIds.length === repoIds.length,
  };

  // ---- the comparison ----
  let refusal: PeriodRefusalReason | null = null;
  let subsetRepoIds: number[] = [];
  let deltas: PeriodMetricDelta[] = [];
  let priorPeriodKey: string | null = null;

  // ⚠ THE FLOOR IS THE LOOK-BACK HORIZON, NOT INDEX 0.
  //
  // This used to read `window.index === 0`, treating the configured sprint start as the beginning
  // of recorded history. It is not — it is a PHASE ANCHOR, and `completedWindows` and
  // `backfillHistory` both already extend to NEGATIVE indices for exactly that reason. The old
  // guard therefore refused a comparison for the period at index 0 while the period BEFORE it was
  // listed, stored and readable, and its metrics were computable by the same scan every other
  // prior period gets. The horizon is the real boundary: below it we decline to scan at all, so
  // below it there genuinely is no prior period.
  //
  // At month grain index 0 is January 1970, so the old guard was unreachable there — but leaving
  // a wrong condition in place for a grain that cannot hit it is how it comes back.
  const priorIndex = window.index - 1;
  if (priorIndex < grid.currentIndex - MAX_HISTORY_PERIODS) {
    refusal = 'no_prior_period';
  } else {
    const prior = windowAt(grid, priorIndex);
    priorPeriodKey = prior.key;
    const storedPrior = newestRow(rowsForPeriod(priorRows, prior.key));
    // ⚠ GRAIN FIRST; THE DAY COUNT ONLY WITHIN THE SPRINT GRAIN — the rule `grainCurrentPool`
    // states in full. January is 31 days and February is 28, so a bare
    // `storedPrior.cadenceDays !== window.cadenceDays` (which is what this was) refuses EVERY
    // month-over-month comparison, silently, and month-over-month is the whole point of the grain.
    const priorIncomparable =
      storedPrior != null &&
      (rowGrain(storedPrior) !== window.grain ||
        (window.grain === 'sprint' && storedPrior.cadenceDays !== window.cadenceDays));
    if (priorIncomparable) {
      // §5/§6.2: two rows measured over different-length windows are not subtractable, and a
      // silent subtraction would read as a real halving/doubling of every count.
      refusal = 'cadence_changed';
    } else {
      const trackedPrior = await coverageFor(ctx, accountId, repoIds, prior.fromMs);
      const priorSet = new Set(trackedPrior.trackedRepoIds);
      subsetRepoIds = trackedNow.trackedRepoIds
        .filter((id) => priorSet.has(id))
        .sort((a, b) => a - b);
      if (subsetRepoIds.length === 0) {
        refusal = 'partial_coverage';
      } else {
        // ⚠ NARROWING a resolved scope, never widening one. `scope` came from
        // `resolveRequestScope`, so `repoIds ⊆ the workspace's membership`; an intersection of
        // that set with itself keeps the invariant, and `workspaceId` (which decides who counts
        // as a bot) is carried through unchanged.
        const subsetScope: BotScopeWire = { workspaceId: scope.workspaceId, repoIds: subsetRepoIds };
        const [curSubset, priSubset] = await Promise.all([
          metricsFor(ctx, accountId, subsetScope, window),
          metricsFor(ctx, accountId, subsetScope, prior),
        ]);
        deltas = buildDeltas(curSubset.metrics, priSubset.metrics);
      }
    }
  }

  const subsetDisclosure =
    refusal != null
      ? ''
      : `covers ${subsetRepoIds.length} of ${repoIds.length} repos tracked across both periods`;

  const movements = rankMovements(deltas);

  // ── The forecast series ───────────────────────────────────────────────────────────────────
  // Fitted on ONE repo subset, RE-MEASURED per period (see `ForecastSeries`), rather than on the
  // stored headline metrics — those were each measured over whatever the membership was that day,
  // and a line through them is a line through an onboarding schedule.
  //
  // ⚠ THE FORECAST IS REFUSED OUTRIGHT AT CALENDAR-MONTH GRAIN, AND THAT IS THE CHOICE, NOT AN
  // OVERSIGHT.
  //
  // `db/forecast.ts` fits Theil-Sen on x = the ARRAY INDEX — the series is assumed EQUALLY SPACED,
  // which is exactly true of an arithmetic sprint grid and false of the calendar: 28 to 31 days is
  // a ±5.4% swing in every COUNT metric, and the estimator has no way to read it as anything but
  // signal. February would look like a genuine dip EVERY YEAR, and the MAD band would sit
  // confidently around it.
  //
  // The alternative — normalising counts to a per-day rate before fitting — was rejected for two
  // reasons. Core's estimator is deliberately told NOTHING about which metric it is fitting (the
  // same reason `PCT_METRIC_KEYS` lives here and not there), so the plugin would have to classify
  // all fifteen keys as count / median / percentage and get every one right, silently. And a
  // per-day projection is a DIFFERENT METRIC from the one in the table above it ("2.4 merged PRs
  // per day" against "merged PRs"): redefining a key's units per grain is precisely what
  // `PERIOD_METRICS_SCHEMA_VERSION` exists to forbid.
  //
  // So it refuses, NAMED (`uneven_periods`) — a blank band and a confident band around an artifact
  // are the same pixel to a reader, which is the rule this whole estimator is built on.
  const chosen: ForecastSeries =
    grid.grain === 'month'
      ? { windows: [], repoIds: [], refusal: 'uneven_periods' }
      : await chooseForecastSeries(ctx, accountId, scope, grid, window);
  let forecasts: PeriodForecast[];
  let forecastDisclosure: string | null = null;
  if (chosen.refusal != null) {
    forecasts = PERIOD_METRIC_KEYS.map((key) => ({
      available: false,
      key,
      reason: chosen.refusal!,
    }));
  } else {
    const forecastScope: BotScopeWire = {
      workspaceId: scope.workspaceId,
      repoIds: chosen.repoIds,
    };
    // One scan per period, at most FORECAST_HISTORY of them. This is a manual, cached generation,
    // and the alternative is a number that cannot be trusted.
    const measured = await Promise.all(
      chosen.windows.map(async (win) => ({
        win,
        metrics: (await metricsFor(ctx, accountId, forecastScope, win)).metrics,
      })),
    );
    const series: HistoryPeriod[] = measured.map((m) => ({
      key: m.win.key,
      fromMs: m.win.fromMs,
      toMs: m.win.toMs,
      metrics: m.metrics,
      // Complete BY CONSTRUCTION: every repo in the subset was tracked at the oldest window's
      // start, so it was tracked at every later one too.
      coverage: {
        trackedRepos: chosen.repoIds.length,
        totalRepos: chosen.repoIds.length,
        complete: true,
      },
      repoIds: chosen.repoIds,
    }));
    forecasts = await buildForecasts(ctx, series, chosen.repoIds);
    forecastDisclosure =
      chosen.repoIds.length === repoIds.length
        ? `fitted on all ${repoIds.length} repos over ${series.length} periods`
        : `fitted on the ${chosen.repoIds.length} of ${repoIds.length} repos tracked across all ${series.length} periods`;
  }

  const report: PeriodReport = {
    periodKey: window.key,
    periodStart: new Date(window.fromMs).toISOString(),
    periodEnd: new Date(window.toMs).toISOString(),
    // The WINDOW's grain (see `rowGrain`) — one of the four sites that hard-coded 'sprint'.
    grain: window.grain,
    cadenceDays: window.cadenceDays,
    coverage,
    metrics: headline.metrics,
    comparison: { priorPeriodKey, subsetRepoIds, subsetDisclosure, deltas, refusal },
    forecasts,
    lanes,
    // Which repos and how many periods the projection was actually fitted on. A forecast over 6 of
    // 8 repos is a useful statement ONLY if the reader is told that is what it is.
    ...(forecastDisclosure != null ? { forecastDisclosure } : {}),
    movements,
    suggested: buildSuggestedQuestions(movements, {
      periodKey: window.key,
      fromMs: window.fromMs,
      toMs: window.toMs,
      // The pills drill into what the COMPARISON measured when there is one (the stable subset),
      // and into the full membership otherwise — the same repos the number beside them came from.
      repoIds: subsetRepoIds.length > 0 ? subsetRepoIds : repoIds,
    }),
    narrative: null,
    model: null,
    metricsSchemaVersion: PERIOD_METRICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stale: false,
  };

  return {
    report,
    payloadHash: payloadHashFor(scope.workspaceId, window, repoIds, model, report),
    dataFingerprint: headline.fingerprint,
    repoIds,
  };
}

// ── MONTH TO DATE: the one LIVE period, and the one that is never stored ─────────────────────

/**
 * The OPEN calendar month, computed on the request.
 *
 * ⚠ IT IS NEVER PERSISTED, NEVER NARRATED, NEVER BILLED, AND MUST NOT BECOME A STORED ROW. Two
 * independent mechanisms make an open period unstorable, and both are load-bearing elsewhere:
 *
 *   (a) The free cached-read GET recomputes every stored row's DATA FINGERPRINT and compares it to
 *       the stored one. That fingerprint folds every metric VALUE — so an open month's fingerprint
 *       moves on every merge, every comment, every CI run. A stored month-to-date row would read
 *       `stale: true` on essentially every load, forever, next to a Generate button, which is the
 *       "permanent staleness invites the regenerate that destroys the artifact" defect the cadence
 *       work closed at a different grain.
 *   (b) `payloadHashFor` folds NOTHING `Date.now()`-derived, deliberately, or a dormant workspace
 *       re-bills on a timer. An open period's upper bound IS `Date.now()`, so it could not enter
 *       that hash honestly at all.
 *
 * So: no row, no `payload_hash`, no `data_fingerprint`, no model call, no credits, no
 * `stale` flag and no Generate button. `inProgress: true` is what the SPA captions it with, and
 * "in progress" is a different sentence from "not generated yet".
 *
 * ⚠ THE COMPARISON IS AN ELAPSED-SLICE COMPARISON, NOT MONTH-AGAINST-MONTH. Seventeen days of
 * August against the whole of July is a 45% "drop" that is entirely the calendar. Both sides are
 * measured over the SAME number of milliseconds from their own month's start, so the subtraction
 * is real — and, per the standing rule, over the COVERAGE-STABLE SUBSET of repos tracked at both
 * month starts, exactly like a completed period's comparison.
 *
 * ⚠ ONE ROW STILL NEVER MIXES THE TWO POPULATIONS. The HEADLINE covers `[monthStart, now)` over
 * the full membership; the DELTAS cover the clamped slice over the stable subset. That is the same
 * headline-vs-subset split `rowFigures()` already resolves, so no new rule is needed on the client
 * — but the slice length is stated in `subsetDisclosure` because it is a second axis on which the
 * two populations differ, and a disclosure the reader cannot see is not a disclosure.
 *
 * ⚠ NO FORECAST. A projection needs completed, equally-spaced periods; this one is neither. Every
 * key refuses with `uneven_periods`, the same named refusal the month grain uses throughout.
 */
export async function buildMonthToDate(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  nowMs: number,
): Promise<PeriodReport> {
  const repoIds = scope.repoIds;
  const grid: PeriodGrid = { grain: 'month', currentIndex: monthIndexOf(nowMs) };
  const open = windowAt(grid, grid.currentIndex);
  const prior = windowAt(grid, grid.currentIndex - 1);
  // The headline window: month start → NOW, half-open like every other predicate in this feature.
  const headWindow: PeriodWindow = { ...open, toMs: nowMs };

  const [headline, trackedNow, lanes, trackedPrior] = await Promise.all([
    metricsFor(ctx, accountId, scope, headWindow),
    coverageFor(ctx, accountId, repoIds, open.fromMs),
    lanesFor(ctx, accountId, scope, headWindow),
    coverageFor(ctx, accountId, repoIds, prior.fromMs),
  ]);
  const coverage: PeriodCoverage = {
    trackedRepos: trackedNow.trackedRepoIds.length,
    totalRepos: repoIds.length,
    complete: trackedNow.trackedRepoIds.length === repoIds.length,
  };

  // ⚠ THE SLICE IS CLAMPED TO THE SHORTER OF THE TWO MONTHS, AND BOTH SIDES USE THE CLAMPED
  // LENGTH. On 31 March, 30 days have elapsed and February only has 28 — comparing 30 days of
  // March against "all of February plus two days that do not exist" is not a comparison. Clamping
  // ONE side would be worse: it would subtract windows of different lengths, which is the exact
  // thing `cadence_changed` exists to refuse.
  const priorLenMs = prior.toMs - prior.fromMs;
  const sliceMs = Math.max(0, Math.min(nowMs - open.fromMs, priorLenMs));
  const elapsedDays = Math.max(0, Math.floor((nowMs - open.fromMs) / 86_400_000));

  let refusal: PeriodRefusalReason | null = null;
  let subsetRepoIds: number[] = [];
  let deltas: PeriodMetricDelta[] = [];
  const priorSet = new Set(trackedPrior.trackedRepoIds);
  subsetRepoIds = trackedNow.trackedRepoIds.filter((id) => priorSet.has(id)).sort((a, b) => a - b);
  if (subsetRepoIds.length === 0) {
    refusal = 'partial_coverage';
  } else {
    const subsetScope: BotScopeWire = { workspaceId: scope.workspaceId, repoIds: subsetRepoIds };
    const [curSubset, priSubset] = await Promise.all([
      metricsFor(ctx, accountId, subsetScope, { fromMs: open.fromMs, toMs: open.fromMs + sliceMs }),
      metricsFor(ctx, accountId, subsetScope, {
        fromMs: prior.fromMs,
        toMs: prior.fromMs + sliceMs,
      }),
    ]);
    deltas = buildDeltas(curSubset.metrics, priSubset.metrics);
  }

  const sliceDays = Math.max(0, Math.round(sliceMs / 86_400_000));
  const subsetDisclosure =
    refusal != null
      ? ''
      : `covers ${subsetRepoIds.length} of ${repoIds.length} repos tracked across both months, ` +
        `over the first ${sliceDays} day${sliceDays === 1 ? '' : 's'} of each`;

  return {
    periodKey: open.key,
    periodStart: new Date(open.fromMs).toISOString(),
    // The window's true end. The SPA titles a month by NAME, so this is never rendered as a
    // boundary date — and the headline figures stop at `now`, which `elapsedDays` states.
    periodEnd: new Date(open.toMs).toISOString(),
    grain: 'month',
    cadenceDays: open.cadenceDays,
    coverage,
    metrics: headline.metrics,
    comparison: {
      priorPeriodKey: prior.key,
      subsetRepoIds,
      subsetDisclosure,
      deltas,
      refusal,
    },
    // A projection needs completed, equally-spaced periods. This is neither.
    forecasts: PERIOD_METRIC_KEYS.map((key) => ({
      available: false,
      key,
      reason: 'uneven_periods' as const,
    })),
    lanes,
    movements: rankMovements(deltas),
    // The drill-down pills are bound to a STORED report's window and metric; an open period has
    // no stored report to bind to and no narration to drill into.
    suggested: [],
    narrative: null,
    model: null,
    metricsSchemaVersion: PERIOD_METRICS_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    // ⚠ ALWAYS FALSE. `stale` offers a REGENERATION, and there is nothing here to regenerate —
    // every read of this route recomputes it from scratch. See the header.
    stale: false,
    inProgress: true,
    elapsedDays,
  };
}

/** A stored row → the wire shape. The only computed field is `stale`, which the caller supplies
 *  from a fresh fingerprint. */
/** What wrote a stored narrative (Phase 4) — present only when the row recorded it. */
function ranOnOf(row: Pick<ReportRow, 'ranModel' | 'provider'>): Pick<PeriodReport, 'ranModel' | 'provider'> {
  const out: Pick<PeriodReport, 'ranModel' | 'provider'> = {};
  if (row.ranModel) out.ranModel = row.ranModel;
  if (row.provider === 'claude' || row.provider === 'codex') out.provider = row.provider;
  return out;
}

function rowToReport(row: ReportRow, stale: boolean): PeriodReport {
  return {
    periodKey: row.periodKey,
    periodStart: tsToIso(row.periodStart),
    periodEnd: tsToIso(row.periodEnd),
    // ⚠ READ FROM THE COLUMN, never assumed. This was the load-bearing one of the four hard-coded
    // sites: a stored month row would have been SERVED as `grain: 'sprint'`, so the SPA would have
    // titled "August 2026" with the sprint formatter ("1 Aug – 1 Sep", a 32-day span) and the
    // narration prompt would have been handed the sprint grain's month-word ban for a document
    // that IS a month.
    grain: rowGrain(row),
    cadenceDays: row.cadenceDays,
    coverage: parseJson<PeriodCoverage>(row.coverageJson, {
      trackedRepos: 0,
      totalRepos: 0,
      complete: false,
    }),
    metrics: parseJson<PeriodMetricValue[]>(row.metricsJson, []),
    comparison: parseJson<PeriodReport['comparison']>(row.comparisonJson, {
      priorPeriodKey: null,
      subsetRepoIds: [],
      subsetDisclosure: '',
      deltas: [],
      refusal: null,
    }),
    ...readForecastJson(row.forecastJson),
    // Absent on a row predating migration 0026 — the SPA renders no panel rather than 0%.
    ...(row.lanesJson ? { lanes: parseJson<PeriodLanes>(row.lanesJson, undefined as never) } : {}),
    movements: parseJson<PeriodMovement[]>(row.movementsJson, []),
    suggested: parseJson<PeriodReport['suggested']>(row.suggestedJson, []),
    narrative: row.narrativeMd,
    // '' is the stored "un-narrated" sentinel; the wire says null.
    model: row.model != null && row.model !== '' ? row.model : null,
    ...ranOnOf(row),
    metricsSchemaVersion: row.metricsSchemaVersion,
    generatedAt: tsToIso(row.generatedAt),
    stale,
  };
}

/** Stored rows → the forecast/chat history, oldest-first. Metrics are identical across a period's
 *  model variants (only the narration differs), so the newest row per period is representative.
 *
 *  ⚠ IT FILTERS ON GRAIN (and, within the sprint grain, on cadence), and the filter lives HERE
 *  rather than at the call sites on purpose.
 *  This array feeds the period chat's grounding (`chatPayload`'s `history`), which the prompt tells
 *  the model to read as ONE SERIES — so a mixed 14-day and 7-day history hands it counts that are
 *  half the size for no reason it can see, under a `historyBasis` promising they are comparable.
 *  `comparableToCurrentPeriod` cannot catch it either: that flag compares REPO SETS, and a cadence
 *  change leaves the repos identical. (The forecast fit is safe by a different route —
 *  `chooseForecastSeries` re-measures every window live off the CURRENT grid — but it is safe by
 *  accident there, so this fold is not allowed to rely on it.) */
function historyFromRows(rows: ReportRow[], window: PeriodWindow): HistoryPeriod[] {
  const byKey = new Map<string, ReportRow>();
  for (const r of windowCurrentPool(rows, window)) {
    const seen = byKey.get(r.periodKey);
    if (seen == null || tsToMs(r.generatedAt) > tsToMs(seen.generatedAt)) byKey.set(r.periodKey, r);
  }
  return [...byKey.values()]
    .map((r) => ({
      key: r.periodKey,
      fromMs: tsToMs(r.periodStart),
      toMs: tsToMs(r.periodEnd),
      metrics: parseJson<PeriodMetricValue[]>(r.metricsJson, []),
      coverage: parseJson<PeriodCoverage>(r.coverageJson, {
        trackedRepos: 0,
        totalRepos: 0,
        complete: false,
      }),
      repoIds: parseJson<number[]>(r.repoIdsJson, []),
    }))
    .sort((a, b) => a.fromMs - b.fromMs);
}

// ── Backfill ─────────────────────────────────────────────────────────────────────────────────

/**
 * On first generate, compute and store up to `BACKFILL_PERIODS` PRIOR periods — METRICS ONLY
 * (`narrative_md = null`, `model = ''`). No LLM, no credits, no narration.
 *
 * This is what gives the forecast a real series immediately instead of "insufficient history" for
 * the first four sprints. It is BOUNDED and skips periods that already have a row, so a second
 * generate costs nothing; a period is never recomputed once stored (§6.3 immutability applies to
 * backfilled rows too).
 */
async function backfillHistory(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  grid: PeriodGrid,
  before: PeriodWindow,
  existing: ReportRow[],
): Promise<void> {
  const have = new Set(existing.map((r) => r.periodKey));
  const now = new Date();
  for (let i = 1; i <= BACKFILL_PERIODS; i += 1) {
    const index = before.index - i;
    // NEGATIVE indices are backfilled too — the sprint start is a phase anchor, not the start of
    // history (see `completedWindows`). Stopping at 0 meant a team who set their cadence recently
    // could never accumulate the four periods a forecast needs, no matter how much data they had.
    if (index < grid.currentIndex - MAX_HISTORY_PERIODS) break;
    const win = windowAt(grid, index);
    if (have.has(win.key)) continue;
    const [metrics, tracked] = await Promise.all([
      metricsFor(ctx, accountId, scope, win),
      coverageFor(ctx, accountId, scope.repoIds, win.fromMs),
    ]);
    const coverage: PeriodCoverage = {
      trackedRepos: tracked.trackedRepoIds.length,
      totalRepos: scope.repoIds.length,
      complete: tracked.trackedRepoIds.length === scope.repoIds.length,
    };
    const report: PeriodReport = {
      periodKey: win.key,
      periodStart: new Date(win.fromMs).toISOString(),
      periodEnd: new Date(win.toMs).toISOString(),
      // The WINDOW's grain — one of the four hard-coded sites (see `rowGrain`).
      grain: win.grain,
      cadenceDays: win.cadenceDays,
      coverage,
      metrics: metrics.metrics,
      // A backfilled row carries no comparison, forecast or questions: it exists to be a POINT IN
      // A SERIES, and computing three more scans per period to derive a comparison nobody asked
      // for is exactly the unbounded cost this backfill is capped to avoid.
      comparison: {
        priorPeriodKey: null,
        subsetRepoIds: [],
        subsetDisclosure: '',
        deltas: [],
        refusal: null,
      },
      forecasts: [],
      movements: [],
      suggested: [],
      narrative: null,
      model: null,
      metricsSchemaVersion: PERIOD_METRICS_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      stale: false,
    };
    await persistReport(ctx, {
      accountId,
      workspaceId: scope.workspaceId,
      window: win,
      model: '',
      report,
      repoIds: scope.repoIds,
      payloadHash: payloadHashFor(scope.workspaceId, win, scope.repoIds, '', report),
      dataFingerprint: metrics.fingerprint,
      creditsSpent: null,
      inputTokens: null,
      outputTokens: null,
      generatedAt: now,
    });
  }
}

// ── Listing ──────────────────────────────────────────────────────────────────────────────────

/**
 * The periods the Reports surface offers: every stored row AT THE CURRENT CADENCE that still lands
 * on the grid, UNION the most recent completed periods on that grid (so a workspace that has never
 * generated anything still has something to click). Newest first.
 *
 * The calendar half needs a coverage read per period to fill `coverageComplete` — indexed,
 * DB-only, bounded by `LIST_PERIODS`, and only for periods with no stored row, so it converges to
 * zero extra work after the first generate.
 *
 * ⚠ IT RETURNS TWO LISTS, AND THE SPLIT IS DEFECT (b)'s FIX. This used to emit EVERY stored row
 * regardless of grid alignment, while the detail GET refuses a key that does not align
 * (`windowForKey` → null → `report: null`). After a 14 → 21 change most of the history therefore
 * stayed CLICKABLE and opened as the ordinary "this period has not been generated yet" empty state
 * — indistinguishable from a period nobody has run, with nothing on screen saying the cadence had
 * moved underneath it.
 *
 * So a stored row now lands in exactly one of two places:
 *   • `periods` — its cadence matches AND `windowForKey` resolves it. Clickable, and the detail GET
 *     will serve it.
 *   • `archived` — anything else (a retired cadence, or a row that has aged past the look-back
 *     horizon). Named, dated, labelled with the cadence it was measured under, and readable at
 *     `archivedKeyFor(...)`. NOTHING IS DELETED AND NOTHING IS REWRITTEN: a report only stops being
 *     listed when it is ERASED, never because a setting changed or time passed.
 */
export interface PeriodListing {
  periods: PeriodReportListItem[];
  /** Stored artifacts that the CURRENT grid cannot name. Preserved, not destroyed. */
  archived: PeriodArchivedReport[];
}

export async function listPeriods(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  grid: PeriodGrid,
): Promise<PeriodListing> {
  // ⚠ EVERY LIST IS SCOPED TO ONE GRAIN. A month row seen from a sprint grid is not an archived
  // artifact — it is a live period on the OTHER grid, one toggle away — so it must appear in
  // neither list here. Folding it into `archived` would show the whole calendar history under
  // "Earlier cadences" the moment anyone generated a month report, and list every document twice.
  const allRows = (await loadRows(ctx, accountId, scope.workspaceId)).filter(
    (r) => rowGrain(r) === grid.grain,
  );
  const rows = grainCurrentPool(allRows, grid);
  const items = new Map<string, PeriodReportListItem>();
  // ⚠ THE OPEN PERIOD, AT MONTH GRAIN ONLY, AND IT IS NEVER A STORED ROW. Month-to-date is a live
  // read: no `Generate`, no persistence, no staleness flag, no narration, no billing (see
  // `buildMonthToDate`). It is listed because a reader looking for "how is this month going" will
  // look in the period picker, and it carries `inProgress` so the SPA reads it from the
  // month-to-date route rather than from a stored row that does not and must not exist.
  //
  // There is no sprint equivalent on purpose: the in-progress SPRINT is already the whole subject
  // of the free flow-metrics header on this same pane, and duplicating it here would put the same
  // figures on two surfaces under two headings.
  if (grid.grain === 'month') {
    const open = windowAt(grid, grid.currentIndex);
    const tracked = await coverageFor(ctx, accountId, scope.repoIds, open.fromMs);
    items.set(open.key, {
      periodKey: open.key,
      periodStart: new Date(open.fromMs).toISOString(),
      // The window's real end — the SPA titles a month by its name, not by this boundary.
      periodEnd: new Date(open.toMs).toISOString(),
      cadenceDays: open.cadenceDays,
      hasNarrative: false,
      model: null,
      coverageComplete: tracked.trackedRepoIds.length === scope.repoIds.length,
      grain: 'month',
      inProgress: true,
    });
  }
  for (const win of completedWindows(grid, LIST_PERIODS)) {
    const stored = rowsForPeriod(rows, win.key);
    // Pool first (schema currency beats everything); the existence gate stays on the raw list so
    // a period holding ONLY old-schema rows still lists — it serves stale until regenerated.
    const pool = schemaCurrentPool(stored);
    const narrated = pool.find((r) => r.narrativeMd != null && r.narrativeMd !== '');
    if (stored.length > 0) {
      const rep = narrated ?? newestRow(pool)!;
      items.set(win.key, {
        periodKey: win.key,
        periodStart: tsToIso(rep.periodStart),
        periodEnd: tsToIso(rep.periodEnd),
        cadenceDays: rep.cadenceDays,
        hasNarrative: narrated != null,
        model: narrated?.model != null && narrated.model !== '' ? narrated.model : null,
        ...(narrated ? ranOnOf(narrated) : {}),
        coverageComplete: parseJson<PeriodCoverage>(rep.coverageJson, {
          trackedRepos: 0,
          totalRepos: 0,
          complete: false,
        }).complete,
        grain: rowGrain(rep),
      });
      continue;
    }
    const tracked = await coverageFor(ctx, accountId, scope.repoIds, win.fromMs);
    items.set(win.key, {
      periodKey: win.key,
      periodStart: new Date(win.fromMs).toISOString(),
      periodEnd: new Date(win.toMs).toISOString(),
      cadenceDays: win.cadenceDays,
      hasNarrative: false,
      model: null,
      coverageComplete: tracked.trackedRepoIds.length === scope.repoIds.length,
      grain: win.grain,
    });
  }
  // Stored periods at the CURRENT cadence that have fallen outside the calendar window but still
  // resolve on the grid are still real artifacts someone may hold a link to — a report only stops
  // being listed when it is erased, never because time passed.
  for (const r of rows) {
    if (items.has(r.periodKey)) continue;
    // ⚠ THE ALIGNMENT GATE (defect (b)). `windowForKey` is what the detail GET consults; anything
    // it refuses would list as clickable and open blank. Such a row is not dropped — it falls
    // through to the archive below.
    if (windowForKey(grid, r.periodKey) == null) continue;
    const stored = schemaCurrentPool(rowsForPeriod(rows, r.periodKey));
    const narrated = stored.find((s) => s.narrativeMd != null && s.narrativeMd !== '');
    // Metadata reads from the pool's representative too — same row the GET would serve.
    const rep = narrated ?? newestRow(stored)!;
    items.set(r.periodKey, {
      periodKey: r.periodKey,
      periodStart: tsToIso(rep.periodStart),
      periodEnd: tsToIso(rep.periodEnd),
      cadenceDays: rep.cadenceDays,
      hasNarrative: narrated != null,
      model: narrated?.model != null && narrated.model !== '' ? narrated.model : null,
      ...(narrated ? ranOnOf(narrated) : {}),
      coverageComplete: parseJson<PeriodCoverage>(rep.coverageJson, {
        trackedRepos: 0,
        totalRepos: 0,
        complete: false,
      }).complete,
      grain: rowGrain(rep),
    });
  }

  // ---- the archive ----
  // Everything stored that the live list could not name: a retired cadence, or a period that has
  // aged past MAX_HISTORY_PERIODS. One entry per (period, cadence) — the model axis collapses the
  // same way it does above, because an archived entry is a pointer, not the document.
  const archived = new Map<string, PeriodArchivedReport>();
  for (const r of allRows) {
    const live =
      grainCurrentPool([r], grid).length > 0 &&
      (items.has(r.periodKey) || windowForKey(grid, r.periodKey) != null);
    if (live) continue;
    const key = archivedKeyFor(r.periodKey, r.cadenceDays);
    const seen = archived.get(key);
    const narrated = r.narrativeMd != null && r.narrativeMd !== '';
    if (seen != null) {
      // A narrated sibling wins the label; otherwise leave what is there.
      if (narrated && !seen.hasNarrative) {
        archived.set(key, {
          ...seen,
          hasNarrative: true,
          model: r.model != null && r.model !== '' ? r.model : null,
        });
      }
      continue;
    }
    archived.set(key, {
      archivedKey: key,
      periodKey: r.periodKey,
      periodStart: tsToIso(r.periodStart),
      periodEnd: tsToIso(r.periodEnd),
      cadenceDays: r.cadenceDays,
      hasNarrative: narrated,
      model: narrated && r.model != null && r.model !== '' ? r.model : null,
      grain: rowGrain(r),
      // Why the live grid cannot name it. Two distinct facts, and a reader needs to be told which:
      // a cadence change is a setting somebody made and can undo, an aged-out row is not.
      //
      // ⚠ ONLY THE SPRINT GRAIN CAN PRODUCE A CADENCE CHANGE. A month row's day count is the
      // length of that calendar month, so a February row (28) beside a January one (31) is not a
      // retired setting — at month grain the only reason a stored row cannot be named is age.
      reason:
        grid.grain === 'sprint' && r.cadenceDays !== grid.cadenceDays
          ? 'cadence_changed'
          : 'outside_history',
    });
  }

  return {
    periods: [...items.values()].sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1)),
    archived: [...archived.values()].sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1)),
  };
}

/**
 * ONE ARCHIVED artifact, read at its explicit `<periodKey>@cad<days>` key.
 *
 * ⚠ IT IS FROZEN, AND IT REPORTS NO STALENESS. A stored report's `stale` flag exists to offer a
 * REGENERATION; an archived row cannot be regenerated at all (its window is not on the current
 * grid, so `windowForKey` refuses it and `generatePeriodReport` never runs), so a stale badge here
 * would name an action that does not exist — and, before migration 0029, the regenerate it invited
 * was the very thing that destroyed the artifact. `stale: false` is the honest reading of "this
 * document is what it was when it was written", and `archived: true` on the wire is what tells the
 * SPA to caption it that way rather than pretending it is live.
 *
 * It also skips the metrics scan the live GET pays for that flag — cheaper, and for the same
 * reason: there is nothing the answer could change.
 */
export async function loadArchivedReport(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  archivedKey: string,
  preferModel: string | null,
): Promise<PeriodReport | null> {
  const parsed = parseArchivedKey(archivedKey);
  if (parsed == null) return null;
  const rows = cadenceCurrentPool(
    rowsForPeriod(await loadRows(ctx, accountId, scope.workspaceId), parsed.periodKey),
    parsed.cadenceDays,
  );
  if (rows.length === 0) return null;
  const pool = schemaCurrentPool(rows);
  const exact = preferModel != null ? pool.find((r) => r.model === preferModel) : undefined;
  const narrated = pool.find((r) => r.narrativeMd != null && r.narrativeMd !== '');
  const row = exact ?? narrated ?? newestRow(pool)!;
  return { ...rowToReport(row, false), archived: true };
}

// ── The free GET: a stored report + a freshly recomputed staleness flag ──────────────────────

/**
 * The stored artifact for one period, with `stale` recomputed from the CURRENT data.
 *
 * ⚠ IT NEVER GENERATES AND NEVER WRITES. It recomputes only the metric vector's cheap fingerprint
 * (one metrics scan, no model call) and compares it to the stored one. Prefers the narrated row
 * when several models have been run against the period; falls back to the metrics-only backfill
 * row so a never-narrated period still renders its numbers.
 */
export async function loadStoredReport(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  window: PeriodWindow,
  preferModel: string | null,
): Promise<PeriodReport | null> {
  // ⚠ THE HARD CADENCE GUARD. A row whose `cadence_days` differs from the window being asked about
  // measured a different number of days; serving it here would put another window's numbers under
  // this period's heading, and — because the staleness probe recomputes the fingerprint over the
  // NEW window — would mark it `stale: true` forever, inviting a regenerate that (before migration
  // 0029) overwrote the artifact. Filtered out, this period simply reads as "not generated yet",
  // which is TRUE at the new cadence; the old artifact stays readable at its archived key.
  const rows = windowCurrentPool(
    rowsForPeriod(await loadRows(ctx, accountId, scope.workspaceId), window.key),
    window,
  );
  if (rows.length === 0) return null;
  // Schema currency beats the model preference — see schemaCurrentPool.
  const pool = schemaCurrentPool(rows);
  const exact = preferModel != null ? pool.find((r) => r.model === preferModel) : undefined;
  const narrated = pool.find((r) => r.narrativeMd != null && r.narrativeMd !== '');
  const row = exact ?? narrated ?? newestRow(pool)!;
  const fresh = await metricsFor(ctx, accountId, scope, window);
  return rowToReport(row, fresh.fingerprint !== row.dataFingerprint);
}

// ── Generation (the ONE billing path) ────────────────────────────────────────────────────────

export interface GenerateOutcome {
  report: PeriodReport | null;
  generated: boolean;
  creditsExhausted?: boolean;
  /** The receipt for a run that actually billed. Absent on a cached or credit-blocked call, and
   *  that absence is meaningful — the SPA must render it as "nothing spent", never as 0 credits
   *  charged. Shared shape, so it reaches the SPA off the generate response verbatim. */
  spend?: PeriodReportSpend;
}

/**
 * Compute (and backfill), then narrate, then store. Returns the stored report unchanged and
 * `generated: false` whenever nothing was billed.
 *
 * Order matters and every gate is load-bearing:
 *   1. in-flight guard — claimed before any await, so a double-click cannot double-bill;
 *   2. backfill — free, bounded, and needed before the forecast series can be assembled;
 *   3. payload-hash cache — the $0-on-unchanged gate; a re-click on an unchanged period costs
 *      nothing at all, which is what makes an immutable artifact cheap to re-open;
 *   4. credit gate on `.blocked` — the SUMMARY-turn seam (an ALIAS of `summaryBlocked`, NOT an OR
 *      with the agent seam, which meters a different budget). Blocked still stores the METRICS,
 *      because the numbers are free and only the narration is withheld;
 *   5. exactly ONE metered LLM call per user-visible turn. A second call here would have to be
 *      added to `NON_TURN_SUMMARY_FEATURES` in core's db/usage.ts or it would double-count
 *      against the 500/month summary budget.
 */
export async function generatePeriodReport(
  ctx: ProContext,
  llm: LlmClient,
  accountId: number,
  scope: BotScopeWire,
  grid: PeriodGrid,
  window: PeriodWindow,
  model: ReportModel,
  force = true,
): Promise<GenerateOutcome> {
  const runKey = runKeyFor(accountId, scope.workspaceId, window.key, model);
  const now = Date.now();
  const last = reportLastRunAt.get(runKey) ?? 0;
  if (reportInFlight.has(runKey) || (!force && now - last < MIN_INTERVAL_SEC * 1000)) {
    return { report: await loadStoredReport(ctx, accountId, scope, window, model), generated: false };
  }
  reportInFlight.add(runKey);
  reportLastRunAt.set(runKey, now);
  try {
    // ⚠ EVERY ROW READ ON THIS PATH IS CADENCE-SCOPED. The backfill's "already have this period"
    // check, the history series, the prior-period lookup and the $0 cache all key on `periodKey`,
    // and a period key names a START DAY — which the same day can begin at two different cadences.
    // Unfiltered, a 14 → 7 change made the backfill think it already had periods it had never
    // measured at 7 days, and made the cache compare hashes across two different windows.
    const rowsBefore = windowCurrentPool(
      await loadRows(ctx, accountId, scope.workspaceId),
      window,
    );
    await backfillHistory(ctx, accountId, scope, grid, window, rowsBefore);
    const rows = windowCurrentPool(await loadRows(ctx, accountId, scope.workspaceId), window);
    const built = await buildPeriod(
      ctx,
      accountId,
      scope,
      grid,
      window,
      model,
      historyFromRows(rows, window),
      rows,
    );

    // $0-on-unchanged: an existing row for THIS (period, model) whose payload hash matches is
    // returned verbatim, narrative and all.
    const stored = rowsForPeriod(rows, window.key).find((r) => r.model === model);
    if (stored != null && stored.payloadHash === built.payloadHash) {
      return { report: rowToReport(stored, false), generated: false };
    }

    const payload = narrationPayload(built.report);
    const out = await llm.complete({
      // Grain-conditional: the month-word BAN at sprint grain, the uneven-length rule at month
      // grain. See `reportSystemFor` — the ban lives in the model's prompt, not only in UI copy.
      system: reportSystemFor(window.grain),
      user: JSON.stringify(payload),
      maxTokens: REPORT_MAX_TOKENS,
    });
    // THE GROUNDED-FIGURE CHECK (plan D4): every numeral in the narrative must match a figure in
    // the narration payload — the SAME object the model was just prompted with (tolerating sign,
    // thousands separators, and the SPA formatters' renderings — see grounded-figures.ts for the
    // exact rules). ⚠ Grounded on `payload`, never on `built.report`: the raw report carries
    // `generatedAt` (the generation wall-clock — its ISO tokens would ground any numeral that
    // happens to match the minute/second, a Date.now()-derived value inside a D4 gate) and
    // `comparison.subsetRepoIds` (internal DB ids), neither of which the model sees and neither
    // of which the prose may quote. A narrative that fails is NOT stored: the deterministic
    // templated summary stands in, the rejection is logged, and the spend still bills + meters
    // below — the model DID run; what it wrote is simply not allowed to become the artifact.
    // Checked here, at generation time, so a forwarded report can never carry an invented number
    // no matter which surface renders it.
    const raw = out.text.trim();
    const rejectedNumerals = ungroundedNumerals(raw, groundingFigureSet(payload));
    const narrative = rejectedNumerals.length === 0 ? raw : templatedNarrative(built.report);
    if (rejectedNumerals.length > 0) {
      ctx.log.warn(
        {
          periodKey: window.key,
          workspaceId: scope.workspaceId,
          model,
          rejectedNumerals: rejectedNumerals.slice(0, 12),
        },
        'period report: narrative rejected by the grounded-figure check — storing the templated summary',
      );
    }
    const generatedAt = new Date();
    const spend = estimateReportCost(model, out.inputTokens, out.outputTokens);
    // What answered (Phase 4). `model` stays the requested id — the row identity and cache key.
    const ranModel = out.model ?? model;
    const ranProvider = out.provider ?? 'claude';

    // The shared AI-usage ledger (summary seam). Best-effort: a failed ledger write must never
    // lose the report the user just paid for. `recordAiUsage` DROPS any row with costUsd <= 0, so
    // an ambient-session run is invisible to the ledger — expected, not worked around.
    await ctx
      .recordAiUsage({
        accountId,
        seam: 'summary',
        feature: 'period_report',
        model: out.model ?? model,
        provider: out.provider,
        costUsd: out.costUsd,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
      })
      .catch(() => {});

    const report: PeriodReport = {
      ...built.report,
      narrative,
      model,
      ranModel,
      provider: ranProvider,
      generatedAt: generatedAt.toISOString(),
      stale: false,
    };
    await persistReport(ctx, {
      accountId,
      workspaceId: scope.workspaceId,
      window,
      model,
      ranModel,
      provider: ranProvider,
      report,
      repoIds: built.repoIds,
      payloadHash: built.payloadHash,
      dataFingerprint: built.dataFingerprint,
      creditsSpent: spend.estimatedCredits,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      generatedAt,
    });
    return {
      report,
      generated: true,
      spend: {
        // The run's spend names what RAN (the label beside it), not the requested id.
        model: ranModel,
        credits: spend.estimatedCredits,
        usd: spend.estimatedUsd,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
      },
    };
  } finally {
    reportInFlight.delete(runKey);
  }
}

/** The pre-flight quote for one generation. Exported so the routes can quote EVERY selectable
 *  model side by side — the ratio is the number that stops a 5× surprise. */
export function quoteFor(model: ReportModel): PeriodReportCostEstimate {
  return estimateReportCost(model, ESTIMATED_INPUT_TOKENS, ESTIMATED_OUTPUT_TOKENS);
}

// ── Grounding payloads ───────────────────────────────────────────────────────────────────────

/**
 * What the narrating model sees. Labels and units travel WITH the figures so the prose and the
 * rendered rows name the same metric the same way.
 *
 * ⚠ THE DELTA FIGURES ARE DELIBERATELY **NOT** CALLED `value`/`prior` HERE, and that rename is
 * load-bearing rather than cosmetic. This payload carries TWO populations for every metric key:
 * `metrics[].value` is the headline over the workspace's full membership, while a delta's figures
 * are over the coverage-stable SUBSET, so on a workspace with any onboarding at all the same key
 * legitimately holds two different "current" numbers. Shipped with both spelled `value`, the model
 * read them as a time series — measured on the real dev corpus it wrote "Merged PRs: 117 (was 113,
 * −22.6%)" where 117 was the headline, 113 was the SUBSET's own current figure and the actual prior
 * was 146, and the chat turn compounded it into "146 → 113 → 117 over the three tracked periods".
 * Two wrong documents from one ambiguous field name. `thisPeriod`/`priorPeriod` cannot be crossed
 * with `value`, the movement entries carry their OWN pair so a bullet never has to reach into
 * `deltas`, and every population is named in words beside its figures. The wire types
 * (`PeriodMetricDelta`) are untouched — this is the prompt's vocabulary, not the contract's.
 */
// (Exported only so period-report.test.ts can pin the separation directly; nothing else calls it
// from outside this module.)
export function narrationPayload(report: PeriodReport): Record<string, unknown> {
  const label = (k: PeriodMetricKey): string => PERIOD_METRIC_LABEL[k];
  const unit = (k: PeriodMetricKey): string => PERIOD_METRIC_UNIT[k];
  // Movements name a metric but carry only the CHANGE, so a bullet formatted as
  // "<now> (was <then>)" would otherwise have to go shopping in `deltas` for the pair — which is
  // exactly where it picked up the headline figure instead. Join them here, once.
  const deltaByKey = new Map(report.comparison.deltas.map((d) => [d.key, d]));
  return {
    period: {
      key: report.periodKey,
      // ⚠ GRAIN-AWARE. The sprint formatter prints the EXCLUSIVE end boundary, so August would
      // reach the model as "1 Aug – 1 Sep" — a 32-day span — and the prompt orders this exact
      // string copied into the headline.
      range: formatPeriodRange(
        Date.parse(report.periodStart),
        Date.parse(report.periodEnd),
        report.grain,
      ),
      from: report.periodStart,
      to: report.periodEnd,
      grain: report.grain,
      cadenceDays: report.cadenceDays,
    },
    coverage: report.coverage,
    metricsBasis: `HEADLINE figures over all ${report.coverage.totalRepos} repos in the workspace today`,
    metrics: report.metrics.map((m) => ({
      key: m.key,
      metric: label(m.key),
      unit: unit(m.key),
      value: m.value,
      sampleSize: m.sampleSize,
    })),
    comparison: {
      priorPeriodKey: report.comparison.priorPeriodKey,
      subsetDisclosure: report.comparison.subsetDisclosure,
      refusal: report.comparison.refusal,
      // Stated in the payload as well as in the system prompt: the deltas are a DIFFERENT
      // population from `metrics` above, and the figure that proves it is right here.
      basis:
        report.comparison.refusal != null
          ? 'no like-for-like comparison was possible'
          : `like-for-like over the ${report.comparison.subsetRepoIds.length} repos tracked in BOTH periods — these figures are NOT the headline \`metrics\` above and must never be paired with them`,
      deltas: report.comparison.deltas.map((d) => ({
        key: d.key,
        metric: label(d.key),
        unit: unit(d.key),
        thisPeriod: d.value,
        priorPeriod: d.prior,
        absoluteChange: d.absoluteChange,
        percentChange: d.percentChange,
        significant: d.significant,
        direction: d.direction,
      })),
    },
    forecasts: report.forecasts.map((f) =>
      f.available
        ? {
            key: f.key,
            metric: label(f.key),
            unit: unit(f.key),
            point: f.point,
            low: f.low,
            high: f.high,
            basis: f.basis,
            periodsUsed: f.periodsUsed,
          }
        : { key: f.key, metric: label(f.key), available: false, reason: f.reason },
    ),
    movementsBasis:
      'the same coverage-stable subset as `comparison.deltas` — NOT the headline `metrics` above. `phrase` is the figures already written out, units included; copy it verbatim and add no unit of your own.',
    movements: report.movements.map((m) => {
      const d = deltaByKey.get(m.key);
      return {
        key: m.key,
        metric: label(m.key),
        unit: unit(m.key),
        // ⚠ THE FIGURES ARE PRE-RENDERED, AND THE PROMPT REQUIRES THIS STRING VERBATIM.
        //
        // What was actually measured, so nobody re-derives this from a stale memory: with the
        // delta figures ALSO spelled `value`/`prior` (identical to `metrics[].value`), Haiku wrote
        // "Merged PRs: 117 (was 113, −22.6%)" — 117 the full-workspace headline, 113 this period
        // over the stable subset, and the true prior 146 nowhere in the sentence — and the chat
        // turn compounded it into "146 → 113 → 117 over the three tracked periods". Every
        // individual number was real, which is exactly what made it dangerous: nothing looked
        // invented. Renaming to thisPeriod/priorPeriod and stating the two-populations rule FIXED
        // it, verified with and without this instruction.
        //
        // `phrase` is therefore a BELT, not the cure, and it is kept deliberately: this is a
        // document people forward, the failure is silent and plausible, and the cost of removing
        // the model's opportunity to pick the wrong number is one string. Same principle as the
        // Bot Tuning Advisor's templated recommendations — the model supplies the reading, never
        // the arithmetic. If it ever needs to go, the rename is the part that must stay.
        //
        // ⚠ IT CARRIES THE UNIT, which is the other half of the same lesson. Rendered unit-free
        // it read "Reviewer concentration: 50 (was 38.55, +29.70%)" and a reader took the 50 for
        // a count of PRs — it is a percentage, and the unit was sitting on the very next line of
        // this object. `movementPhrase` (period-questions.ts, shared with the templated fallback
        // so the two can never spell one figure differently) splices it in.
        phrase: movementPhrase(m, d),
        thisPeriod: d?.value ?? null,
        priorPeriod: d?.prior ?? null,
        absoluteChange: m.absoluteChange,
        percentChange: m.percentChange,
        rank: m.rank,
        // ⚠ `favourable: false` on a `neutral` metric does NOT mean "bad" — a neutral metric has
        // no good direction at all, so `direction` travels beside it and the prose must read the
        // two together. Without this pairing every fall in opened-PR count reads as a regression.
        favourable: m.favourable,
        direction: PERIOD_METRIC_META[m.key].direction,
      };
    }),
  };
}

// (REMOVED 2026-10-22: `answerPeriodChat` and its grounding payload — the `…/reports/:key/chat`
// route had no caller. Stored rows keep their `suggested` questions, served and unread.)
