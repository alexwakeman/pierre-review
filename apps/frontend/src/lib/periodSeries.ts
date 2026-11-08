// THE PERIOD SERIES' PURE HALF (Reports → Period reports, the chart; docs/FRONTEND.md § Period
// reports). React-free so test/periodSeries.test.ts pins it.
//
// TWO READINGS of the same series:
//   • CHANGE (the default): every metric as % change from its own BASELINE — its first period with
//     a figure that is above zero and not a thin sample. Any metrics share one axis, so a count of
//     40 and a count of 800 no longer flatten each other. ⚠ A metric with NO such period REFUSES
//     (`no_baseline`) rather than rebasing off nothing: a change from 0 or from two items is noise
//     with a percentage sign on it.
//   • VALUES: the figures in their own units, ONE PANEL PER UNIT (`unitGroups`) — never two units
//     on one axis, never a second axis.
import type { PeriodForecast, PeriodMetricKey, PeriodMetricValue, PeriodSeriesPoint } from '@pierre-review/shared';

export type PeriodMetricUnit = 'count' | 'pct' | 'hours' | 'lines' | 'ratio';

/** What each metric is measured in: the VALUES reading puts one unit per panel. */
export const PERIOD_METRIC_UNIT: Record<PeriodMetricKey, PeriodMetricUnit> = {
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

export const PERIOD_UNIT_WORDS: Record<PeriodMetricUnit, string> = {
  count: 'Counts',
  pct: 'Percentages',
  hours: 'Time',
  lines: 'Lines changed',
  ratio: 'Per merged PR',
};

/** The metrics shown before the reader picks any. */
export const PERIOD_SERIES_DEFAULT_METRICS: readonly PeriodMetricKey[] = ['merged_prs'];

export function metricOf(p: PeriodSeriesPoint, key: PeriodMetricKey): PeriodMetricValue | undefined {
  return p.metrics.find((m) => m.key === key);
}

export function deltaOf(p: PeriodSeriesPoint, key: PeriodMetricKey) {
  return p.deltas.find((d) => d.key === key);
}

/** The figures, null where there is no data (never 0). */
export function valuesOf(periods: readonly PeriodSeriesPoint[], key: PeriodMetricKey): (number | null)[] {
  return periods.map((p) => metricOf(p, key)?.value ?? null);
}

export interface ChangeSeries {
  /** The baseline period's index and figure; null ⇒ refused. */
  base: { index: number; value: number } | null;
  /** % change from the baseline per period (null where there is no figure). All null when refused. */
  values: (number | null)[];
}

const pctFrom = (base: number, v: number): number => Math.round(((v - base) / base) * 1000) / 10;

/**
 * Each period as % change from the metric's baseline: its FIRST period with a figure above zero
 * that is not a thin sample. Periods before the baseline are still drawn relative to it.
 */
export function changeSeries(periods: readonly PeriodSeriesPoint[], key: PeriodMetricKey): ChangeSeries {
  let base: ChangeSeries['base'] = null;
  for (const [index, p] of periods.entries()) {
    const m = metricOf(p, key);
    if (m?.value != null && m.value > 0 && m.lowSample !== true) {
      base = { index, value: m.value };
      break;
    }
  }
  if (base == null) return { base: null, values: periods.map(() => null) };
  const b = base.value;
  return { base, values: periods.map((p) => {
    const v = metricOf(p, key)?.value;
    return v == null ? null : pctFrom(b, v);
  }) };
}

/** The projection in the reading's units: the figures, or % change from the baseline. */
export function projectionIn(
  forecast: PeriodForecast | undefined,
  mode: 'change' | 'values',
  base: ChangeSeries['base'],
): { point: number; low: number; high: number } | null {
  if (forecast == null || !forecast.available) return null;
  if (mode === 'values') return { point: forecast.point, low: forecast.low, high: forecast.high };
  if (base == null) return null;
  return { point: pctFrom(base.value, forecast.point), low: pctFrom(base.value, forecast.low), high: pctFrom(base.value, forecast.high) };
}

/** The VALUES reading's panels: the picked metrics grouped by unit, in the order first picked. */
export function unitGroups(keys: readonly PeriodMetricKey[]): Array<{ unit: PeriodMetricUnit; keys: PeriodMetricKey[] }> {
  const out: Array<{ unit: PeriodMetricUnit; keys: PeriodMetricKey[] }> = [];
  for (const k of keys) {
    const unit = PERIOD_METRIC_UNIT[k];
    const g = out.find((x) => x.unit === unit);
    if (g != null) g.keys.push(k);
    else out.push({ unit, keys: [k] });
  }
  return out;
}

/** Toggle a metric chip; the last one cannot be switched off (an empty chart says nothing). */
export function toggleMetric(keys: readonly PeriodMetricKey[], key: PeriodMetricKey): PeriodMetricKey[] {
  if (keys.includes(key)) return keys.length === 1 ? [...keys] : keys.filter((k) => k !== key);
  return [...keys, key];
}

/**
 * The CHANGE axis: always includes 0, ticks on a round step (10, 20, 25, 50, 100… per cent), so the
 * gridlines read "+25%", never "+31%".
 */
export function changeAxis(values: readonly (number | null)[]): { min: number; max: number; ticks: number[] } {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  const lo = Math.min(0, ...xs);
  const hi = Math.max(0, ...xs);
  const raw = Math.max((hi - lo) / 4, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((x) => x >= raw) ?? 10 * mag;
  const min = Math.floor(lo / step) * step;
  const max = Math.max(min + step, Math.ceil(hi / step) * step);
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t * 10) / 10);
  return { min, max, ticks };
}

/** "+12%" / "−8.5%" / "0%". */
export function changeLabel(pct: number): string {
  const n = Math.abs(pct);
  const t = `${n % 1 === 0 ? n : n.toFixed(1)}%`;
  return pct > 0 ? `+${t}` : pct < 0 ? `−${t}` : t;
}

/**
 * The series as a Markdown table — the forwardable copy. Rows are periods (oldest first), columns
 * the picked metrics in their own units; "—" where there is no figure (never 0).
 */
export function seriesMarkdown(
  periods: readonly PeriodSeriesPoint[],
  keys: readonly PeriodMetricKey[],
  label: (k: PeriodMetricKey) => string,
  format: (k: PeriodMetricKey, v: number) => string,
  periodLabel: (p: PeriodSeriesPoint) => string,
  repos: { measured: number; total: number },
): string {
  const head = `| Period | ${keys.map(label).join(' | ')} |`;
  const sep = `| --- |${keys.map(() => ' ---: |').join('')}`;
  const rows = periods.map((p) => `| ${periodLabel(p)} | ${keys.map((k) => {
    const v = metricOf(p, k)?.value;
    return v == null ? '—' : format(k, v);
  }).join(' | ')} |`);
  const note = repos.measured === repos.total ? `All ${repos.total} repos.` : `${repos.measured} of ${repos.total} repos: the ones tracked across every period.`;
  return [head, sep, ...rows, '', note].join('\n');
}
