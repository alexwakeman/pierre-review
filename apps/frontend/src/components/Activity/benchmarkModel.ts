import type {
  BotBenchmarkAbsentMetric,
  BotBenchmarkAnomaly,
  BotBenchmarkAnomalyKind,
  BotBenchmarkCostRefusalReason,
  BotBenchmarkPlacementCost,
  BotBenchmarkPlacementMetric,
  BotBenchmarkPlacementRefusalReason,
  BotBenchmarkPlacementUnit,
  BotBenchmarkStaleness,
  BotBenchmarkUnavailableReason,
  BotBenchmarkUnitExclusionReason,
} from '@pierre-review/shared';
import type { BotsInnerTab } from '../../store/filters.js';
import type { ProGateState } from '../ProGate.js';
import { BOT_VENDOR_META } from '../../lib/ui.js';

// The render model for **Bots → Benchmark** — "how does our review bot compare with the same
// product running in comparable repositories".
//
// ⚠ THE ANOMALY LIST IS THE HEADLINE; THE DISTRIBUTIONS ARE EVIDENCE BENEATH IT. A percentile on
// its own is trivia — "you are in the 73rd percentile of CodeRabbit repositories" is not a thing
// anyone does anything about. An anomaly is a percentile that cleared a share gate AND a magnitude
// gate AND the cohort's own uncertainty about its median, and it arrives with the sentence that
// says what to do. So `anomalyRows()` leads the panel and `metricRows()` sits under the fold.
//
// ⚠ EVERY REFUSAL IS ITS OWN SENTENCE, AND COLLAPSING TWO OF THEM IS THE DEFECT THIS FILE EXISTS
// TO PREVENT. "We have never measured this bot" (DeepSource — a real, common case), "we measured it
// and declined to stratify it", "this stratum is empty", "your repository is too new to place" and
// "this build ships no corpus" are five different facts with five different remedies, and a
// renderer that treats them as one absent state tells a customer their biggest reviewer scored zero.
// The headline maps below are pairwise distinct and a test asserts it.
//
// ⚠ NOTHING HERE RE-DERIVES A NUMBER. Every value, percentile, median, CI and count is the
// server's; this file positions marks, orders rows and picks words. The one arithmetic it does is
// `stripGeometry`, which maps already-served numbers onto a 0..1 axis.
//
// ⚠ AND NOTHING HERE STATES A METRIC'S DEFINITION. The corpus's columns are NOT the app's columns
// of the same name (`getBotAnalytics.actedOnPct` folds the `likely_addressed` commit heuristic in
// and divides by every in-window thread; the cohort's `acted_on_rate` divides by SETTLED threads).
// The labels below are DISPLAY NAMES. The authoritative numerator/denominator/population is
// `metricSpecs`, which ships in full on `GET /api/pro/bot-benchmark` and is read by the panel's
// click-gated "How these are measured" disclosure — never re-typed here, where it would become a
// second source of the definition that drifts from the fitter's.

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The derived sub-tab
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * DERIVE the visible Bots sub-tab; never write a correction back to the store.
 *
 * `botsInnerTab` is ONE scalar shared by the cross-repo Bots rail and the per-repo console's Bots
 * tab, so it can legitimately hold a key that this mount does not render. A corrective
 * `setBotsInnerTab()` would permanently forget the reader's choice for the mount that DOES render
 * it — the rule `feedInnerTab` / `insightsTab` carry the same comment against.
 *
 * ⚠ `'benchmark'` IS CAPABILITY-GATED AND STILL RETURNS ITSELF. It is VISIBLE-BUT-LOCKED, so an
 * unentitled `?botsTab=benchmark` — which ships in bookmarks and in history entries Back replays —
 * must land on the tab the URL named and render the LOCKED pane there. Redirecting it to `roi`
 * would drop the reader on a screen that explains nothing. Only `'advisor'` degrades, because
 * that tab is not LISTED without its capability (two postures in one strip, both deliberate).
 */
export function effectiveBotsTab(raw: BotsInnerTab, opts: { showAdvisor: boolean }): BotsInnerTab {
  return raw === 'advisor' && !opts.showAdvisor ? 'roi' : raw;
}

/** What the Benchmark tab renders. */
export type BenchmarkBody = 'blank' | 'locked' | 'panel';

/**
 * The visible-but-locked gate, as a pure decision the tab body switches on.
 *
 * ⚠ `'pending'` RENDERS NOTHING, AND THAT IS THE POINT. `useProCapabilities()` reads all-false
 * until `/api/me` resolves, so the obvious `!botDepth ? lock : panel` paints "See what Pro
 * includes" for one frame on every cold load AT AN ACCOUNT THAT PAYS — and an unresolved `/api/me`
 * is `'pending'` whatever the reason, in flight OR errored, because "you have not paid" is a claim
 * a client is not entitled to make off a 502.
 *
 * ⚠ THIS DECIDES ONLY WHAT IS SEEN. A client gate is not a monetisation gate: the route 402s and
 * `useBotBenchmarkPlacement` ANDs the same capability into its own `enabled`, so an unentitled
 * mount asks for nothing rather than polling a 402.
 */
export function benchmarkBodyFor(gate: ProGateState): BenchmarkBody {
  if (gate === 'pending') return 'blank';
  return gate === 'locked' ? 'locked' : 'panel';
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Words for every refusal shape
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** THE WHOLE ARTIFACT IS MISSING — a build-configuration fact, not a data fact and not an error.
 *  Three states, three sentences: this is what stops "peer benchmarking isn't in this build"
 *  reading as "there isn't enough peer data yet". */
export const UNAVAILABLE_HEADLINE: Record<BotBenchmarkUnavailableReason, string> = {
  artifact_missing: 'This build ships no peer corpus',
  artifact_unreadable: 'The bundled peer corpus could not be read',
  fit_version_unsupported: 'The bundled peer corpus is a newer format than this build reads',
};

/** NO COHORT EXISTS FOR THIS (vendor, activity) PAIR. Six facts, six remedies. */
export const PLACEMENT_REFUSAL_HEADLINE: Record<BotBenchmarkPlacementRefusalReason, string> = {
  // The DeepSource case. The bot is real, it is working, we have simply never measured it.
  vendor_not_in_corpus_vocabulary: 'We have never measured this reviewer',
  vendor_unfittable: 'This reviewer resolves to no product',
  vendor_unstratifiable: 'We have too little of this reviewer to stratify',
  cell_not_in_corpus: 'No peer repository of this size runs this reviewer',
  // The TWO refusals that are about the customer rather than the corpus, and they are different
  // sentences: an INCOMPLETE window (we have not held the repo long enough to count its merges)
  // against a COMPLETE window the repository did not use (it merged nothing recently).
  repo_window_incomplete: 'This repository is too new to place',
  // ⚠ NOT A STATEMENT ABOUT ANY REVIEWER. With no merges in the window the fold reads zero pull
  // requests, so every bot would otherwise come back "said nothing here" however much it wrote.
  repo_inactive_in_window: 'No recent merges to measure',
};

/** ONE METRIC WITHHELD FOR THIS UNIT — the corpus's own exclusion vocabulary plus the one
 *  customer-side arm the corpus cannot have. ⚠ `vendor_silent` is UNDEFINED, never 0: uninstalled,
 *  path-scoped and category-suppressed are indistinguishable from here and all three differ from
 *  "it commented and was ignored". */
export const EXCLUSION_HEADLINE: Record<BotBenchmarkUnitExclusionReason, string> = {
  repo_not_walked: 'Repository not read',
  // ⚠ A DIFFERENT SENTENCE FROM 'Said nothing here'. Nothing was read, so nothing here is a
  // statement about the reviewer at all.
  no_prs_in_window: 'No pull requests in this window',
  vendor_silent: 'Said nothing here',
  vendor_absent_from_population: 'Nothing inside this population',
  denominator_empty: 'Nothing to measure against',
  below_min_units: 'Too small a sample',
  body_unobserved: 'A comment body was never stored',
};

/** FOUR KINDS, FOUR ACTIONS. The `action` sentence itself is the SERVER's (templated, never
 *  model-generated); these are the scan labels above it. */
export const ANOMALY_HEADLINE: Record<BotBenchmarkAnomalyKind, string> = {
  volume: 'Writing far more than its peers',
  engagement: 'Your team acts on far less of it than its peers do',
  latency: 'A person reaches it far later than in peer repositories',
  overlap: 'Repeating another reviewer on the same lines',
};

/** Reporting order — the plugin's `RULES` order, restated so the panel's grouping is stable and
 *  does not depend on the order the server happened to emit. */
export const ANOMALY_KIND_ORDER: readonly BotBenchmarkAnomalyKind[] = [
  'volume',
  'engagement',
  'latency',
  'overlap',
];

/** How fresh the corpus is, recomputed server-side per request. Rendered beside the fit key so a
 *  reader can discount an old comparison rather than discovering later that they should have. */
export const STALENESS_LABEL: Record<BotBenchmarkStaleness, string> = {
  fresh: 'Corpus is current',
  aging: 'Corpus is ageing',
  stale: 'Corpus is stale',
  expired: 'Corpus has expired',
};

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Metric display names and order
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** DISPLAY NAMES ONLY — see the file header. The key is the fitter's own metric name, which is
 *  also what joins a row back to `metricSpecs` and to an anomaly's `metric`. */
export const METRIC_LABEL: Readonly<Record<string, string>> = {
  acted_on_rate: 'Acted on',
  acted_on_rate_with_outdated: 'Acted on (counting outdated)',
  thread_resolved_rate: 'Resolved',
  thread_outdated_rate: 'Went outdated',
  human_reply_rate: 'A person replied',
  human_followed_last_bot_rate: 'A person had the last word',
  median_hours_to_first_human_reply: 'Time to a first human reply',
  overdue_untouched_rate_72h: 'Untouched after 72h',
  overdue_untouched_rate_168h: 'Untouched after a week',
  findings_per_merged_pr: 'Findings per merged PR',
  threads_per_merged_pr: 'Threads per merged PR',
  pr_comment_coverage: 'Merged PRs it commented on',
  cross_bot_overlap_rate: 'Overlaps another reviewer',
  // The three model-derived metrics. Absent from every cell while the corpus is unscored — listed
  // here so the "arrives when the corpus is scored" block can name them in the reader's words.
  high_severity_share: 'Share flagged high severity',
  nit_share: 'Share flagged as nits',
  distinct_category_count: 'Distinct categories used',
};

/** Reading order: what happens to what it says, then how much it says. A metric the wire carries
 *  that this build has no entry for is NOT dropped — it is appended under its raw name, because a
 *  corpus refit adding a metric must make it visible rather than silently invisible. */
const METRIC_ORDER: readonly string[] = [
  'acted_on_rate',
  'thread_resolved_rate',
  'human_reply_rate',
  'human_followed_last_bot_rate',
  'median_hours_to_first_human_reply',
  'overdue_untouched_rate_72h',
  'overdue_untouched_rate_168h',
  'thread_outdated_rate',
  'acted_on_rate_with_outdated',
  'findings_per_merged_pr',
  'threads_per_merged_pr',
  'pr_comment_coverage',
  'cross_bot_overlap_rate',
];

export function metricLabel(name: string): string {
  return METRIC_LABEL[name] ?? name;
}

/** ⚠ MODEL-DERIVED AND CODE-DERIVED FIGURES MUST BE LABELLED APART in a panel that mixes them.
 *  Every metric with a number on this screen is `code`; the only `model` entries are the three
 *  STRUCTURALLY ABSENT ones, which carry no number at all. */
export const DERIVATION_LABEL: Record<'code' | 'model', string> = {
  code: 'Counted',
  model: 'Model-derived',
};

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Formatting
   ───────────────────────────────────────────────────────────────────────────────────────── */

// ⚠ NOT `charts/common.tsx`'s `fmtDuration`. That module is `.tsx` and pulls React in for its
// `useChartWidth` hook; this one has to stay a pure `.ts` unit the frontend test suite (which is
// `test/**/*.test.ts`, no renderer, no JSX) can import directly. The duplication is one formatter
// wide and is the same trade `bottlenecksModel.ts` already made.

/** Drop trailing zeros AFTER a decimal point — `"1.50"` → `"1.5"`, `"3.0"` → `"3"`.
 *  ⚠ The `includes('.')` guard is load-bearing: without it `"100"` becomes `"1"`. */
function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** A metric value in the metric's OWN unit — the unit string the cohort served, never guessed. */
export function formatMetricValue(value: number, unit: string): string {
  if (unit === 'rate') {
    const pct = value * 100;
    return `${trimZero(pct.toFixed(pct >= 10 ? 0 : 1))}%`;
  }
  if (unit === 'hours') return formatHours(value);
  if (unit === 'count_per_pr') return trimZero(value.toFixed(2));
  return trimZero(value.toFixed(2));
}

/** Hours at the scale a reader holds in their head. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${trimZero(hours.toFixed(1))}h`;
  return `${trimZero((hours / 24).toFixed(1))}d`;
}

/** An integer with thousands separators — counts of repositories, threads, pull requests. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** 73 → "73rd". Ordinals read as ranks; a bare "73" reads as a score out of 100. */
export function ordinal(n: number): string {
  const r = Math.round(n);
  const mod100 = r % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${r}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[r % 10] ?? 'th';
  return `${r}${suffix}`;
}

/**
 * ⚠ THE BAND COUNT AND THE COHORT n RIDE EVERY RENDERED PERCENTILE. "Upper fifth of Greptile
 * repositories" is honest at 5 bands and a misrepresentation at 10, and the fitted vendors carry
 * 10/10/9/7/4/3/2 bands — so a reader who assumes ten is wrong about five of the seven. The
 * denominator is the METRIC's own fitted repository count (`cohort.nRepos`), not the band-support
 * count: they are different numbers, and the rank is a rank within the former.
 */
export function percentileSentence(p: {
  percentile: number;
  nRepos: number;
  bandLabel: string;
}): string {
  const band = p.bandLabel === '' ? '' : ` · activity band ${p.bandLabel}`;
  return `${ordinal(p.percentile)} percentile of ${formatCount(p.nRepos)} peer repositories${band}`;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The distribution strip
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** Mark positions as FRACTIONS of the strip's width, 0 at the left edge. Everything the strip
 *  draws comes from here so the SVG holds no arithmetic. */
export interface StripGeometry {
  domain: [number, number];
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** The customer's own value. Clamped into [0,1] — it can legitimately sit outside p10..p90. */
  value: number;
  /** The 95% CI of the cohort's MEDIAN, when the cohort published one. */
  ci: [number, number] | null;
}

const QUANTILE_KEYS = ['p10', 'p25', 'p50', 'p75', 'p90'] as const;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Position p10/p25/p50/p75/p90, the customer's dot and the median's CI on one axis.
 *
 * ⚠ RETURNS `null` RATHER THAN A DEGRADED STRIP when a quantile is missing or non-finite. A strip
 * drawn from a partial grid is a picture of a distribution nobody fitted, and this is the whole
 * family of defect the wire's discriminated union exists to prevent — so the caller renders the
 * numbers without a chart rather than a chart that is quietly wrong.
 *
 * The domain always CONTAINS the customer's value (and the CI), so a repository outside the
 * cohort's p10..p90 is drawn at the edge rather than clipped off the strip and read as "nothing
 * there". A degenerate cohort (every quantile equal) collapses to the centre.
 */
export function stripGeometry(
  quantiles: Record<string, number>,
  value: number,
  ciMedian95: [number, number] | null,
): StripGeometry | null {
  const q: Record<string, number> = {};
  for (const k of QUANTILE_KEYS) {
    const v = quantiles[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    q[k] = v;
  }
  if (!Number.isFinite(value)) return null;
  const ciOk =
    ciMedian95 != null && Number.isFinite(ciMedian95[0]) && Number.isFinite(ciMedian95[1]);
  const ci = ciOk ? ciMedian95 : null;

  const lows = [q['p10'] as number, value, ...(ci ? [ci[0]] : [])];
  const highs = [q['p90'] as number, value, ...(ci ? [ci[1]] : [])];
  let lo = Math.min(...lows);
  let hi = Math.max(...highs);
  if (!(hi > lo)) {
    // One value everywhere: there is no axis to draw, so every mark sits at the centre.
    return {
      domain: [lo, hi],
      p10: 0.5,
      p25: 0.5,
      p50: 0.5,
      p75: 0.5,
      p90: 0.5,
      value: 0.5,
      ci: ci ? [0.5, 0.5] : null,
    };
  }
  // A 4% breathing margin so a dot at either extreme is a dot, not a half-dot on the border.
  const pad = (hi - lo) * 0.04;
  lo -= pad;
  hi += pad;
  const at = (x: number): number => clamp01((x - lo) / (hi - lo));
  return {
    domain: [lo, hi],
    p10: at(q['p10'] as number),
    p25: at(q['p25'] as number),
    p50: at(q['p50'] as number),
    p75: at(q['p75'] as number),
    p90: at(q['p90'] as number),
    value: at(value),
    ci: ci ? [at(ci[0]), at(ci[1])] : null,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Rows
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** A (repository × reviewer) unit's identity, in the app's own vocabulary. ⚠ The reviewer list is
 *  an ARRAY: two logins the workspace classifies as one vendor are ONE unit, and naming only the
 *  first would be a false claim about which account produced the numbers. */
export function unitTitle(unit: BotBenchmarkPlacementUnit): string {
  return `${unit.repoOwner}/${unit.repoName}`;
}

/** The BRAND NAME for a unit's reviewer, or the generic "Bot". ⚠ `botKind: null` is a real and
 *  common state (an unbranded CI account) and must render the generic pill, never nothing — and
 *  never the corpus's vendor string, which is a different vocabulary that the two repos'
 *  divergence makes it tempting to conflate. */
export function reviewerLabel(botKind: string | null): string {
  if (botKind != null && Object.hasOwn(BOT_VENDOR_META, botKind)) {
    const meta = (BOT_VENDOR_META as Record<string, { label: string; color: string }>)[botKind];
    if (meta != null) return meta.label;
  }
  return 'Bot';
}

export function reviewerColor(botKind: string | null): string | null {
  if (botKind != null && Object.hasOwn(BOT_VENDOR_META, botKind)) {
    const meta = (BOT_VENDOR_META as Record<string, { label: string; color: string }>)[botKind];
    if (meta != null) return meta.color;
  }
  return null;
}

/** One metric line of one unit, in reading order, with its label resolved. */
export interface MetricRow {
  name: string;
  label: string;
  metric: BotBenchmarkPlacementMetric;
}

/**
 * A unit's metrics in reading order.
 *
 * ⚠ NOTHING THE WIRE CARRIES IS DROPPED. Unknown names sort after the known ones, alphabetically,
 * under their raw key — a corpus refit that adds a metric shows it (ugly, but present) instead of
 * hiding it behind a stale display table.
 */
export function metricRows(unit: BotBenchmarkPlacementUnit): MetricRow[] {
  const known = new Set(METRIC_ORDER);
  const extra = Object.keys(unit.metrics)
    .filter((k) => !known.has(k))
    .sort();
  const order = [...METRIC_ORDER, ...extra];
  const out: MetricRow[] = [];
  for (const name of order) {
    const metric = unit.metrics[name];
    if (metric == null) continue;
    out.push({ name, label: metricLabel(name), metric });
  }
  return out;
}

/**
 * ⚠ A PLACED REPOSITORY CAN SIT OUTSIDE ITS OWN BAND'S RANGE, and on screen that reads as a
 * contradiction unless it is said out loud. Found by running the panel: a repository with ZERO
 * merges in the window rendered as "activity band 1 of 10 (2–3 merged PRs a fortnight)" beside
 * "You: 0 merged in 14 days".
 *
 * It is correct. `bandRange` is the SUPPORT interval — the merged-PR range of the repositories that
 * DEFINED the cut — and the placement rule reads the HIGH edges only, so anything at or below the
 * lowest high edge lands in band 0 whether or not it reaches that band's low edge. The outermost
 * bands are open in the direction they face.
 *
 * Returns the sentence that says so, or `null` when the value really is inside the range. The
 * `aboveTopBandBy` case has its own dedicated line and is deliberately not doubled up here.
 */
export function bandFitNote(p: {
  activity: number;
  bandRange: [number, number];
  aboveTopBandBy: number | null;
}): string | null {
  if (p.aboveTopBandBy != null) return null;
  const [lo, hi] = p.bandRange;
  if (p.activity < lo) {
    return (
      `Your ${formatCount(p.activity)} is below the ${formatCount(lo)}–${formatCount(hi)} these ` +
      'peers drew — this is the quietest band there is, and it is open at the bottom.'
    );
  }
  if (p.activity > hi) {
    return (
      `Your ${formatCount(p.activity)} is above the ${formatCount(lo)}–${formatCount(hi)} these ` +
      'peers drew; the band is a rank cut, not a bucket you have to fall inside.'
    );
  }
  return null;
}

/**
 * ⚠ THIRTEEN IDENTICAL REFUSALS ARE ONE REFUSAL, and printing them thirteen times reads as
 * thirteen separate measurements that each came back empty. Also found by running the panel: a
 * reviewer that said nothing in a repository produced thirteen consecutive "Said nothing here"
 * rows.
 *
 * This is the cohort route's own "ONE banner, not thirteen identical paragraphs per cell" rule,
 * applied one level down. Returns the shared reason ONLY when every metric was withheld under it —
 * a unit with a MIX (`below_min_units` here, `denominator_empty` there) keeps its full list,
 * because those say different things about where the blind spot is.
 */
export function collapsedExclusion(rows: MetricRow[]): BotBenchmarkUnitExclusionReason | null {
  if (rows.length === 0) return null;
  const first = rows[0]?.metric;
  // ⚠ `first.status !== 'excluded'` IS THE UNION NARROWING, not a redundant runtime check. The loop
  // below already returns null for a non-excluded first row, so removing this line changes no
  // behaviour and NO TEST GOES RED — it is killed by `tsc` instead (`Property 'reason' does not
  // exist on type BotBenchmarkPlacementMetric`). Mutation-tested; recorded here so it is not
  // "simplified" away by a reader who checks only the suite.
  if (first == null || first.status !== 'excluded') return null;
  for (const row of rows) {
    if (row.metric.status !== 'excluded' || row.metric.reason !== first.reason) return null;
  }
  return first.reason;
}

/** An anomaly, joined back to the unit it came from and to the metric it fired on. */
export interface AnomalyRow {
  key: string;
  unit: BotBenchmarkPlacementUnit;
  anomaly: BotBenchmarkAnomaly;
  headline: string;
  metricLabel: string;
  /** ⚠ THE RANK'S OWN DENOMINATOR — the METRIC's fitted repository count, read back off
   *  `unit.metrics[anomaly.metric]`. `anomaly.cohortRepos` is a different number (the repositories
   *  that DEFINED the band cut), and rendering it as "of N" beside a percentile would put a rank in
   *  a population it was not ranked within. `null` only if the metric is not `compared`, which
   *  cannot happen — an anomaly can only fire on a compared metric — so the caller falls back to
   *  the band-support count rather than printing nothing. */
  rankRepos: number | null;
}

/**
 * Every anomaly across every unit, flattened — THE PANEL'S HEADLINE.
 *
 * Grouped by kind in the plugin's own reporting order, then by repository and reviewer so the list
 * is stable across refetches. ⚠ Deliberately NOT ranked by how far past its gate each one is: that
 * would be a cross-finding score nobody asked for, and the four kinds are not commensurable.
 */
export function anomalyRows(units: BotBenchmarkPlacementUnit[]): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  for (const unit of units) {
    for (const anomaly of unit.anomalies) {
      const metric = unit.metrics[anomaly.metric];
      rows.push({
        key: `${unit.repoId}:${anomaly.metric}:${anomaly.kind}`,
        unit,
        anomaly,
        headline: ANOMALY_HEADLINE[anomaly.kind],
        metricLabel: metricLabel(anomaly.metric),
        rankRepos: metric != null && metric.status === 'compared' ? metric.cohort.nRepos : null,
      });
    }
  }
  const kindIndex = (k: BotBenchmarkAnomalyKind): number => {
    const i = ANOMALY_KIND_ORDER.indexOf(k);
    return i === -1 ? ANOMALY_KIND_ORDER.length : i;
  };
  return rows.sort((a, b) => {
    const byKind = kindIndex(a.anomaly.kind) - kindIndex(b.anomaly.kind);
    if (byKind !== 0) return byKind;
    return unitTitle(a.unit).localeCompare(unitTitle(b.unit)) || a.key.localeCompare(b.key);
  });
}

/** What the panel can say about how much was actually looked at — so "nothing stands out" reads as
 *  CHECKED rather than NOT RUN. */
export interface PlacementTally {
  units: number;
  placed: number;
  refused: number;
  /** Metric cells that produced a percentile — the sample the anomaly rules ran over. */
  compared: number;
  anomalies: number;
}

/**
 * ⚠ "NOTHING STANDS OUT" AND "NOTHING COULD BE COMPARED" ARE TWO DIFFERENT ANSWERS, and this is
 * the one that was found by running the panel rather than by reading it. A repository can be
 * PLACED in a band — vendor known, band resolved, cohort present — and still have all thirteen
 * metrics withheld (`below_min_units` on a quiet repository, `vendor_absent_from_population` for a
 * reviewer whose comments all sit on unmerged pull requests). Every real unit on the first live
 * call was exactly that shape.
 *
 * Rendering "nothing stands out" over ZERO comparisons is a clean bill of health issued after
 * measuring nothing — the same defect as a refusal drawn as an empty chart, one level up. So the
 * empty state is TWO states, and the zero case renders in the refusal grammar.
 */
export type FindingsEmpty = 'nothing_comparable' | 'nothing_stands_out';

export const FINDINGS_EMPTY_HEADLINE: Record<FindingsEmpty, string> = {
  nothing_comparable: 'Nothing could be compared yet',
  nothing_stands_out: 'Nothing stands out',
};

export function findingsEmptyState(tally: PlacementTally): FindingsEmpty {
  return tally.compared === 0 ? 'nothing_comparable' : 'nothing_stands_out';
}

export function placementTally(units: BotBenchmarkPlacementUnit[]): PlacementTally {
  let placed = 0;
  let compared = 0;
  let anomalies = 0;
  for (const unit of units) {
    if (unit.placement.status === 'placed') placed += 1;
    for (const metric of Object.values(unit.metrics)) {
      if (metric.status === 'compared') compared += 1;
    }
    anomalies += unit.anomalies.length;
  }
  return { units: units.length, placed, refused: units.length - placed, compared, anomalies };
}

/** Units in a stable reading order: repository, then reviewer brand. Placed units first — a
 *  placed unit is the one with something to read, and a refused one still renders in full below it
 *  (never hidden: a refusal that is not on screen is indistinguishable from a bot we never saw). */
export function orderedUnits(units: BotBenchmarkPlacementUnit[]): BotBenchmarkPlacementUnit[] {
  return [...units].sort((a, b) => {
    const placedA = a.placement.status === 'placed' ? 0 : 1;
    const placedB = b.placement.status === 'placed' ? 0 : 1;
    if (placedA !== placedB) return placedA - placedB;
    return (
      unitTitle(a).localeCompare(unitTitle(b)) ||
      reviewerLabel(a.botKind).localeCompare(reviewerLabel(b.botKind))
    );
  });
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Cost — what the reviewer costs per unit of the work it produces
   ───────────────────────────────────────────────────────────────────────────────────────── */

// ⚠ NO PRICE ⇒ NOTHING RENDERS. `unit.cost` is ABSENT when no price is set for this reviewer in
// this Workspace, and there is deliberately no "set a price" placeholder, no empty card and no
// zero: a "$0.00 per acted-on thread" is a claim about a reviewer nobody priced. The whole
// vocabulary below only ever runs on a block the server chose to send.
//
// ⚠ THREE DIFFERENT SOURCES SIT IN ONE BLOCK AND MUST BE LABELLED APART — the same rule that keeps
// the model-derived metrics off the strips. The price is a number a HUMAN TYPED; the rates and
// merge counts are COUNTED from this Workspace's own rows; the counterfactual's engagement rate is
// FITTED from the peer corpus. Mixing them under one visual weight is how a what-if starts reading
// as an invoice.

export type CostBasis = 'stored' | 'counted' | 'fitted';

// ⚠ KEPT SHORT ENOUGH TO SIT BESIDE ITS FIGURE. These are inline chips on a row that already
// carries a number and a sentence of detail; the first draft's "Fitted from the peer cohort"
// wrapped onto a line of its own on the counterfactual row, orphaning the one label on this card
// that must be read with the number it qualifies.
export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  stored: 'Price you entered',
  counted: 'Counted from yours',
  fitted: 'Fitted peer median',
};

/** NINE SENTENCES — and the tenth state, "no price set", never reaches here because the block is
 *  absent. Each is a different fact with a different remedy, exactly like the placement and
 *  exclusion vocabularies above. */
export const COST_REFUSAL_HEADLINE: Record<BotBenchmarkCostRefusalReason, string> = {
  // ⚠ THE SAME WORDS THE PLACEMENT REFUSALS USE ONE CARD UP, for the two facts both refuse on. Two
  // different sentences for one cause on one card is how a reader stops believing either.
  repo_window_incomplete: PLACEMENT_REFUSAL_HEADLINE.repo_window_incomplete,
  no_merges_in_window: 'No recent merges to measure',
  // ⚠ A SENTENCE ABOUT TIME, NOT ABOUT VOLUME, AND NOT ABOUT A BILLING PERIOD. "Said nothing here"
  // is a different fact one card up; this reviewer may have written plenty, all of it in one
  // instant or with no readable timestamp, which leaves no observed pace for a monthly rate to be
  // stated against.
  span_unobserved: 'No measurable pace to state a rate against',
  own_rate_withheld: 'Your acted-on rate was withheld',
  nothing_acted_on: 'Nothing acted on to divide by',
  price_is_zero: 'Recorded as free',
  // ⚠ NOT "Recorded as free" AND NOT SILENCE. Somebody entered a price; it is per seat and the
  // seat count could not be multiplied out, so the figure is missing and the price is not.
  price_unresolved: 'Price entered, monthly figure not statable',
  cohort_rate_unfitted: 'No peer engagement rate in this cohort',
  cohort_rate_zero: 'Peers act on none of it either',
};

/**
 * US dollars, unambiguously.
 *
 * ⚠ `US$`, NOT A BARE `$`. A lone dollar sign is four currencies, and this figure is a real price
 * somebody pays. Two decimals always — a price that prints as "US$120" invites the reader to
 * wonder what happened to the cents.
 *
 * ⚠ AND A NON-ZERO FIGURE NEVER PRINTS AS `US$0.00`. A high-volume reviewer can genuinely cost
 * fractions of a cent per thread; rounding that to two decimals prints exactly the row of zeros the
 * zero-price refusal exists to avoid, arriving from the opposite direction. Sub-cent renders as
 * "<US$0.01", which is true and is visibly not a zero.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  const abs = Math.abs(usd);
  const sign = usd < 0 ? '-' : '';
  if (abs > 0 && abs < 0.005) return `${sign}<US$0.01`;
  return `${sign}US$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * ⚠ THE WINDOW RIDES A WINDOWED **TOTAL**, AND NOTHING ELSE. A bare "US$412" invites the reader to
 * assume a month, so the price line carries it.
 *
 * ⚠ IT MUST NEVER BE SUFFIXED TO A RATIO. "US$5.52 per 14 days" on a row labelled "Per merged PR"
 * reads as dollars-per-PR-per-fortnight and invites the reader to double it for a month — but cost
 * per merged pull request does not scale with the window at all (numerator and denominator scale
 * together), so the figure is US$5.52 whatever window is chosen. That shipped on both ratio rows.
 * A ratio's basis belongs in its detail line, where it is prose rather than a unit.
 */
export function costWindowLabel(windowDays: number): string {
  return `per ${formatCount(windowDays)} days`;
}

/** How long the reviewer's own observed output ran, in the reader's units. Days below a fortnight,
 *  then weeks, then months — a "94.3 days" is a number nobody holds in their head. */
export function formatSpanDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '—';
  if (days < 14) return `${trimZero(days.toFixed(1))} days`;
  if (days < 70) return `${trimZero((days / 7).toFixed(1))} weeks`;
  return `${trimZero((days / 30.44).toFixed(1))} months`;
}

/**
 * A thread count — an INTEGER when it is the customer's own measured one, FRACTIONAL when it is the
 * counterfactual's `settledThreads × cohortRate`.
 *
 * ⚠ IT MUST NOT ROUND A FRACTION TO A WHOLE NUMBER. A quiet repository can legitimately sit at 0.4
 * threads at peer engagement, and printing "0" beside a real cost-per-thread figure is a
 * contradiction on one line — the reader is being shown a price per unit of something the same row
 * says there is none of. One decimal below ten, none above, and the trailing zero trimmed, so a
 * measured 3 still prints as "3".
 */
export function formatThreadCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.05) return '<0.1';
  return trimZero(n.toFixed(abs < 10 ? 1 : 0));
}

/**
 * The price line: the monthly figure a human typed — the basis of every reviewer-side rate on this
 * card — and the same money over the fortnight `$ per merged PR` sits on. Under `per_seat` the two
 * halves of the multiplication are shown, because "US$120/month" with no explanation beside a
 * stored "15" is unexplainable.
 *
 * ⚠ A `null` MONTHLY IS NOT `US$0.00` AND NOT AN EMPTY LINE. It is a price somebody entered that
 * could not be stated (every priced row is per-seat and the seat count was unreadable or empty), so
 * the line says exactly that — running it through `formatUsd` would print "US$0.00 a month", which
 * is the "recorded as free" lie this whole vocabulary exists to prevent.
 */
export function costPriceLine(cost: BotBenchmarkPlacementCost): string {
  if (cost.monthlyUsd == null || cost.windowUsd == null) {
    return 'No monthly figure — every price recorded here is per seat, and the seat count could not be multiplied out';
  }
  const base = `${formatUsd(cost.monthlyUsd)} a month · ${formatUsd(cost.windowUsd)} ${costWindowLabel(
    cost.windowDays,
  )}`;
  if (cost.costModel !== 'per_seat' || cost.unitMonthlyUsd == null || cost.seats == null) {
    return base;
  }
  return (
    `${base} — ${formatUsd(cost.unitMonthlyUsd)} per seat × ${formatCount(cost.seats)} ` +
    `seat${cost.seats === 1 ? '' : 's'}`
  );
}

/**
 * ⚠ THE PRICE IS PER WORKSPACE AND THIS CARD IS PER REPOSITORY, so the same money appears on
 * several cards at once.
 *
 * ⚠ IT ALWAYS RETURNS A SENTENCE, and that is the correction of a defect this function shipped
 * with: the caveat was conditional on `sharedWithUnits > 1`, which is a count of the cards IN THIS
 * RESPONSE. The per-repository Bots tab narrows to one repository, so the count there is always 1
 * and the disclosure never appeared — on precisely the screen where a reader is most likely to read
 * a Workspace-wide subscription as this repository's bill. The RULE is unconditional; only the
 * count is a bonus.
 *
 * Apportioning the subscription across repositories was considered and rejected: there is no basis
 * in the data for any split, and an invented allocation would be indistinguishable on screen from a
 * measured one. Saying it out loud is the honest option — the figures are upper bounds, and the one
 * thing the reader must not do is add them up.
 */
export function costSharedNote(cost: BotBenchmarkPlacementCost): string {
  if (cost.sharedWithUnits > 1) {
    return (
      `This is the Workspace price, and ${formatCount(cost.sharedWithUnits)} cards here carry it ` +
      '— each one measures the whole subscription against one repository, so these are upper ' +
      'bounds and adding them together would count the same money more than once.'
    );
  }
  return (
    'This is the Workspace price, measured against this repository’s work alone. The same ' +
    'subscription may cover repositories not shown here, so it is an upper bound rather than this ' +
    'repository’s share.'
  );
}

/** Two prices folded into one card: two logins the Workspace calls one vendor are ONE unit, so
 *  their rows were summed. `null` for the ordinary single-row case. */
export function costPricedReviewersNote(cost: BotBenchmarkPlacementCost): string | null {
  if (cost.pricedReviewers <= 1) return null;
  return (
    `Summed over ${formatCount(cost.pricedReviewers)} priced accounts the Workspace classifies as ` +
    'this one reviewer.'
  );
}

/** ⚠ A MISSING DISCLOSURE IS THE SAME DEFECT AS A WRONG NUMBER, ONE LINE QUIETER. A per-seat price
 *  this build could not resolve is EXCLUDED from the figure rather than read as its per-developer
 *  unit, and the exclusion has to be visible or the total silently understates. */
export function costSeatUnresolvedNote(cost: BotBenchmarkPlacementCost): string | null {
  if (cost.seatPriceUnresolved <= 0) return null;
  return (
    `${formatCount(cost.seatPriceUnresolved)} per-seat price${
      cost.seatPriceUnresolved === 1 ? ' is' : 's are'
    } left out of this figure: this build could not read the Workspace's seat count, and a ` +
    'per-developer unit price is not a monthly one.'
  );
}

/**
 * ⚠ A COMPUTED ZERO IS NOT A STORED ZERO, AND THIS IS ITS OWN SENTENCE.
 *
 * A per-seat price multiplied by a seat count of 0 is exactly 0 — indistinguishable, one line down,
 * from the deliberate "we pay nothing for this" the block renders as "Recorded as free". Somebody
 * typed a price; the Workspace's derived seat count (distinct human pull-request authors over a
 * fixed trailing 30 days) came back empty, which is the proxy failing rather than the bill. Such a
 * row is EXCLUDED from the figure and said out loud here.
 *
 * ⚠ A DIFFERENT SENTENCE FROM `costSeatUnresolvedNote`, deliberately: "this build cannot read your
 * seat count" and "your seat count is zero this month" have different remedies, and collapsing two
 * facts with two remedies into one is the defect every vocabulary on this tab exists to prevent.
 */
export function costSeatZeroNote(cost: BotBenchmarkPlacementCost): string | null {
  if (cost.seatCountZero <= 0) return null;
  return (
    `${formatCount(cost.seatCountZero)} per-seat price${
      cost.seatCountZero === 1 ? ' is' : 's are'
    } left out of this figure: this Workspace has no human pull-request authors in the last 30 ` +
    'days, so there are no seats to multiply by. A price you entered is not a price of nothing.'
  );
}

/**
 * ⚠ FOUR IDENTICAL REFUSALS ARE ONE REFUSAL — `collapsedExclusion`'s rule, one block down.
 *
 * The two cases that hit it are the two that matter most: a price of exactly 0 refuses all four
 * derived figures (every one of them is 0.00, which is true and reads as broken), and a repository
 * that merged nothing refuses all four for the reason the placement above it already gave. Four
 * consecutive dimmed rows saying the same thing read as four separate measurements that each came
 * back empty.
 *
 * Returns the shared reason ONLY when all four refuse under it — a MIX (a peer rate missing here,
 * a withheld own rate there) keeps its full list, because those say different things about where
 * the blind spot is.
 *
 * ⚠ `unacted` IS IN THE LIST EVEN THOUGH IT HAS NO ROW OF ITS OWN. It is the headline's first
 * sentence, and a collapse that ignored it would fold three refused rows into one line while the
 * headline above them silently vanished for a fourth reason nobody was told.
 */
export function collapsedCostRefusal(
  cost: BotBenchmarkPlacementCost,
): BotBenchmarkCostRefusalReason | null {
  const arms = [cost.perMergedPr, cost.unacted, cost.yours, cost.atPeerEngagement];
  const first = arms[0];
  // ⚠ THE UNION NARROWING, not a redundant runtime check — the same note `collapsedExclusion`
  // carries. The loop below already returns null for a non-refused first arm, so deleting this line
  // changes no behaviour and NO TEST GOES RED; it is killed by `tsc` instead (`Property 'reason'
  // does not exist on type …`). Mutation-tested; recorded so it is not "simplified" away.
  if (first == null || first.status !== 'refused') return null;
  for (const arm of arms) {
    if (arm.status !== 'refused' || arm.reason !== first.reason) return null;
  }
  return first.reason;
}

export interface CostHeadline {
  /** `behind` — peer-level engagement would convert more · `ahead` — this team engages MORE than
   *  the cohort's median · `even` — the two rates match · `measured` — no cohort median to compare
   *  against, so the spend sentence stands alone. */
  tone: 'behind' | 'ahead' | 'even' | 'measured';
  /**
   * SENTENCE ONE — WHAT THE PRICE CURRENTLY BUYS AND NOBODY ACTS ON, PER MONTH. Measured, own data
   * only, and the figure it names is `unacted.unactedUsd`.
   *
   * ⚠ THIS IS A SEPARATE FIELD FROM `comparison` BECAUSE THAT IS THE FIX. The two figures answer
   * different questions and differ by a factor of the cohort's rate; the first cut printed the
   * COMPARISON's number after this sentence's words ("US$11.04 … is buying feedback nobody acts
   * on", where the spend nobody acted on was US$33.11 — a third of the truth, in the direction that
   * under-reports waste). Two questions, two sentences, two fields; a renderer cannot reunite them
   * by accident.
   */
  spend: string;
  /** SENTENCE TWO — WHAT BETTER ENGAGEMENT WOULD BE WORTH, naming `conversionGapUsd`. `null` when
   *  the cohort published no median for this cell: the measured sentence stands on its own. */
  comparison: string | null;
}

/**
 * THE MONEY — what this block leads with, in TWO sentences carrying TWO different figures.
 *
 * ⚠ BOTH SENTENCES STATE A RATE, NEVER A HISTORY. They name `monthlyUsd × (1 − yourRate)` and
 * `monthlyUsd × (cohortRate − yourRate)` — dollars A MONTH, at the price recorded today, against
 * the pace measured over the span. They shipped as shares of `spanUsd`, so the first read
 * "US$189.22 of this reviewer's US$236.53 over the 8.6 weeks its comments span here" — a past spend
 * nobody can evidence, since the price may have changed and the subscription may be younger than
 * the span. The span still appears, as the WINDOW THE PACE WAS MEASURED OVER, never as a bill.
 *
 * ⚠ SENTENCE ONE IS MEASURED AND SENTENCE TWO IS A COUNTERFACTUAL, AND THAT SPLIT IS THE POINT.
 * They differ by a factor of the cohort's rate and the first is always the larger while that rate
 * is below 1. The first cut printed the SECOND number under the FIRST's words — "US$11.04 of your
 * US$55.19 is buying feedback nobody acts on", where the figure nobody acted on was US$33.11. Both
 * are legitimate; only naming them apart is.
 *
 * ⚠ SENTENCE TWO IS WORDED AS A COUNTERFACTUAL. "Your threads, your price, the cohort's median
 * engagement rate" is a clearly-bounded what-if; "what a peer pays" would be a claim about a
 * distribution nobody fitted, built by multiplying two cohort quantiles — the median of a product
 * is not the product of the medians. Only ONE factor moved, and the sentence says which.
 *
 * ⚠ AND BOTH ARE FIGURES, NOT FINDINGS. The panel's amber chrome is reserved for anomalies, which
 * cleared a share gate, a magnitude gate and the cohort's own uncertainty about its median. These
 * cleared no gate — they are arithmetic — so they render in the block's own neutral chrome however
 * large they are.
 *
 * ⚠ A NEGATIVE GAP IS A GOOD STATE AND MUST NOT BE WORDED AS WASTE. A team that acts on more of a
 * reviewer than the cohort's median is getting MORE for the money, and "-US$40 wasted" is a
 * sentence that means nothing. ⚠ It is also BOUNDED: the server's `conversionGapUsd` is a
 * difference of two rates times the MONTHLY PRICE, so `-gap` can never exceed the price it is a
 * share of. The ratio it replaced could, and did — a team at 1.0 against a real fitted median of
 * 0.24 rendered "US$172.06 more of the US$55.19 reaches something".
 */
export function costHeadline(cost: BotBenchmarkPlacementCost): CostHeadline | null {
  const unacted = cost.unacted;
  // ⚠ THE MEASURED SENTENCE IS THE PRECONDITION, NOT THE COMPARISON. A cohort that published no
  // median for this cell is a fact about the corpus; it must not delete the customer's own figure,
  // which needs nothing but their data.
  if (unacted.status !== 'value') return null;
  const span = cost.span;
  // ⚠ THE SPAN STILL GATES THE HEADLINE even though the figures no longer divide by it: every
  // sentence here asserts a CURRENT pace, and the span is the only evidence that the counts
  // describe one. A price with no observed pace behind it has no rate to state.
  if (span == null || cost.monthlyUsd == null) return null;
  // ⚠ THE MEASUREMENT WINDOW FOR THE WORK, NOT A BILLING PERIOD — the words have to say which, or
  // this sentence is back to claiming a spend over the span.
  const measured = `measured over the ${formatSpanDays(span.days)} its comments span here`;
  const spend =
    `${formatUsd(unacted.unactedUsd)} a month of this reviewer's ${formatUsd(cost.monthlyUsd)} ` +
    `monthly price is buying feedback nobody acts on — you acted on ` +
    `${formatMetricValue(unacted.actedOnRate, 'rate')} of the ` +
    `${formatCount(unacted.settledThreads)} threads it settled here, ${measured}.`;

  const peer = cost.atPeerEngagement;
  if (peer.status !== 'value') return { tone: 'measured', spend, comparison: null };
  const gap = peer.conversionGapUsd;
  const median = formatMetricValue(peer.cohortActedOnRate, 'rate');
  if (gap > 0) {
    return {
      tone: 'behind',
      spend,
      comparison:
        `At the cohort's median acted-on rate of ${median}, ${formatUsd(gap)} a month more of that ` +
        'same price would be acted on — your threads and your price, their engagement.',
    };
  }
  if (gap < 0) {
    return {
      tone: 'ahead',
      spend,
      comparison:
        `Your team acts on more of this reviewer than the cohort's median (${median}): ` +
        `${formatUsd(-gap)} a month more of that price reaches something than it would at peer ` +
        'engagement.',
    };
  }
  return {
    tone: 'even',
    spend,
    comparison:
      `Your acted-on rate matches the cohort's median (${median}), so peer-level engagement would ` +
      'convert none of that price differently.',
  };
}

/** The model-derived block: named, with its precondition, and NEVER drawn as a zero or an empty
 *  chart. `absentMetrics` rides every response precisely so the panel can say "this arrives when
 *  the corpus is scored" instead of showing an empty axis. */
export function absentMetricRows(
  absent: BotBenchmarkAbsentMetric[] | undefined,
): Array<BotBenchmarkAbsentMetric & { label: string }> {
  return (absent ?? []).map((m) => ({ ...m, label: metricLabel(m.name) }));
}
