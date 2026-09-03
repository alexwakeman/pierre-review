import type {
  PeriodForecast,
  PeriodGrain,
  PeriodMetricDelta,
  PeriodMetricKey,
  PeriodMetricValue,
  PeriodRefusalReason,
  PeriodReport,
} from '@pierre-review/shared';
import { PERIOD_METRIC_KEYS } from '@pierre-review/shared';
import { fmtDuration } from '../charts/common.js';

// ── The period report's PRESENTATION METADATA + the "Copy as Markdown" renderer ──────────────
//
// This module owns the labels, formatters and honesty copy that `PeriodReportsPanel` renders,
// AND the deterministic markdown export built from the very same tables — one definition, two
// surfaces, so the copied artifact can never disagree with the screen it was copied from
// (import them, never re-implement, is the rule this file exists to make structural).
//
// The renderer is DETERMINISTIC: a pure function of the stored report object. Nothing here reads
// Date.now(), the store, or the network — the same stored report always copies byte-identical
// markdown, which is what makes the export diffable and forwardable.
//
// ⚠ THE HONESTY RULES TRAVEL IN THE EXPORT, because the honesty is the product:
//   • "no prior period" / "no prior figure" / "not compared" are stated as such — never 0,
//     never a blank cell that reads as "no change".
//   • A null metric renders "—". Never 0.
//   • An INSIGNIFICANT delta shows the raw figures and NO percentage.
//   • The coverage sentence and the comparison/forecast disclosures travel VERBATIM.
//   • Every refused forecast names its reason, with the same reader-facing text the panel shows.

// ── Metric presentation ──────────────────────────────────────────────────────────────────────
//
// LABELS AND FORMATTERS ONLY. `direction` is NOT duplicated here — it rides on every
// `PeriodMetricDelta` from the server, which is what keeps this table from becoming a second copy
// of spec §1's direction column that can silently disagree with the significance the server
// computed. The sample/absolute floors are likewise absent on purpose: they are CORE's
// (`db/period-metrics.ts`) and reach the SPA only as the pre-computed `significant` flag.
export type Fmt = (n: number) => string;

export const countFmt: Fmt = (n) => String(Math.round(n));
export const pctFmt: Fmt = (n) => `${Math.round(n)}%`;
export const linesFmt: Fmt = (n) => `${Math.round(n)}`;
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
}

/** The label to use where the metric appears on its own — a pill, a tooltip, a chat prompt —
 *  rather than in a table row directly beneath the figure it qualifies. */
export function standaloneLabelFor(meta: MetricMeta): string {
  return meta.standaloneLabel ?? meta.label;
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
    note: 'median lines added + deleted',
  },
  median_human_pr_size_lines: {
    label: '…by people',
    standaloneLabel: 'PR size, people only',
    format: linesFmt,
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
export const REFUSAL_TEXT: Record<PeriodRefusalReason, string> = {
  no_prior_period: 'No earlier period is stored, so there is nothing to compare against.',
  cadence_changed:
    'The sprint cadence changed between these two periods. Periods of different lengths are not comparable, so the difference is not shown rather than being quietly subtracted.',
  partial_coverage:
    'No repo in this workspace was being tracked across both periods, so there is no like-for-like subset to compare.',
  insufficient_history:
    'Not enough complete periods yet — a trend needs several periods where every repo in the subset was already being tracked.',
  too_volatile:
    'Too volatile to forecast: the uncertainty band came out wider than the estimate itself.',
  // The CALENDAR-MONTH refusal. The estimator fits a line on the period's POSITION in the series,
  // which assumes every period is the same length — true of a sprint grid, false of the calendar
  // (28 to 31 days is a ±5.4% swing in every count). Without this it would read February's short
  // month as a genuine dip, every year, and put a confident band around it.
  uneven_periods:
    'Calendar months are 28–31 days long, so a trend fitted across them would read their own uneven lengths as a change in the work. No forecast is offered at this grain — the sprint grain, whose periods are all the same length, still forecasts.',
};

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

// "There is no earlier period" vs "there is one, but it had no figure for this metric" — two
// different absences, and only the report as a whole knows which. Both render distinctly from
// "no change" and neither renders as 0.
/**
 * The three figures of one metric row, resolved to ONE population.
 *
 * Exported for its unit test: there is no jsdom in this workspace, so the row cannot be rendered,
 * and the invariant that matters here is arithmetic rather than visual — `value − prior` must
 * equal the change the row prints. That is precisely what broke before (see the block comment in
 * `MetricTable`), so it is pinned as a pure function rather than left to a component test that
 * this repo has no way to run.
 *
 * `headline` is the full-membership figure, and is non-null ONLY when it is a genuinely different
 * number from the one being subtracted — it is disclosure, never an input to the arithmetic.
 */
export function rowFigures(
  mv: PeriodMetricValue | undefined,
  delta: PeriodMetricDelta | undefined,
  populationsDiffer: boolean,
): {
  value: number | null;
  prior: number | null;
  headline: number | null;
  /** The displayed figure rests on fewer items than the metric's floor. Taken from whichever
   *  object supplied `value`, so the marker always describes the population on screen. */
  lowSample: boolean;
} {
  // NOT `delta?.value ?? mv?.value`: that silently substitutes the headline whenever the subset
  // legitimately has no figure, which reintroduces the two-population mix in the one case that is
  // hardest to spot.
  const value = delta ? delta.value : (mv?.value ?? null);
  return {
    value,
    prior: delta?.prior ?? null,
    headline: populationsDiffer && delta ? (mv?.value ?? null) : null,
    // From the SAME object as `value`, for the same reason `value` is: the two populations have
    // different sample sizes, and marking the row's figure with the other one's thinness is the
    // same mixing bug in miniature.
    lowSample: (delta ? delta.lowSample : mv?.lowSample) ?? false,
  };
}

/** A backfilled, metrics-only period: no comparison was ATTEMPTED (hence no refusal) and no
 *  forecast was computed. Distinct from a refused comparison and from a genuine first period,
 *  both of which carry a reason — all three rendered identically before this existed. */
export function figuresOnly(report: PeriodReport): boolean {
  return (
    report.comparison.deltas.length === 0 &&
    report.comparison.refusal == null &&
    report.comparison.priorPeriodKey == null &&
    report.forecasts.length === 0
  );
}

// ── The markdown export ──────────────────────────────────────────────────────────────────────

/** The Change column, in words — the text twin of the panel's ChangeCell, branch for branch. */
function changeText(delta: PeriodMetricDelta, meta: MetricMeta, hasPriorPeriod: boolean): string {
  const fmt = changeFmtFor(meta);
  if (delta.prior == null) return hasPriorPeriod ? 'no prior figure' : 'no prior period';
  if (delta.value == null || delta.absoluteChange == null) return '—';
  if (delta.absoluteChange === 0) return 'no change';
  // INSIGNIFICANT — the raw figure only, NO percentage. "It moved, and we are not calling it."
  if (!delta.significant) return `${signed(delta.absoluteChange, fmt)} · not significant`;
  const arrow = delta.absoluteChange > 0 ? '▲' : '▼';
  const pct =
    delta.percentChange != null ? ` (${signed(delta.percentChange, pctFmt)})` : ' (from 0)';
  return `${arrow} ${signed(delta.absoluteChange, fmt)}${pct}`;
}

/** The absent-delta cell — same wording as the panel's NoPrior. */
function noPriorText(hasPriorPeriod: boolean, notComputed: boolean): string {
  if (notComputed) return 'not compared';
  return hasPriorPeriod ? 'no prior figure' : 'no prior period';
}

/** The Next-period column — the text twin of ForecastCell. */
function forecastText(
  forecast: PeriodForecast | undefined,
  meta: MetricMeta,
  notComputed: boolean,
): string {
  if (notComputed) return 'not forecast';
  if (forecast == null) return '—';
  if (!forecast.available) return `not forecast · ${forecast.reason.replace(/_/g, ' ')}`;
  return `≈ ${meta.format(forecast.point)} (${meta.format(forecast.low)}–${meta.format(forecast.high)})`;
}

/** The coverage sentence, VERBATIM — the same words the panel's coverage box renders. */
function coverageSentence(report: PeriodReport): string {
  const c = report.coverage;
  if (c.complete) {
    return `All ${c.totalRepos} repos in this workspace were already being tracked when this period started.`;
  }
  return (
    `**Partial coverage.** ${c.trackedRepos} of ${c.totalRepos} repos in this workspace were ` +
    'being tracked when this period started. The headline figures below cover the whole ' +
    'workspace as it is today, so they under-count this period relative to a later one — which ' +
    'is why the comparison is computed over the repos present in both.'
  );
}

/**
 * The report as a forwardable markdown document. Deterministic — a pure function of the stored
 * report — and built from the SAME `METRIC_META` formatters, `REFUSAL_TEXT` copy and `rowFigures`
 * population rule the panel renders, so the paste can never disagree with the screen.
 *
 * `currentSchemaVersion` is passed in (the panel's `PERIOD_METRICS_SCHEMA_VERSION` import) rather
 * than read here so this module stays a pure presentation library.
 */
export function renderPeriodReportMarkdown(
  report: PeriodReport,
  currentSchemaVersion?: number,
): string {
  const lines: string[] = [];
  const notComputed = figuresOnly(report);
  const hasPriorPeriod = report.comparison.priorPeriodKey != null;

  // ⚠ THE MONTH-WORD RULE IS GRAIN-CONDITIONAL, NOT GONE. At sprint grain the title is the DATE
  // RANGE and the words "month"/"monthly" appear nowhere (a 14-day cadence is ~2.17 periods per
  // calendar month, so the label would be false). At month grain the period IS a calendar month
  // and naming it one is the only honest title.
  lines.push(`# ${periodTitle(report.periodStart, report.periodEnd, report.grain)}`);
  lines.push('');
  const genHeader = [
    report.grain === 'month' ? `Calendar month · ${report.cadenceDays} days` : `Sprint · ${report.cadenceDays} days`,
  ];
  // An OPEN period. Stated first and plainly: this artifact is a snapshot of an unfinished month,
  // and whoever it is forwarded to has to know that before they read a figure.
  if (report.inProgress)
    genHeader.push(
      `IN PROGRESS — ${report.elapsedDays ?? 0} day${report.elapsedDays === 1 ? '' : 's'} elapsed, not written up`,
    );
  if (report.model) genHeader.push(`written up with ${report.model}`);
  genHeader.push(`generated ${report.generatedAt}`);
  if (report.stale)
    genHeader.push('STALE — the underlying data changed after this report was written');
  lines.push(genHeader.join(' · '));
  lines.push('');

  // Coverage, stated on EVERY report — "all repos were tracked" only means something if its
  // absence is meaningful too. Verbatim from the panel's coverage box.
  lines.push(coverageSentence(report));
  lines.push('');

  if (currentSchemaVersion != null && report.metricsSchemaVersion !== currentSchemaVersion) {
    lines.push(
      `Written under metric schema v${report.metricsSchemaVersion} (current is v${currentSchemaVersion}) — any metric added since is blank here, not zero.`,
    );
    lines.push('');
  }

  if (notComputed) {
    lines.push(
      '**Figures only.** This period was filled in automatically to give the forecast some history — no comparison, forecast or write-up was computed for it.',
    );
    lines.push('');
  }

  // ── The figures table — one population per row, resolved by the same `rowFigures` the panel
  // uses. `value − prior` equals the printed change or the row does not ship.
  const values = new Map<PeriodMetricKey, PeriodMetricValue>(
    report.metrics.map((m) => [m.key, m]),
  );
  const deltas = new Map<PeriodMetricKey, PeriodMetricDelta>(
    report.comparison.deltas.map((d) => [d.key, d]),
  );
  const forecasts = new Map<PeriodMetricKey, PeriodForecast>(
    report.forecasts.map((f) => [f.key, f]),
  );
  const subsetCovers = report.comparison.subsetRepoIds.length;
  const populationsDiffer = subsetCovers > 0 && subsetCovers !== report.coverage.totalRepos;

  lines.push('| Metric | This period | Prior | Change | Next period |');
  lines.push('| --- | ---: | ---: | --- | --- |');
  let anyThin = false;
  for (const key of PERIOD_METRIC_KEYS) {
    const meta = METRIC_META[key];
    const mv = values.get(key);
    const delta = deltas.get(key);
    const forecast = forecasts.get(key);
    const { value, prior, headline, lowSample } = rowFigures(mv, delta, populationsDiffer);
    if (lowSample && value != null) anyThin = true;

    let thisPeriod = value == null ? '—' : meta.format(value);
    if (lowSample && value != null) thisPeriod += ' ▵';
    if (headline != null) thisPeriod += ` (all repos: ${meta.format(headline)})`;
    const priorCell = prior == null ? '—' : meta.format(prior);
    const changeCell = delta
      ? changeText(delta, meta, hasPriorPeriod)
      : noPriorText(hasPriorPeriod, notComputed);
    const metricCell = meta.note ? `${meta.label} — ${meta.note}` : meta.label;
    lines.push(
      `| ${metricCell} | ${thisPeriod} | ${priorCell} | ${changeCell} | ${forecastText(forecast, meta, notComputed)} |`,
    );
  }
  lines.push('');
  if (anyThin) {
    lines.push('▵ thin sample — the figure is real but rests on few items and moves easily.');
    lines.push('');
  }
  if (populationsDiffer) {
    lines.push(
      `Rows with a Change show the coverage-stable subset (${subsetCovers} of ${report.coverage.totalRepos} repos); "all repos" beside a figure is the full-workspace headline. The two populations are never mixed in one subtraction.`,
    );
    lines.push('');
  }

  // ── The comparison's own disclosure, VERBATIM from the server, or its refusal by name.
  if (!notComputed) {
    if (report.comparison.refusal != null) {
      lines.push(`**No comparison.** ${REFUSAL_TEXT[report.comparison.refusal]}`);
    } else if (report.comparison.subsetDisclosure) {
      lines.push(
        `Comparison ${report.comparison.subsetDisclosure}${
          report.comparison.priorPeriodKey ? ` · vs ${report.comparison.priorPeriodKey}` : ''
        }`,
      );
    }
    lines.push('');
  }

  // ── Forecast lines: the fitted-subset disclosure verbatim, then EVERY refusal with its named
  // reason and the reader-facing text — a blank forecast cell must never read as "no change
  // expected".
  if (!notComputed) {
    if (report.forecastDisclosure) {
      lines.push(`Forecast ${report.forecastDisclosure}`);
      lines.push('');
    }
    const refused = report.forecasts.filter(
      (f): f is Extract<PeriodForecast, { available: false }> => !f.available,
    );
    if (refused.length > 0) {
      lines.push('Not forecast:');
      for (const f of refused) {
        // metaFor, not a direct index: a stale row's forecasts can carry old-vocabulary keys.
        lines.push(
          `- ${standaloneLabelFor(metaFor(f.key))} — ${f.reason.replace(/_/g, ' ')}: ${REFUSAL_TEXT[f.reason]}`,
        );
      }
      lines.push('');
    }
  }

  // ── Biggest movers — significant only, figures computed with the same formatters as the pills.
  const movers = report.movements.slice(0, 5);
  if (movers.length > 0) {
    const parts = movers.map((m) => {
      const meta = metaFor(m.key); // report array — a stale row's movements can carry old keys
      const pct = m.percentChange != null ? ` (${signed(m.percentChange, pctFmt)})` : '';
      return `${standaloneLabelFor(meta)} ${m.absoluteChange > 0 ? '▲' : '▼'} ${signed(m.absoluteChange, changeFmtFor(meta))}${pct}`;
    });
    lines.push(`**Biggest movers:** ${parts.join(' · ')}`);
    lines.push('');
  }

  // ── The write-up, verbatim — or an honest statement that there is none.
  if (report.narrative) {
    lines.push('## Write-up');
    lines.push('');
    lines.push(report.narrative.trim());
    lines.push('');
  } else {
    lines.push(
      'Figures only — this period has not been written up. The numbers above are already final.',
    );
    lines.push('');
  }

  return lines.join('\n');
}
