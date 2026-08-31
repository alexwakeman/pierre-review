import type {
  BotBenchmarkAbsentMetric,
  BotBenchmarkAnomaly,
  BotBenchmarkAnomalyKind,
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

/** The model-derived block: named, with its precondition, and NEVER drawn as a zero or an empty
 *  chart. `absentMetrics` rides every response precisely so the panel can say "this arrives when
 *  the corpus is scored" instead of showing an empty axis. */
export function absentMetricRows(
  absent: BotBenchmarkAbsentMetric[] | undefined,
): Array<BotBenchmarkAbsentMetric & { label: string }> {
  return (absent ?? []).map((m) => ({ ...m, label: metricLabel(m.name) }));
}
