import { useMemo, useState } from 'react';
import type {
  AnalyticsBin,
  BotBehaviourAnomaly,
  BotBehaviourBotStat,
  BotBehaviourMl,
  BotBehaviourMlBot,
  BotOverlapStats,
  BotRepoDirBreakdown,
  BotWindowKind,
  MlSeverityCounts,
} from '@pierre-review/shared';
import { useBotBehaviour } from '../../hooks/useBotTriage.js';
import { useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { useFilters } from '../../store/filters.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import {
  ML_CATEGORY_COLOR,
  ML_CATEGORY_LABEL,
  ML_SEVERITY_META,
  automatedReviewerMeta,
} from '../../lib/ui.js';
import {
  SEVERITY_STACK_ORDER,
  categoriesPresent,
  categoryWeeklySeries,
  meanSeverityValues,
  mlWeekLabels,
  severityBreakdownNote,
  severityTotal,
} from '../../lib/botMlSeries.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { Heatmap } from '../charts/Heatmap.js';
import { DayStrip } from '../charts/DayStrip.js';
import {
  ChartCard,
  ChartEmpty,
  FloatingTip,
  PALETTE,
  SERIES_COLORS,
  fmtDuration,
  fmtNum,
  niceMax,
  useChartWidth,
  type Series,
} from '../charts/common.js';

type BotColorFn = (bot: { login?: string | null; kind: BotBehaviourBotStat['kind'] }) => string;

// EXPERIMENTAL bot BEHAVIOUR panel — the Bots view's second inner sub-tab, kept SEPARATE from
// the shipped ROI panel so it can mature independently. CORE + deterministic (no AI): it reads
// the /api/bot-behaviour route (getBotBehaviourAnalytics). Per bot, over the shared analytics
// window (+ a 12-week trend), it answers the common review-bot gripes:
//   • Time-to-first-review (TTFR) — how long until the bot first looks (from ready-for-review,
//     fallback opened),
//   • LoC-to-comments ratio — how noisy the bot is per line of code,
//   • the week × hour activity heatmap — WHEN it's active (coverage gaps / rate-limit inference,
//     INFERRED from timestamps — labelled as such, UTC),
//   • follow-up behaviour — does it keep finding issues after its first pass.
// Scope + window come from the store (shared with the ROI panel): the ACTIVE WORKSPACE decides
// which logins count as automated reviewers, the optional `repoId` narrows the measured data to
// one repo, and the window is the same one the ROI panel's picker sets.

const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

// A duration axis formatter (BarChart/LineChart never pass null).
const durAxis = (n: number): string => fmtDuration(n);
const countAxis = (n: number): string => String(Math.round(n));
const pctAxis = (n: number): string => `${Math.round(n)}%`;
// Density values are small decimals (threads per PR / per KLoC): 1 dp under 10, whole above.
const densAxis = (n: number): string => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

function dur(h: number | null): string {
  return h == null ? '—' : fmtDuration(h);
}

// Format an anomaly's observed/typical value in the metric's own units (for the evidence note).
function fmtMetricVal(metric: BotBehaviourAnomaly['metric'], v: number): string {
  if (metric === 'ttfr') return fmtDuration(v);
  if (metric === 'followup') return `${Math.round(v)}%`;
  if (metric === 'silence') return `${v}d`;
  return String(Math.round(v)); // volume
}

// The evidence note for a weekly metric's ChartCard: how many exceptions + the latest one's
// observed-vs-typical (the "vs its own typical" a customer's consistency claim needs). Undefined
// when the bot was consistent for this metric (no note — the chart just reads clean).
function anomalyNote(
  anomalies: BotBehaviourAnomaly[],
  metric: 'ttfr' | 'volume' | 'followup',
): string | undefined {
  const hits = anomalies.filter((a) => a.metric === metric);
  if (hits.length === 0) return undefined;
  const latest = hits[0]!; // list is newest-first
  const obs = fmtMetricVal(metric, latest.observed);
  const typ = fmtMetricVal(metric, latest.typical);
  const arrow = latest.direction === 'high' ? '↑' : '↓';
  return `⚠ ${hits.length} exception${hits.length === 1 ? '' : 's'} · latest ${arrow} ${obs} vs ${typ} typical`;
}

// The coverage-gap note for the daily strip (silence runs).
function silenceNote(bot: BotBehaviourBotStat): string | undefined {
  if (bot.silentRuns.length === 0) return undefined;
  const longest = Math.max(...bot.silentRuns.map((r) => r.days));
  return `⚠ ${bot.silentRuns.length} gap${bot.silentRuns.length === 1 ? '' : 's'} · longest ${longest}d silent`;
}

// One per-bot weekly trend mini-chart with anomaly rings (a week the bot diverged from its own
// typical). `value`/`flag` pull the metric + its per-week anomaly flag off each trend point.
function TrendMini({
  title,
  bot,
  value,
  flag,
  color,
  formatY,
  note,
}: {
  title: string;
  bot: BotBehaviourBotStat;
  value: (p: BotBehaviourBotStat['trend'][number]) => number | null;
  flag: (p: BotBehaviourBotStat['trend'][number]) => boolean;
  color: string;
  formatY: (n: number) => string;
  note?: string;
}): JSX.Element {
  const labels = bot.trend.map((p) => p.weekStart);
  const values = bot.trend.map(value);
  const flags = bot.trend.map(flag);
  const hasData = values.some((v) => v != null);
  return (
    <ChartCard title={title} note={note}>
      {hasData ? (
        <LineChart
          labels={labels}
          series={[{ key: title, label: title, color, values, pointFlags: flags }]}
          height={120}
          curved
          formatY={formatY}
        />
      ) : (
        <ChartEmpty label="Not enough history yet" />
      )}
    </ChartCard>
  );
}

// A compact headline stat (label + value + optional sub-line).
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-base font-semibold text-gray-800 dark:text-gray-100">{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

// One categorical distribution (TTFR buckets / follow-up counts) → a single-series bar chart.
function DistChart({ bins, color }: { bins: AnalyticsBin[]; color: string }): JSX.Element {
  if (bins.every((b) => b.count === 0)) return <ChartEmpty label="No data in this window" />;
  const series: Series[] = [
    { key: 'count', label: 'PRs', color, values: bins.map((b) => b.count) },
  ];
  return <BarChart labels={bins.map((b) => b.label)} series={series} height={130} />;
}

// ── Per-bot subset selection, shared by every cross-bot trend chart on this tab ────────────────
// `null` = every bot shown (and it STAYS correct across a window refetch, which a Set of keys
// would not — a bot dropping out of the response would silently narrow the view). Click a bot to
// FOCUS it, click more to ADD them; clicking the last one off — or ending up with all of them —
// returns to "all".
interface BotSubset {
  selected: Set<string> | null;
  isOn: (key: string) => boolean;
  toggle: (key: string) => void;
  reset: () => void;
}
// Memoised on (selection, key set) so a consumer can put the whole object in a useMemo dep list
// — a fresh object every render would silently rebuild every series on every parent render.
function useBotSubset(allKeys: string[]): BotSubset {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  return useMemo(
    () => ({
      selected,
      isOn: (key: string) => selected == null || selected.has(key),
      toggle: (key: string) =>
        setSelected((prev) => {
          if (prev == null) return new Set([key]); // from "all shown" → isolate to just this bot
          const base = new Set(prev);
          if (base.has(key)) base.delete(key);
          else base.add(key);
          if (base.size === 0 || base.size === allKeys.length) return null; // none / all → "all"
          return base;
        }),
      reset: () => setSelected(null),
    }),
    [selected, allKeys],
  );
}

// The interactive legend for the above — a bot pill per selectable series. Nothing to pick when
// there is only one bot, so it renders nothing rather than an unclickable row of one.
function BotSubsetLegend({
  bots,
  subset,
  botColor,
}: {
  bots: { key: string; label: string; login: string | null; kind: BotBehaviourBotStat['kind'] }[];
  subset: BotSubset;
  botColor: BotColorFn;
}): JSX.Element | null {
  if (bots.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {bots.map((b) => {
        const on = subset.isOn(b.key);
        const color = botColor({ login: b.login, kind: b.kind });
        return (
          <button
            key={b.key}
            type="button"
            onClick={() => subset.toggle(b.key)}
            className={`flex items-center gap-1 text-[10px] ${
              on ? 'text-gray-600 dark:text-gray-300' : 'text-gray-400 line-through opacity-60'
            }`}
          >
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: on ? color : 'transparent', boxShadow: `inset 0 0 0 1.5px ${color}` }}
            />
            {b.label}
          </button>
        );
      })}
      {subset.selected != null && (
        <button
          type="button"
          onClick={subset.reset}
          className="text-[10px] text-sky-600 hover:underline dark:text-sky-400"
        >
          all
        </button>
      )}
    </div>
  );
}

// The cross-bot findings-DENSITY trend (one line per bot over the shared ≤12-week weeks) — the
// headline "is PR quality improving?" read that replaces the old cross-bot TTFR chart (TTFR
// survives as a per-bot mini below). Each point = review threads the bot OPENED per PR / per 1000
// changed lines that week; a FALLING line means fewer issues raised per PR / per line over time
// (cleaner code or better self-review). Approximate — a tuned-down bot or more trivial PRs read
// the same way, so it rides the panel's "deterministic proxy" caveat. per-KLoC (size-adjusted) is
// the default; per-PR is the plainer view. Mirrors the old TTFR chart's union-of-weeks shape.
// Least-squares fit y = m·x + b over (x,y) points; null if <2 points or degenerate.
function fitLine(pts: { x: number; y: number }[]): { m: number; b: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const m = (n * sxy - sx * sy) / denom;
  return { m, b: (sy - m * sx) / n };
}

function DensityTrendChart({
  bots,
  botColor,
}: {
  bots: BotBehaviourBotStat[];
  botColor: BotColorFn;
}): JSX.Element {
  const [mode, setMode] = useState<'kloc' | 'pr'>('kloc');
  // Trend line ON by default — the combined line-of-best-fit is the headline "is density rising or
  // falling over the span" read, the single most decision-useful mark on this chart.
  const [showTrend, setShowTrend] = useState(true);

  // Bots that actually have density history — the selectable set (stable x-axis from all of them).
  const botsWithData = useMemo(
    () =>
      bots.filter((b) =>
        b.trend.some((p) => p.findingsPerKloc != null || p.findingsPerPr != null),
      ),
    [bots],
  );
  const allKeys = useMemo(() => botsWithData.map((b) => b.key), [botsWithData]);
  const subset = useBotSubset(allKeys);
  const { selected, isOn } = subset;

  const { labels, series, trendPct } = useMemo(() => {
    const val = (p: BotBehaviourBotStat['trend'][number]): number | null =>
      mode === 'kloc' ? p.findingsPerKloc : p.findingsPerPr;
    const weekSet = new Set<string>();
    for (const b of botsWithData) for (const p of b.trend) weekSet.add(p.weekStart);
    const labels = Array.from(weekSet).sort().slice(-12);
    const chosen = botsWithData.filter((b) => selected == null || selected.has(b.key));

    const valByBotWeek = new Map<string, Map<string, number | null>>();
    const series: Series[] = chosen
      .filter((b) => b.trend.some((p) => val(p) != null))
      .map((b) => {
        const byWeek = new Map(b.trend.map((p) => [p.weekStart, val(p)]));
        valByBotWeek.set(b.key, byWeek);
        const flagByWeek = new Map(b.trend.map((p) => [p.weekStart, p.densityAnomaly]));
        const prsByWeek = new Map(b.trend.map((p) => [p.weekStart, p.prsInWeek]));
        // Per-week exception detail from the bot's anomaly evidence (density is judged on the
        // per-KLoC series, so the note is stated in /KLoC terms regardless of the toggle).
        const noteByWeek = new Map<string, string>();
        for (const a of b.anomalies) {
          if (a.metric !== 'density' || a.weekStart == null) continue;
          const dir = a.direction === 'high' ? 'higher than usual' : 'lower than usual';
          const prs = prsByWeek.get(a.weekStart);
          const prsTxt = prs != null ? ` · over ${prs} PR${prs === 1 ? '' : 's'}` : '';
          const z = a.z != null ? ` · robust-z ${a.z}` : '';
          noteByWeek.set(
            a.weekStart,
            `${dir} — ${a.observed} vs ${a.typical}/KLoC typical${z}${prsTxt}`,
          );
        }
        return {
          key: b.key,
          label: b.label,
          color: botColor({ login: b.login, kind: b.kind }),
          values: labels.map((w) => byWeek.get(w) ?? null),
          pointFlags: labels.map((w) => flagByWeek.get(w) ?? false),
          pointNotes: labels.map((w) => noteByWeek.get(w) ?? null),
        };
      });

    // Overall trend: a log-space line of best fit over the selected bots' COMBINED weekly density
    // (mean across bots present that week). Log-space so it renders straight on the log axis and
    // its slope reads as a %-change over the span. Needs ≥2 weeks with data.
    let trendPct: number | null = null;
    if (showTrend && series.length > 0) {
      const pts: { x: number; y: number }[] = [];
      labels.forEach((w, i) => {
        const vals: number[] = [];
        for (const b of chosen) {
          const v = valByBotWeek.get(b.key)?.get(w);
          if (v != null) vals.push(v);
        }
        if (vals.length === 0) return;
        const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
        if (mean > 0) pts.push({ x: i, y: Math.log10(mean) });
      });
      const fit = fitLine(pts);
      if (fit) {
        const yAt = (i: number): number => Math.pow(10, fit.m * i + fit.b);
        series.push({
          key: '__trend__',
          label: 'Overall trend',
          color: PALETTE.amber, // yellow, prominent — painted above every bot line
          values: labels.map((_, i) => yAt(i)),
          dashed: true,
        });
        const start = yAt(0);
        const end = yAt(labels.length - 1);
        if (start > 0) trendPct = Math.round((end / start - 1) * 100);
      }
    }
    return { labels, series, trendPct };
  }, [botsWithData, botColor, mode, selected, showTrend]);

  // Direction chip: for findings density LOWER is better, so a fall reads green, a rise amber.
  const trendChip = ((): { text: string; cls: string } | null => {
    if (trendPct == null) return null;
    const arrow = trendPct <= -10 ? '↘' : trendPct >= 10 ? '↗' : '→';
    const cls =
      trendPct <= -10
        ? 'text-green-600 dark:text-green-400'
        : trendPct >= 10
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-gray-500 dark:text-gray-400';
    return { text: `${arrow} ${trendPct > 0 ? '+' : ''}${trendPct}% over 12 wks`, cls };
  })();

  const noneSelected = allKeys.length > 0 && allKeys.every((k) => !isOn(k));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px]">
          <button
            type="button"
            onClick={() => setShowTrend((s) => !s)}
            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-medium ${
              showTrend
                ? 'border-amber-400 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'border-gray-300 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            <span
              className="inline-block h-0 w-3 border-t-2 border-dashed"
              style={{ borderColor: PALETTE.amber }}
            />
            Trend line
          </button>
          {showTrend && trendChip && <span className={`font-medium ${trendChip.cls}`}>{trendChip.text}</span>}
        </div>
        <div className="inline-flex overflow-hidden rounded border border-gray-300 text-[10px] dark:border-gray-700">
          {([
            ['kloc', 'per KLoC'],
            ['pr', 'per PR'],
          ] as const).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              onClick={() => setMode(k)}
              className={`px-2 py-0.5 font-medium ${
                mode === k
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* Interactive legend / bot selector — click a bot to focus just it; click others to add. */}
      <BotSubsetLegend bots={botsWithData} subset={subset} botColor={botColor} />

      {noneSelected ? (
        <ChartEmpty label="Select at least one bot" />
      ) : labels.length < 2 || series.length === 0 ? (
        <ChartEmpty label="Not enough weekly history yet" />
      ) : (
        <LineChart
          labels={labels}
          series={series}
          height={150}
          curved
          logY
          tipBelow
          hideLegend
          formatY={densAxis}
        />
      )}
    </div>
  );
}

// ── ML severity / category charts (CORE, free tier, deterministic — no LLM) ────────────────────
// What the severity model made of everything these bots WROTE, over the same scope + window as the
// rest of the tab. Five charts: our severity mix per bot, the bot's OWN declared badge beside it,
// severity over time, and — folded away — the same two questions asked of categories.
//
// Every one of them is gated on `mlSeverity` from /api/me: with no severity-api configured there
// are no labels at all, and the server omits the whole block rather than shipping empty rows.
//
// ⚠ THE VENDOR BADGE IS SHOWN, NEVER BELIEVED. It is the least accurate number on the tab (0.474
// exact vs our 0.700 on the adjudicated gold set) and nothing may derive from it — it is here
// precisely so a reader can see where the two disagree.

// One bot's ML fold joined to its identity from the `bots` rows (the `key` is the join).
interface MlBotView {
  key: string;
  label: string;
  login: string | null;
  kind: BotBehaviourBotStat['kind'];
  ml: BotBehaviourMlBot;
}

// nit(1) … critical(4) — the fixed ordinal axis the "severity over time" line is drawn on. A
// fractional value is a weekly MEAN, so it gets a number rather than a class name it isn't.
const SEV_ORD_LABEL: Record<number, string> = { 1: 'Nit', 2: 'Minor', 3: 'Major', 4: 'Critical' };
const sevOrdAxis = (n: number): string => SEV_ORD_LABEL[n] ?? n.toFixed(1);

// Charts 1, 2 and 4: one stacked bar per bot. Bars are coloured by the SEVERITY (or category)
// stacked inside them, not by the bot — so a bot's own colour deliberately does not appear here;
// it identifies the LINES on the two trend charts, where the series is the bot itself.
//
// ⚠ THE DEFAULT IS SHARE, NOT COUNT, and it has to be: these bots' volumes differ by three orders
// of magnitude in real data (927 findings against 1), so a count-stacked "mix" draws one tall bar
// and a row of invisible slivers — and comparing OUR mix to the VENDOR'S is impossible at two
// different denominators, which is the entire point of the pair. Counts stay one click away, and
// the caveat lines under each chart state the totals either way.
type MixMode = 'share' | 'count';
const mixAxis = (mode: MixMode) => (n: number) => (mode === 'share' ? `${Math.round(n)}%` : fmtNum(n));

// Counts → the values a stack should draw: raw, or each BAR normalised to its own total.
//
// `counts[series][bar]`, and the whole matrix at once rather than a series at a time, because a
// column has to sum to EXACTLY 100: BarChart's axis is `niceMax(tallest stack)`, and four shares
// summing to 100.00000000000001 in float pushes niceMax from 100 straight to 200 — every bar then
// draws at half height under a "200%" axis. The last non-zero series in each column absorbs the
// rounding residue, which is invisible (sub-1e-13) and makes the overflow impossible.
function mixValues(counts: number[][], mode: MixMode): number[][] {
  if (mode === 'count') return counts;
  const bars = counts[0]?.length ?? 0;
  const out = counts.map((row) => row.slice());
  for (let i = 0; i < bars; i++) {
    const total = counts.reduce((n, row) => n + (row[i] ?? 0), 0);
    let last = -1;
    for (let s = 0; s < counts.length; s++) if ((counts[s]![i] ?? 0) > 0) last = s;
    if (total <= 0 || last < 0) {
      for (const row of out) row[i] = 0;
      continue;
    }
    let acc = 0;
    for (let s = 0; s < counts.length; s++) {
      if (s === last) {
        out[s]![i] = 100 - acc;
        continue;
      }
      const share = ((counts[s]![i] ?? 0) / total) * 100;
      out[s]![i] = share;
      acc += share;
    }
  }
  return out;
}

function StackedByBotChart({
  rows,
  series,
  mode,
  height = 160,
}: {
  rows: { label: string }[];
  series: Series[];
  mode: MixMode;
  height?: number;
}): JSX.Element {
  return (
    <BarChart
      labels={rows.map((r) => r.label)}
      series={series}
      mode="stacked"
      height={height}
      rotateLabels
      formatY={mixAxis(mode)}
    />
  );
}

// The count | % switch above the stacked bars — one control for all three of them, so "how are
// these bars measured" is answered once for the tab rather than per card.
function MixModeToggle({
  mode,
  setMode,
}: {
  mode: MixMode;
  setMode: (m: MixMode) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-400">Bars</span>
      <div className="inline-flex overflow-hidden rounded border border-gray-300 text-[10px] dark:border-gray-700">
        {(
          [
            ['share', 'share of each bot'],
            ['count', 'counts'],
          ] as const
        ).map(([k, lbl]) => (
          <button
            key={k}
            type="button"
            onClick={() => setMode(k)}
            className={`px-2 py-0.5 font-medium ${
              mode === k
                ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

function severitySeries(rows: { counts: MlSeverityCounts }[], mode: MixMode): Series[] {
  const values = mixValues(
    SEVERITY_STACK_ORDER.map((s) => rows.map((r) => r.counts[s])),
    mode,
  );
  return SEVERITY_STACK_ORDER.map((s, i) => ({
    key: s,
    label: ML_SEVERITY_META[s].label,
    color: ML_SEVERITY_META[s].color,
    values: values[i]!,
  }));
}

// Chart 3 — weekly MEAN severity, one line per bot: "is this bot's bar rising or falling?".
// The mean is plotted on the 1–4 ordinal with the class names as the axis (an explicit yDomain;
// the default scale would tick at 0 and 5, two values a severity cannot take), and the week's
// actual counts ride along in the hover note so a mean drawn from three findings can be told
// apart from one drawn from ninety.
function MlSeverityTrendChart({
  views,
  subset,
  botColor,
}: {
  views: MlBotView[];
  subset: BotSubset;
  botColor: BotColorFn;
}): JSX.Element {
  const labels = useMemo(() => mlWeekLabels(views.map((v) => v.ml)), [views]);
  const series = useMemo(() => {
    const out: Series[] = [];
    for (const v of views) {
      if (!subset.isOn(v.key)) continue;
      const values = meanSeverityValues(v.ml, labels);
      if (values.every((x) => x == null)) continue;
      const byWeek = new Map(v.ml.weekly.map((p) => [p.weekStart, p.bySeverity]));
      out.push({
        key: v.key,
        label: v.label,
        color: botColor({ login: v.login, kind: v.kind }),
        values,
        pointNotes: labels.map((w) => {
          const counts = byWeek.get(w);
          return counts ? severityBreakdownNote(counts) : null;
        }),
      });
    }
    return out;
  }, [views, subset, labels, botColor]);

  const noneSelected = views.length > 0 && views.every((v) => !subset.isOn(v.key));
  return (
    <div className="space-y-2">
      <BotSubsetLegend bots={views} subset={subset} botColor={botColor} />
      {noneSelected ? (
        <ChartEmpty label="Select at least one bot" />
      ) : labels.length < 2 || series.length === 0 ? (
        <ChartEmpty label="Not enough weekly history yet" />
      ) : (
        <LineChart
          labels={labels}
          series={series}
          height={160}
          curved
          hideLegend
          noteTone="muted"
          formatY={sevOrdAxis}
          yDomain={{ min: 1, max: 4, ticks: [1, 2, 3, 4] }}
        />
      )}
    </div>
  );
}

// Chart 5 (folded) — the same weeks, one line per CATEGORY, summed over the bots selected on
// chart 3. Zero is a real value here ("nobody raised a security finding that week"), unlike the
// severity mean above, so these lines touch the floor instead of breaking.
function MlCategoryTrendChart({
  views,
  subset,
}: {
  views: MlBotView[];
  subset: BotSubset;
}): JSX.Element {
  const labels = useMemo(() => mlWeekLabels(views.map((v) => v.ml)), [views]);
  const series = useMemo(() => {
    const shown = views.filter((v) => subset.isOn(v.key));
    return categoryWeeklySeries(
      shown.map((v) => v.ml),
      labels,
    ).map<Series>((c) => ({
      key: c.category,
      label: ML_CATEGORY_LABEL[c.category],
      color: ML_CATEGORY_COLOR[c.category],
      values: c.values,
    }));
  }, [views, subset, labels]);

  if (labels.length < 2 || series.length === 0)
    return <ChartEmpty label="No categorised bot comments in this span" />;
  // Log scale, like the density trend: real corpora run one dominant category in the hundreds
  // against a handful in single digits, and on a linear axis every line but one is pinned flat to
  // the floor. Zeros sit on the bottom decade (LineChart's own rule), so a quiet week reads as
  // "nothing much" rather than disappearing.
  return <LineChart labels={labels} series={series} height={160} curved logY centerTip />;
}

function MlCharts({
  bots,
  ml,
  botColor,
  windowLabel,
}: {
  bots: BotBehaviourBotStat[];
  ml: BotBehaviourMl;
  botColor: BotColorFn;
  windowLabel: string;
}): JSX.Element | null {
  const views = useMemo<MlBotView[]>(() => {
    const byKey = new Map(bots.map((b) => [b.key, b]));
    return ml.perBot.flatMap((m) => {
      const b = byKey.get(m.key);
      return b ? [{ key: m.key, label: b.label, login: b.login, kind: b.kind, ml: m }] : [];
    });
  }, [bots, ml]);
  const allKeys = useMemo(() => views.map((v) => v.key), [views]);
  // ONE subset across the two trend charts, so isolating a bot on "Severity over time" carries
  // into the category trend below it and the two read as a single investigation.
  const subset = useBotSubset(allKeys);
  const [showMore, setShowMore] = useState(false);
  const [mixMode, setMixMode] = useState<MixMode>('share');

  const model = useMemo(() => {
    const mixRows = views
      .filter((v) => severityTotal(v.ml.bySeverity) > 0)
      .map((v) => ({ label: v.label, counts: v.ml.bySeverity }));
    const vendorRows = views
      .filter((v) => v.ml.vendorDeclared > 0)
      .map((v) => ({ label: v.label, counts: v.ml.byVendorSeverity }));
    const catRows = views.filter((v) => v.ml.byCategory.length > 0);
    const categories = categoriesPresent(catRows.map((v) => v.ml));
    const catValues = mixValues(
      categories.map((c) =>
        catRows.map((v) => v.ml.byCategory.find((x) => x.category === c)?.count ?? 0),
      ),
      mixMode,
    );
    const catSeries: Series[] = categories.map((c, i) => ({
      key: c,
      label: ML_CATEGORY_LABEL[c],
      color: ML_CATEGORY_COLOR[c],
      values: catValues[i]!,
    }));
    return {
      mixRows,
      vendorRows,
      catRows,
      catSeries,
      findings: views.reduce((n, v) => n + v.ml.findings, 0),
      vendorDeclared: views.reduce((n, v) => n + v.ml.vendorDeclared, 0),
    };
  }, [views, mixMode]);

  if (views.length === 0) return null;
  const { mixRows, vendorRows, catRows, catSeries, findings, vendorDeclared } = model;
  const windowNote = `model-scored · findings only · ${windowLabel}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {ml.truncated ? (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">
            ⚠ the label scan hit its cap — these counts are the most recent sample, not the total.
          </span>
        ) : (
          <span />
        )}
        <MixModeToggle mode={mixMode} setMode={setMixMode} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard title="Severity mix per bot (Limn)" note={windowNote}>
          {mixRows.length === 0 ? (
            <ChartEmpty label="No scored findings in this window" />
          ) : (
            <StackedByBotChart
              rows={mixRows}
              series={severitySeries(mixRows, mixMode)}
              mode={mixMode}
            />
          )}
          <div className="mt-1 text-[10px] text-gray-400">
            Our model’s reading of what each bot raised. Summaries and acknowledgments are labelled
            work but not findings, so neither is counted here.
          </div>
        </ChartCard>

        <ChartCard title="Severity mix per bot (bot’s own badge)" note={`self-declared · ${windowLabel}`}>
          {vendorRows.length === 0 ? (
            <ChartEmpty label="No bot declared a severity in this window" />
          ) : (
            <StackedByBotChart
              rows={vendorRows}
              series={severitySeries(vendorRows, mixMode)}
              mode={mixMode}
            />
          )}
          <div className="mt-1 text-[10px] text-gray-400">
            What each bot <span className="font-medium">claims</span> about its own findings —
            shown beside ours because the disagreement is the product, never used to correct or
            replace our label. Only {fmtNum(vendorDeclared)} of {fmtNum(findings)} findings carry a
            badge at all, so this mix is a sparser sample than the one on the left.
          </div>
        </ChartCard>
      </div>

      <ChartCard
        title="Severity over time"
        note="weekly mean severity · findings only · hover for the week’s counts"
      >
        <MlSeverityTrendChart views={views} subset={subset} botColor={botColor} />
      </ChartCard>

      <div>
        <button
          type="button"
          onClick={() => setShowMore((s) => !s)}
          className="text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          {showMore ? '▾' : '▸'} More charts — categories
        </button>
        {showMore && (
          <div className="mt-3 space-y-3">
            <ChartCard title="Categories per vendor" note={`what each bot talks about · ${windowLabel}`}>
              {catRows.length === 0 || catSeries.length === 0 ? (
                <ChartEmpty label="No categorised bot comments in this window" />
              ) : (
                <StackedByBotChart
                  rows={catRows.map((v) => ({ label: v.label }))}
                  series={catSeries}
                  mode={mixMode}
                />
              )}
              <div className="mt-1 text-[10px] text-gray-400">
                Multi-label: one comment can count under several categories, so a bot’s category
                total exceeds its finding count — each bar is a share of that bot’s own mentions,
                not of its findings. Walkthrough summaries are excluded (their categories are a
                read of the template, not of a finding); acknowledgments appear as “Praise”.
              </div>
            </ChartCard>
            <ChartCard
              title="Category activity over time"
              note="weekly · log scale · over the bots selected above"
            >
              <MlCategoryTrendChart views={views} subset={subset} />
            </ChartCard>
          </div>
        )}
      </div>
    </div>
  );
}

// Per-bot detail: headline stats + TTFR distribution + the week×hour activity heatmap + the
// follow-up distribution. One card per bot, brand-coloured.
function BotCard({
  bot,
  color,
  prsOpenedPerDay,
}: {
  bot: BotBehaviourBotStat;
  color: string;
  // Shared across bots: human-authored, non-draft PRs opened per day over the same span.
  prsOpenedPerDay?: number[];
}): JSX.Element {
  const meta = automatedReviewerMeta(bot.kind);
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
          {bot.label}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color: meta.color, background: `${meta.color}1a` }}
        >
          {meta.label}
        </span>
        <span className="text-[11px] text-gray-400">
          {bot.prsReviewed} PR{bot.prsReviewed === 1 ? '' : 's'} first-reviewed · {bot.totalActivity}{' '}
          action{bot.totalActivity === 1 ? '' : 's'} in window
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Time to first review"
          value={dur(bot.ttfrMedianHours)}
          sub={
            bot.ttfrP90Hours != null
              ? `p90 ${dur(bot.ttfrP90Hours)}${bot.ttfrBaseline ? ` · from ${bot.ttfrBaseline === 'mixed' ? 'ready/opened' : bot.ttfrBaseline}` : ''}`
              : bot.ttfrBaseline
                ? `from ${bot.ttfrBaseline === 'mixed' ? 'ready/opened' : bot.ttfrBaseline}`
                : undefined
          }
        />
        <Stat
          label="LoC per comment"
          value={bot.medianLocPerComment == null ? '—' : String(Math.round(bot.medianLocPerComment))}
          sub={`${bot.totalComments} comment${bot.totalComments === 1 ? '' : 's'}`}
        />
        <Stat
          label="Follow-up rate"
          value={bot.followupRatePct == null ? '—' : `${bot.followupRatePct}%`}
          sub={bot.avgFollowups == null ? undefined : `avg ${bot.avgFollowups} extra`}
        />
        <Stat label="Follow-up latency" value={dur(bot.followupLatencyMedianHours)} sub="median gap" />
      </div>

      {/* Consistency over time — each weekly metric vs the bot's OWN typical; red rings mark the
          weeks it diverged (the "evidence to the contrary" a customer's consistency claim needs). */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <TrendMini
          title="Time to first review"
          bot={bot}
          value={(p) => p.medianTtfrHours}
          flag={(p) => p.ttfrAnomaly}
          color={color}
          formatY={durAxis}
          note={anomalyNote(bot.anomalies, 'ttfr') ?? 'weekly · vs own typical'}
        />
        <TrendMini
          title="Review volume"
          bot={bot}
          value={(p) => p.volume}
          flag={(p) => p.volumeAnomaly}
          color={color}
          formatY={countAxis}
          note={anomalyNote(bot.anomalies, 'volume') ?? 'touches / week'}
        />
        <TrendMini
          title="Follow-up rate"
          bot={bot}
          value={(p) => p.followupRatePct}
          flag={(p) => p.followupAnomaly}
          color={color}
          formatY={pctAxis}
          note={anomalyNote(bot.anomalies, 'followup') ?? 'weekly · vs own typical'}
        />
      </div>

      {/* Daily coverage strip — silent runs (a normally-regular bot going quiet) underlined in the
          anomaly colour. The "gaps in reviews" made visible. */}
      <ChartCard
        title="Daily coverage"
        note={
          silenceNote(bot) ??
          (prsOpenedPerDay != null
            ? 'one cell / day · line = PRs opened · last 12 weeks (UTC)'
            : 'one cell / day · last 12 weeks (UTC)')
        }
      >
        <DayStrip
          daily={bot.dailyActivity}
          startDate={bot.daySpanStart}
          silentRuns={bot.silentRuns}
          color={color}
          opened={prsOpenedPerDay}
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <ChartCard title="Time to first review" note="distribution">
          <DistChart bins={bot.ttfrDist} color={color} />
        </ChartCard>
        <ChartCard title="Activity by hour" note="week × hour (UTC) · inferred coverage">
          {bot.totalActivity > 0 ? (
            <Heatmap cells={bot.activityHeatmap} color={color} />
          ) : (
            <ChartEmpty label="No activity in this window" />
          )}
        </ChartCard>
        <ChartCard title="Follow-ups after first review" note="extra touches / PR">
          <DistChart bins={bot.followupDist} color={color} />
        </ChartCard>
      </div>
    </div>
  );
}

// ── Cross-bot overlap (EXPERIMENTAL): multiple bots on the same PR + same-line overlap ──────────
function BotOverlapSection({ overlap, color }: { overlap: BotOverlapStats; color: string }): JSX.Element | null {
  const { reviewedPrs, multiReviewedPrs, distribution, pairs, lineOverlapClusters, lineOverlapPrs } =
    overlap;
  if (reviewedPrs === 0) return null;
  const pct = Math.round((multiReviewedPrs / reviewedPrs) * 100);
  const maxPair = Math.max(1, ...pairs.map((p) => p.prs));
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Bot overlap</span>
        <span className="text-[11px] text-gray-400">
          where more than one bot reviews the same PR or line — distinct bot accounts, this window
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="PRs with ≥2 bots"
          value={String(multiReviewedPrs)}
          sub={`${pct}% of ${reviewedPrs} reviewed`}
        />
        <Stat
          label="Same-line overlaps"
          value={String(lineOverlapClusters)}
          sub={lineOverlapClusters > 0 ? `across ${lineOverlapPrs} PR${lineOverlapPrs === 1 ? '' : 's'}` : 'no collisions'}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard title="PRs by bot count" note="how many bots touched each reviewed PR">
          <DistChart bins={distribution} color={color} />
        </ChartCard>
        <ChartCard title="Most-overlapping bot pairs" note="PRs both bots reviewed">
          {pairs.length === 0 ? (
            <ChartEmpty label="No PR was reviewed by two bots" />
          ) : (
            <ul className="space-y-1 py-1">
              {pairs.slice(0, 8).map((p) => (
                <li key={`${p.aKey}-${p.bKey}`} className="flex items-center gap-2 text-[11px]">
                  <span className="w-40 shrink-0 truncate text-gray-600 dark:text-gray-300" title={`${p.aLabel} ↔ ${p.bLabel}`}>
                    {p.aLabel} <span className="text-gray-400">↔</span> {p.bLabel}
                  </span>
                  <span className="h-2 rounded-full bg-sky-400/70" style={{ width: `${(p.prs / maxPair) * 100}%`, minWidth: 4 }} />
                  <span className="ml-auto shrink-0 tabular-nums text-gray-400">{p.prs}</span>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

function areaLabel(dir: string): string {
  return dir === '.' ? '(root)' : dir === 'other' ? 'other' : dir;
}

// ── Merged "Where bots work" (EXPERIMENTAL) — ONE bot-centric grouped+stacked bar. X = bot type;
// within each bot, a bar per repo it operates in; each bar stacked by top-level directory (shared
// area colours + an 'other' tail). Replaces the old separate repo×bot ("operate") + repo×area
// ("work") charts. A single-repo scope collapses to one bar per bot (labelled by bot). Bar height
// = actual thread volume (levels), not normalised. Custom SVG (grouped+stacked isn't a BarChart
// mode). Caps: top 6 bots × top 5 repos each; top 8 shared area colours + an 'other' tail. ─────────
function BotRepoWorkChart({
  data,
  botColor,
}: {
  data: BotRepoDirBreakdown[];
  botColor: BotColorFn;
}): JSX.Element | null {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const bots = data.filter((b) => b.repos.some((r) => r.totalThreads > 0)).slice(0, 6);
    if (bots.length === 0) return null;

    // Shared directory colours: rank named dirs (excl. 'other') across everything; the top get a
    // distinct colour, the rest (+ each repo's own 'other' tail) fold into one grey 'other'.
    const dirTotals = new Map<string, number>();
    for (const b of bots)
      for (const r of b.repos)
        for (const d of r.dirs) {
          if (d.dir === 'other') continue;
          dirTotals.set(d.dir, (dirTotals.get(d.dir) ?? 0) + d.count);
        }
    const topDirs = [...dirTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([d]) => d);
    const topIdx = new Map(topDirs.map((d, i) => [d, i]));
    const colorOf = (dir: string): string =>
      dir === 'other' ? PALETTE.gray : SERIES_COLORS[(topIdx.get(dir) ?? 0) % SERIES_COLORS.length]!;

    type Seg = { dir: string; count: number; color: string };
    type Col = { botLabel: string; botColor: string; repoName: string; repoFull: string; segments: Seg[]; total: number };
    const columns: Col[] = [];
    const groups: { label: string; color: string; start: number; count: number }[] = [];
    let usesOther = false;
    for (const b of bots) {
      const bc = botColor({ login: b.login, kind: b.kind });
      const start = columns.length;
      for (const r of b.repos.slice(0, 5)) {
        const named = new Map<string, number>();
        let other = 0;
        for (const d of r.dirs) {
          if (topIdx.has(d.dir)) named.set(d.dir, (named.get(d.dir) ?? 0) + d.count);
          else other += d.count;
        }
        const segments: Seg[] = topDirs
          .filter((d) => named.has(d))
          .map((d) => ({ dir: d, count: named.get(d)!, color: colorOf(d) }));
        if (other > 0) {
          segments.push({ dir: 'other', count: other, color: PALETTE.gray });
          usesOther = true;
        }
        columns.push({
          botLabel: b.label,
          botColor: bc,
          repoName: r.repoName.split('/').pop() ?? r.repoName,
          repoFull: r.repoName,
          segments,
          total: r.totalThreads,
        });
      }
      groups.push({ label: b.label, color: bc, start, count: columns.length - start });
    }
    if (columns.length === 0) return null;

    const singleRepo = new Set(columns.map((c) => c.repoFull)).size <= 1;
    const legend = [
      ...topDirs.map((d) => ({ dir: d, color: colorOf(d) })),
      ...(usesOther ? [{ dir: 'other', color: PALETTE.gray }] : []),
    ];
    return { columns, groups, singleRepo, legend };
  }, [data, botColor]);

  if (!model) return null;
  const { columns, groups, singleRepo, legend } = model;

  const height = 210;
  const PAD_L = 30;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = singleRepo ? 42 : 56; // rotated labels (repo/bot) + a bot band beneath (multi-repo)
  const innerW = Math.max(w - PAD_L - PAD_R, 1);
  const innerH = height - PAD_T - PAD_B;
  const baseY = PAD_T + innerH;
  const maxV = niceMax(Math.max(1, ...columns.map((c) => c.total)));
  const y = (v: number): number => PAD_T + innerH * (1 - v / maxV);

  // Column layout: a wide gap between bot groups; a hair-gap between a group's repos.
  const GROUP_GAP = 0.8;
  const INTRA_GAP = 0.14;
  const groupStarts = new Set(groups.map((g) => g.start));
  const gapBefore: number[] = columns.map((_, i) => (i === 0 ? 0 : singleRepo || groupStarts.has(i) ? GROUP_GAP : INTRA_GAP));
  const totalUnits = columns.length + gapBefore.reduce((a, b) => a + b, 0);
  const unitW = innerW / Math.max(totalUnits, 1);
  const colLeft: number[] = [];
  let cursor = PAD_L;
  columns.forEach((_, i) => {
    cursor += gapBefore[i]! * unitW;
    colLeft.push(cursor);
    cursor += unitW;
  });
  const barW = Math.max(unitW * 0.82, 1);
  const barX = (i: number): number => colLeft[i]! + (unitW - barW) / 2;
  const colCenter = (i: number): number => colLeft[i]! + unitW / 2;

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const mx = e.nativeEvent.offsetX;
    let best = 0;
    let bestD = Infinity;
    columns.forEach((_, i) => {
      const d = Math.abs(colCenter(i) - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <ChartCard
      title="Where bots work"
      note={
        singleRepo
          ? 'per bot: inline threads by codebase area'
          : 'per bot: inline threads by repo, split by codebase area'
      }
    >
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} className="block">
            {[0, maxV].map((v) => (
              <g key={v}>
                <line x1={PAD_L} y1={y(v)} x2={w - PAD_R} y2={y(v)} className="text-gray-200 dark:text-gray-700" stroke="currentColor" strokeWidth={1} />
                <text x={PAD_L - 4} y={y(v) + 3} textAnchor="end" className="fill-gray-400 text-[8px]">
                  {fmtNum(v)}
                </text>
              </g>
            ))}
            {hover != null && (
              <rect x={colLeft[hover]!} y={PAD_T} width={unitW} height={innerH} className="text-gray-400/10 dark:text-gray-300/10" fill="currentColor" />
            )}
            {columns.map((c, i) => {
              let acc = 0;
              return c.segments.map((s) => {
                const yTop = y(acc + s.count);
                const h = y(acc) - yTop;
                acc += s.count;
                return <rect key={`${i}-${s.dir}`} x={barX(i)} y={yTop} width={barW} height={Math.max(h, 0)} fill={s.color} />;
              });
            })}
            {columns.map((c, i) => {
              const cx = colCenter(i);
              const ly = baseY + 9;
              return (
                <text key={`lbl-${i}`} x={cx} y={ly} textAnchor="end" transform={`rotate(-35 ${cx} ${ly})`} className="fill-gray-400 text-[8px]">
                  {singleRepo ? c.botLabel : c.repoName}
                </text>
              );
            })}
            {!singleRepo &&
              groups.map((g) => {
                const x0 = barX(g.start);
                const x1 = barX(g.start + g.count - 1) + barW;
                const gy = baseY + 40;
                return (
                  <g key={`grp-${g.start}`}>
                    <line x1={x0} y1={gy} x2={x1} y2={gy} stroke={g.color} strokeWidth={2} />
                    <text x={(x0 + x1) / 2} y={gy + 10} textAnchor="middle" className="text-[8px] font-medium" fill={g.color}>
                      {g.label}
                    </text>
                  </g>
                );
              })}
            <rect x={0} y={0} width={w} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </svg>
        )}
        {hover != null &&
          w > 0 &&
          (() => {
            const c = columns[hover]!;
            return (
              <FloatingTip x={colCenter(hover)} y={PAD_T} width={w}>
                <div className="font-medium">
                  {c.botLabel}
                  {!singleRepo && <span className="text-gray-400"> · {c.repoFull}</span>}
                </div>
                {c.segments.map((s) => (
                  <div key={s.dir} className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-[1px]" style={{ background: s.color }} />
                    {areaLabel(s.dir)}: {fmtNum(s.count)}
                  </div>
                ))}
                <div className="mt-0.5 border-t border-gray-200 pt-0.5 dark:border-gray-700">total: {fmtNum(c.total)}</div>
              </FloatingTip>
            );
          })()}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
        {legend.map((l) => (
          <span key={l.dir} className="flex items-center gap-1 text-[9px] text-gray-500 dark:text-gray-400">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: l.color }} />
            {areaLabel(l.dir)}
          </span>
        ))}
      </div>
    </ChartCard>
  );
}

export function BotBehaviourPanel({ repoId }: { repoId?: number } = {}): JSX.Element {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const workspaceId = useFilters((s) => s.workspaceId);
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const botColor = useBotColors(workspaceId);
  const mlEnabled = useMlSeverityEnabled();
  const { data, isLoading, isError } = useBotBehaviour(workspaceId, window, true, repoScope);
  const bots = data?.bots ?? [];
  const windowLabel = WINDOWS.find((w) => w.key === window)?.label ?? '';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-gray-400">
          How your review bots behave over time — deterministic, no AI. Red rings & underlines mark
          where a bot diverged from its <span className="font-medium">own</span> typical (a
          self-baseline). Times are UTC; activity gaps are inferred (not a direct rate-limit signal).
        </span>
        <div className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
          {WINDOWS.map((wOpt) => (
            <button
              key={wOpt.key}
              type="button"
              onClick={() => setWindow(wOpt.key)}
              className={`px-2 py-0.5 text-[11px] font-medium ${
                window === wOpt.key
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {wOpt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-40 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load bot behaviour analytics.</div>
      ) : bots.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No automated-reviewer activity in this window.
          <div className="mt-1 text-[11px]">
            When review bots (CodeRabbit, Copilot, in-house AI…) review your PRs, their latency and
            cadence land here. A bot that was active earlier may just be quiet — try widening the
            window above.
          </div>
        </div>
      ) : (
        <>
          <ChartCard
            title="Findings density"
            note="threads a bot opens per PR / KLoC · weekly · log scale · lower = cleaner · hover ⭘ for why"
          >
            <DensityTrendChart bots={bots} botColor={botColor} />
          </ChartCard>
          {/* ML severity/category — dark entirely when this deployment has no severity-api (the
              `mlSeverity` capability), which is also when the server ships no `ml` block. */}
          {mlEnabled && data?.ml != null && (
            <MlCharts bots={bots} ml={data.ml} botColor={botColor} windowLabel={windowLabel} />
          )}
          {data?.overlap != null && (
            <BotOverlapSection overlap={data.overlap} color={botColor({ login: null, kind: 'in_house' })} />
          )}
          {data?.repoBotDirs != null && data.repoBotDirs.length > 0 && (
            <BotRepoWorkChart data={data.repoBotDirs} botColor={botColor} />
          )}
          {bots.map((b) => (
            <BotCard
              key={b.key}
              bot={b}
              color={botColor({ login: b.login, kind: b.kind })}
              prsOpenedPerDay={data?.prsOpenedPerDay}
            />
          ))}
        </>
      )}
    </div>
  );
}
