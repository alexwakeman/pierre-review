import type { PeriodGrain, PeriodMetricKey } from '@pierre-review/shared';
import { fmtDuration } from '../charts/common.js';

// ── THE PERIOD METRICS' PRESENTATION: labels, formatters, the period title ───────────────────
//
// What the Reports chart (PeriodReportsPanel, PeriodSeriesChart) names and formats each of the 15
// metrics with. LABELS AND FORMATTERS ONLY: a metric's direction and significance arrive from the
// server on every delta (core's floors), never re-derived here. (This was periodReportMarkdown.ts,
// which also rendered the stored report as Markdown; that renderer went with the stored report and
// its AI write-up, 2026-11-08 — the chart's copy is `lib/periodSeries.ts seriesMarkdown`.)

export type Fmt = (n: number) => string;

export const countFmt: Fmt = (n) => String(Math.round(n));
export const pctFmt: Fmt = (n) => `${Math.round(n)}%`;
export const linesFmt: Fmt = (n) => `${Math.round(n)}`;
// The same figure with its measure attached, for the sites that have no table note beside them to
// say what is being counted (see `standaloneFormat`).
export const linesUnitFmt: Fmt = (n) => `${Math.round(n)} lines`;
export const ratioFmt: Fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
// The CHANGE in a percentage metric is measured in POINTS, not percent. Without this the CI
// success row reads "▲ +5% (+8%)" — two different quantities wearing the same suffix, which is
// exactly the ambiguity this surface exists to avoid.
export const pointsFmt: Fmt = (n) => `${Math.round(n)} pts`;

export interface MetricMeta {
  label: string;
  format: Fmt;
  // How the ABSOLUTE CHANGE reads, when that differs from how the value reads (percentages →
  // points). Defaults to `format`.
  changeFormat?: Fmt;
  // A short caption under the label, shown where the metric's definition is narrower than its
  // name. Three of these are not cosmetic — they are the difference between a number the reader
  // trusts and one they think disagrees with another screen.
  note?: string;
  // ⚠ THE LABEL FOR ANYWHERE OUTSIDE THE TABLE ROW.
  //
  // The two human-only twins are labelled `…by people`, which reads correctly ONLY directly under
  // the blended figure they qualify. On a "biggest movers" pill that context is gone, and BOTH of
  // them render as the same pill — a reader seeing "…by people ▼ −47 (−25%)" cannot tell whether
  // their team merged 47 fewer PRs or wrote PRs 47 lines smaller, which are opposite kinds of
  // news. Set this wherever `label` leans on its neighbour to make sense.
  standaloneLabel?: string;
  // ⚠ THE UNIT FOR ANYWHERE OUTSIDE THE TABLE ROW — the same argument as `standaloneLabel`, one
  // column over.
  //
  // In the table, the unit is already on screen: the note under the label says "median lines added
  // + deleted". On a pill there is no note, so "PR size ▼ −47" is a number with no measure, and
  // the two lines metrics are the most common pill there is. Of the fifteen metrics, seven name
  // their unit in the label ("Merged PRs") and six get one from their formatter (%, pts, h) — only
  // the two lines metrics are naked, and only they set this.
  //
  // It is deliberately NOT used in the table or the forecast cells: the note makes it redundant in
  // the row, and the forecast composes the formatter three times, which would read
  // "≈ 142 lines (120 lines–164 lines)".
  standaloneFormat?: Fmt;
}


// Bare-number fallback for a metric today's vocabulary has no formatter for.
const rawFmt: Fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * TOTAL over any wire key — the lookup for everything that iterates a REPORT array.
 *
 * `METRIC_META` is `Record<PeriodMetricKey, …>`, so direct indexing type-checks as never-undefined
 * — but a report stored under an OLDER `PERIOD_METRICS_SCHEMA_VERSION` is still servable (stale +
 * regenerate is the designed path), and its `forecasts`/`movements`/`comparison.deltas` can carry
 * keys the current union renamed away (v1's `median_time_to_first_review_hours`). A direct index
 * on such a key is `undefined` at runtime and blanked the whole Reports pane (there is no error
 * boundary above it). So: iterations over `PERIOD_METRIC_KEYS` may index `METRIC_META` directly;
 * every iteration over a report array goes through this, which falls back to the key humanized —
 * honest about being an older vocabulary's figure, formatted as a bare number.
 */
export function metaFor(key: string): MetricMeta {
  const meta = (METRIC_META as Record<string, MetricMeta | undefined>)[key];
  return meta ?? { label: key.replace(/_/g, ' '), format: rawFmt };
}

export function changeFmtFor(meta: MetricMeta): Fmt {
  return meta.changeFormat ?? meta.format;
}


export const METRIC_META: Record<PeriodMetricKey, MetricMeta> = {
  merged_prs: { label: 'Merged PRs', format: countFmt, note: 'everything that landed' },
  // ⚠ THE HUMAN-ONLY TWIN SITS DIRECTLY UNDER ITS BLENDED PARENT, in `PERIOD_METRIC_KEYS` order,
  // and that adjacency is the feature. `117 / 71` read one under the other states the automation
  // gap with no narration; the same two numbers on opposite sides of a table are two facts nobody
  // joins up.
  human_merged_prs: {
    label: '…by people',
    standaloneLabel: 'Merged PRs by people',
    format: countFmt,
    note: 'excludes bumps, agents, release bots',
  },
  opened_prs: { label: 'Opened PRs', format: countFmt },
  automation_merge_share_pct: {
    label: 'Automation share of merges',
    format: pctFmt,
    changeFormat: pointsFmt,
    note: 'no arrow — more automation is not self-evidently better or worse',
  },
  median_lead_time_hours: {
    label: 'Lead time',
    format: fmtDuration,
    note: 'median open → merge',
  },
  median_time_to_first_human_review_hours: {
    label: 'Time to first review by a person',
    format: fmtDuration,
    // TWO things this caption has to carry, both of which have burned a reader:
    //  • "by a person" — this metric used to attribute to whoever reviewed FIRST, which on a
    //    workspace where CI auto-approves on push is the bot, at zero minutes. It read 0h against
    //    a real human median of 18.3h.
    //  • "counted on the review" — deliberately different from the Flow-metrics tile of nearly
    //    the same name. Bucketing by open date right-censors a recent window (PRs opened in-window
    //    but not yet reviewed contribute nothing, biasing the median DOWN).
    note: 'median, counted on the review — not the open. Bot approvals are excluded',
  },
  merge_ci_success_pct: {
    label: 'Merge CI success',
    format: pctFmt,
    changeFormat: pointsFmt,
    note: '% green at merge',
  },
  median_pr_size_lines: {
    label: 'PR size',
    format: linesFmt,
    standaloneFormat: linesUnitFmt,
    note: 'median lines added + deleted',
  },
  median_human_pr_size_lines: {
    label: '…by people',
    standaloneLabel: 'PR size, people only',
    format: linesFmt,
    standaloneFormat: linesUnitFmt,
    // The measured case: Dependabot's 14-line bumps and the humans' 142 blended to a reported 68,
    // a number no pull request in the workspace resembled.
    note: 'the blended figure above understated this by 2.1× on the workspace this was built for',
  },
  review_threads_opened: { label: 'Review threads opened', format: countFmt },
  threads_replied_within_36h_pct: {
    label: 'Threads replied within 36h',
    format: pctFmt,
    changeFormat: pointsFmt,
    note: 'same 36h grace the bot verdict uses',
  },
  // Both comment counts are INLINE review comments only — not PR-level comments, not review
  // bodies. The Bots tab's "bot comments" counts all three, so the same workspace legitimately
  // shows a larger figure there; without this caption that reads as one of the two being broken.
  bot_review_comments: {
    label: 'Bot review comments',
    format: countFmt,
    // INLINE ONLY, and that is why the "Effort vs automation" panel above can legitimately show a
    // much larger figure: quality gates post ISSUE comments, so a workspace with 786 SonarQube
    // comments reads 0 here. The panel counts all three channels; this row is the frozen vector
    // metric and stays comparable with every period stored before the panel existed.
    note: 'inline only — see Effort vs automation',
  },
  human_review_comments: {
    label: 'Human review comments',
    format: countFmt,
    note: 'inline only — see Effort vs automation',
  },
  bot_comments_per_merged_pr: { label: 'Bot comments per merged PR', format: ratioFmt },
  reviewer_concentration_pct: {
    label: 'Reviewer concentration',
    format: pctFmt,
    changeFormat: pointsFmt,
    // Bots are excluded from this one — a bot that submits more reviews than anyone would
    // otherwise define "the busiest reviewer" and the number would stop being about the team.
    note: 'share taken by the busiest human reviewer',
  },
};

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────
// A named reason, in the reader's words. Note what is NOT said: `insufficient_history` does not
// quote the minimum number of periods, because that constant (`MIN_FORECAST_POINTS`) lives in
// CORE and a hard-coded "4" here would drift silently the day it moves.

// ── Dates ────────────────────────────────────────────────────────────────────────────────────
//
// Rendered in UTC, matching the period key (`sprint-2026-08-18` is a UTC date). Local formatting
// would show "17 Aug" to a reader west of Greenwich for a period whose own key says the 18th.
//
// `periodEnd` is the window's EXCLUSIVE bound and is printed as-is: a 14-day period starting
// 18 Aug is titled "18 Aug – 1 Sep", which is how the cadence is spoken about. Do not
// "fix" it by subtracting a day.
const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
const MONTH_YEAR: Intl.DateTimeFormatOptions = {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
};

/**
 * The period's title.
 *
 * ⚠ A CALENDAR MONTH NEEDS ITS OWN FORMATTER, and the sprint one is actively wrong for it.
 * `periodEnd` is the EXCLUSIVE bound, so August would render "1 Aug – 1 Sep" — which reads as a
 * 32-day span, and is the title on a document somebody forwards. A month is NAMED: "August 2026".
 *
 * `grain` is a TRAILING OPTIONAL parameter defaulting to `'sprint'`, so every existing call site
 * (and every stored row written before the calendar grain existed) is unchanged.
 */
export function periodTitle(
  startIso: string,
  endIso: string,
  grain: PeriodGrain = 'sprint',
): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (grain === 'month') return s.toLocaleDateString(undefined, MONTH_YEAR);
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const thisYear = new Date().getUTCFullYear();
  const withYear: Intl.DateTimeFormatOptions = { ...DAY_MONTH, year: 'numeric' };
  if (!sameYear) {
    return `${s.toLocaleDateString(undefined, withYear)} – ${e.toLocaleDateString(undefined, withYear)}`;
  }
  const tail =
    s.getUTCFullYear() === thisYear
      ? e.toLocaleDateString(undefined, DAY_MONTH)
      : e.toLocaleDateString(undefined, withYear);
  return `${s.toLocaleDateString(undefined, DAY_MONTH)} – ${tail}`;
}

// Signed change, in the metric's own units — never a bare number, so "+2h" doesn't read as "+2".
export function signed(n: number, format: Fmt): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${format(Math.abs(n))}`;
}
