import type {
  PeriodMetricDelta,
  PeriodMetricKey,
  PeriodMovement,
  PeriodSuggestedQuestion,
} from '@pierre-review/shared';

// The period report's suggested drill-down questions — DETERMINISTIC TEMPLATES, NO MODEL CALL.
//
// ⚠ THE POINT IS THAT IT CANNOT HALLUCINATE A QUESTION ABOUT DATA THAT DOES NOT EXIST. A model
// asked to "suggest what to look into" will happily propose "why did deploy frequency drop in
// the API repo?" for a workspace with no API repo and no deploy metric — and the reader cannot
// tell the difference until they click. Every question below is bound to a metric that IS in the
// vector, a movement that WAS computed, and the exact repo set + window the report covered, so
// selecting a pill needs no re-derivation by the model at all: the scope travels with the pill.
//
// One template family per metric key, `Record<PeriodMetricKey, …>` so a metric added at a later
// schema version is a COMPILE error here rather than a silently question-less row.

/** The human label for each metric. ONE copy, shared with the narration prompt in
 *  period-report.ts — a metric that the pill and the prose name differently reads as two
 *  different numbers to whoever forwards the report. */
export const PERIOD_METRIC_LABEL: Record<PeriodMetricKey, string> = {
  merged_prs: 'merged PRs',
  human_merged_prs: 'merged PRs authored by people',
  opened_prs: 'opened PRs',
  automation_merge_share_pct: 'share of merges authored by automation',
  median_lead_time_hours: 'median lead time',
  // ⚠ THE WORD "HUMAN" IS LOAD-BEARING IN THIS LABEL, not decoration. The figure it names used
  // to read 0h on a workspace where CI auto-approved on push; a label that says only "time to
  // first review" invites the reader to keep the old interpretation of the new number.
  median_time_to_first_human_review_hours: 'median time to first review by a person',
  merge_ci_success_pct: 'CI success on merge',
  median_pr_size_lines: 'median PR size',
  median_human_pr_size_lines: 'median PR size, people only',
  review_threads_opened: 'review threads opened',
  threads_replied_within_36h_pct: 'threads replied within 36h',
  bot_review_comments: 'bot review comments',
  human_review_comments: 'human review comments',
  bot_comments_per_merged_pr: 'bot comments per merged PR',
  reviewer_concentration_pct: 'reviewer concentration',
};

/** The unit each metric is quoted in, for the prompt and the pill text. Purely presentational —
 *  the values on the wire are plain numbers. */
export const PERIOD_METRIC_UNIT: Record<PeriodMetricKey, string> = {
  merged_prs: 'PRs',
  human_merged_prs: 'PRs',
  opened_prs: 'PRs',
  automation_merge_share_pct: '%',
  median_lead_time_hours: 'hours',
  median_time_to_first_human_review_hours: 'hours',
  merge_ci_success_pct: '%',
  median_pr_size_lines: 'lines',
  median_human_pr_size_lines: 'lines',
  review_threads_opened: 'threads',
  threads_replied_within_36h_pct: '%',
  bot_review_comments: 'comments',
  human_review_comments: 'comments',
  bot_comments_per_merged_pr: 'comments/PR',
  reviewer_concentration_pct: '%',
};

// ── Figures, with their units attached ───────────────────────────────────────────────────────
//
// ⚠ A FIGURE WITHOUT ITS UNIT IS A DIFFERENT FIGURE. The narrative shipped
// "Reviewer concentration: 50 (was 38.55, +29.70%)" and the reader took the 50 for a count of
// PRs — it is a PERCENTAGE. The unit was already computed, already carried on the payload beside
// the phrase (`unit: PERIOD_METRIC_UNIT[key]`) and simply never spliced into the string. Every
// figure a reader sees now carries it.
//
// ⚠ TWO PRODUCERS RENDER THESE FIGURES and they must never drift: `movementPhrase` below (the
// pre-written string the narration prompt orders copied character for character) and
// `templatedNarrative` in grounded-figures.ts (the deterministic fallback stored when the D4
// grounded-figure check rejects the model's prose). They had a private copy of the number
// spelling each; both now go through `formatFigure`.
//
// ⚠ KEEP EVERY UNIT DIGIT-FREE. `%`/`h` bind tight to the figure, so a unit beginning with a
// digit would fuse into a different number on screen ("50" + "2x" reads as 502x). The D4 check
// itself is safe either way — the phrase travels IN the payload it is grounded against — but the
// reader is not.

/** Units that bind TIGHT to the figure, keyed by the entry in `PERIOD_METRIC_UNIT`. `hours`
 *  renders `h`, matching `fmtDuration` in the on-screen table and `PersonPeriodSection.fmtValue`;
 *  everything else is a noun and takes a space (`117 PRs`, `142 lines`, `4.20 comments/PR`). */
const TIGHT_UNITS: Record<string, string> = { '%': '%', hours: 'h' };

function withUnit(figure: string, unit: string): string {
  if (unit === '') return figure;
  const tight = TIGHT_UNITS[unit];
  return tight != null ? `${figure}${tight}` : `${figure} ${unit}`;
}

/** How a period figure is spelled: integers bare, everything else to two decimals. ONE copy —
 *  the narration phrase and the templated fallback must not spell the same number differently. */
export function formatFigure(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** A metric's VALUE with its unit: `50%`, `19.56h`, `117 PRs`, `142 lines`, `4.20 comments/PR`. */
export function formatMetricValue(key: PeriodMetricKey, v: number): string {
  return withUnit(formatFigure(v), PERIOD_METRIC_UNIT[key]);
}

/**
 * A metric's ABSOLUTE CHANGE with its unit. Identical to `formatMetricValue` except for the
 * percentage metrics, whose change is measured in POINTS: "reviewer concentration +11%" would be
 * a percentage of a percentage, and the same movement already renders "▲ +11 pts" on screen
 * (`pointsFmt`/`changeFmtFor` in periodReportMarkdown.ts). Two spellings of one movement on two
 * surfaces is exactly the ambiguity that table exists to avoid.
 *
 * The UNIT is shared with the panel; the NUMBER spelling is not, and need not be — prose keeps
 * two decimals ("+11.45 pts") where the panel rounds ("+11 pts"), and the grounded-figure check
 * accepts both renderings of one stored figure by design.
 */
export function formatMetricChange(key: PeriodMetricKey, v: number): string {
  const unit = PERIOD_METRIC_UNIT[key];
  return withUnit(formatFigure(v), unit === '%' ? 'pts' : unit);
}

/**
 * "130 PRs (was 171 PRs, −24%)" — a movement's figures, rendered once, deterministically, so the
 * narrating model never picks which number goes where. Both sides come from the SAME delta, which
 * is the whole point (see the note at the call site in period-report.ts's `narrationPayload`).
 *
 * ⚠ THE TRAILING PERCENT-CHANGE TOKEN IS A DIFFERENT QUANTITY from the metric's own value — it is
 * the RELATIVE change, so it keeps its own `%` whatever the metric is quoted in, and never takes
 * the metric's unit. `50% (was 38.55%, +29.70%)` is three figures in two units, correctly.
 *
 * A movement always has a significant delta behind it by construction (significance requires a
 * non-null `absoluteChange`, which requires both sides); the `d == null` branch is defensive only,
 * and degrades to the change alone rather than inventing a pair.
 */
export function movementPhrase(m: PeriodMovement, d: PeriodMetricDelta | undefined): string {
  const pct =
    m.percentChange == null
      ? ''
      : `, ${m.percentChange > 0 ? '+' : '−'}${formatFigure(Math.abs(m.percentChange))}%`;
  if (d?.value == null || d.prior == null) {
    const sign = m.absoluteChange > 0 ? '+' : '−';
    return `${sign}${formatMetricChange(m.key, Math.abs(m.absoluteChange))}${pct}`;
  }
  return `${formatMetricValue(m.key, d.value)} (was ${formatMetricValue(m.key, d.prior)}${pct})`;
}

// The question each metric earns. Written as a drill-down a lead would actually ask — "which
// repos / which PRs / who", never "why did X change?", which the chat cannot answer from the
// data and would only invent a story for.
const QUESTION_TEMPLATE: Record<PeriodMetricKey, string> = {
  merged_prs: 'Which repos drove the change in merged PRs?',
  human_merged_prs: 'Which people merged the most, and where?',
  opened_prs: 'Where did the change in opened PRs come from?',
  automation_merge_share_pct: 'Which automation authored the most merged PRs?',
  median_lead_time_hours: 'Which merged PRs took longest from opening to landing?',
  median_time_to_first_human_review_hours: 'What waited longest for a person to review it?',
  merge_ci_success_pct: 'Which PRs merged with CI failing or unresolved?',
  median_pr_size_lines: 'Which merged PRs were the largest?',
  median_human_pr_size_lines: 'Which of the largest merged PRs were written by people?',
  review_threads_opened: 'Which repos opened the most review threads?',
  threads_replied_within_36h_pct: 'Which review threads went unanswered past 36 hours?',
  bot_review_comments: 'Which bots commented most, and where?',
  human_review_comments: 'Who did the human reviewing?',
  bot_comments_per_merged_pr: 'Which repos carry the most bot comments per merged PR?',
  reviewer_concentration_pct: 'Who is carrying the review load?',
};

// When nothing moved significantly there is still a report to read, so the surface must not go
// blank. These two are always answerable from the vector and are the questions a lead opens with.
const FALLBACK_KEYS: PeriodMetricKey[] = ['merged_prs', 'median_lead_time_hours'];

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** 'YYYY-MM-DD' in UTC. Period boundaries are UTC midnights (the sprint start is stored at UTC
 *  midnight and the cadence is whole days), so this is exact rather than a rounding. */
export function periodDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 'YYYY-MM' in UTC — the CALENDAR-MONTH identity.
 *
 *  ⚠ `periodDayKey`'s day form cannot express a month. A month named by its first day
 *  ('2026-08-01') is indistinguishable from a sprint that happens to start on the 1st, and both
 *  grains share one key space and one `insightsReportKey` store field. The month key is
 *  deliberately SHORTER so the two shapes cannot collide even accidentally. */
export function periodMonthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * The artifact's TITLE.
 *
 * ⚠ TWO GRAINS, TWO FORMATTERS, AND THE SPRINT ONE IS WRONG FOR A MONTH. `periodEnd` is the
 * window's EXCLUSIVE bound, so the sprint form prints the day the NEXT period starts — correct
 * for a sprint ('18 Aug – 1 Sep', which is how a fortnight is spoken about) and a plain falsehood
 * for August, which would title as '1 Aug – 1 Sep' and read as a 32-day span. A calendar month is
 * named, not ranged: 'August 2026'.
 *
 * ⚠ THE MONTH-WORD BAN IS GRAIN-CONDITIONAL, NOT DELETED. At sprint grain the words "month",
 * "monthly" and "month on month" must still appear nowhere in this feature's copy or in its
 * narration prompt: a 14-day cadence gives ~2.17 periods per calendar month, so the label would
 * be false on a document someone forwards. At month grain the period IS a calendar month and
 * naming it one is the only honest thing to do. Deleting the rule instead of forking it would
 * give a 14-day report permission to call itself monthly again.
 */
export function formatPeriodRange(
  fromMs: number,
  toMs: number,
  grain: 'sprint' | 'month' = 'sprint',
): string {
  const from = new Date(fromMs);
  if (grain === 'month') {
    return `${MONTHS_LONG[from.getUTCMonth()] ?? ''} ${from.getUTCFullYear()}`;
  }
  const to = new Date(toMs);
  const one = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`;
  return `${one(from)} – ${one(to)}`;
}

/** The scope a selected pill carries. Kept structural so the caller cannot transpose the window
 *  and the repo list (the `BotScope` two-named-fields lesson at a smaller grain). */
export interface PeriodQuestionScope {
  periodKey: string;
  fromMs: number;
  toMs: number;
  /** The repo ids the report was computed over — NOT the whole account. A pill that widens the
   *  scope answers a different question than the number it was generated from. */
  repoIds: number[];
}

/** Default number of pills. Four fits the rail without scrolling and keeps the chat's grounding
 *  payload bounded; the movements below it are already ranked, so this is a display cap. */
const DEFAULT_LIMIT = 4;

/**
 * Top-k ranked movements → bound questions. `movements` is expected pre-ranked (rank 0 = biggest
 * mover) and already filtered to SIGNIFICANT deltas — a pill inviting a drill-down into noise is
 * the same "percentage off a tiny base" mistake in a different costume.
 */
export function buildSuggestedQuestions(
  movements: PeriodMovement[],
  scope: PeriodQuestionScope,
  limit: number = DEFAULT_LIMIT,
): PeriodSuggestedQuestion[] {
  const keys: PeriodMetricKey[] = [];
  for (const m of [...movements].sort((a, b) => a.rank - b.rank)) {
    if (keys.length >= limit) break;
    if (!keys.includes(m.key)) keys.push(m.key);
  }
  // Nothing moved (or nothing moved significantly): fall back rather than render an empty rail.
  for (const k of FALLBACK_KEYS) {
    if (keys.length >= limit) break;
    if (!keys.includes(k)) keys.push(k);
  }
  return keys.map((key) => ({
    // Stable and unique per (period, metric) so React keys and click analytics line up across
    // regenerations of the same period — the id must not encode the RANK, which moves.
    id: `${scope.periodKey}:${key}`,
    text: QUESTION_TEMPLATE[key],
    scope: {
      metric: key,
      repoIds: scope.repoIds,
      fromMs: scope.fromMs,
      toMs: scope.toMs,
    },
  }));
}
