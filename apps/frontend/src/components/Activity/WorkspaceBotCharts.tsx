import { useMemo, useState } from 'react';
import type {
  AnalyticsBin,
  BotBehaviourBotStat,
  BotBehaviourMlBot,
  BotOverlapStats,
  BotRepoDirBreakdown,
  BotWindowKind,
} from '@pierre-review/shared';
import { useBotBehaviour } from '../../hooks/useBotTriage.js';
import { useBotVolumeScatter } from '../../hooks/useBotVolume.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import {
  meanSeverityValues,
  mlWeekLabels,
  severityBreakdownNote,
} from '../../lib/botMlSeries.js';
import {
  bucketPrCount,
  formatBucketAvg,
  formatBucketDensity,
  sizeBucketSeries,
  unsizedNote,
} from '../../lib/botVolumeSize.js';
import { ChevronIcon, WarningIcon } from '../Icons.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import {
  ChartCard,
  ChartEmpty,
  FloatingTip,
  PALETTE,
  SERIES_COLORS,
  fmtNum,
  niceMax,
  useChartWidth,
  type Series,
} from '../charts/common.js';

// The WORKSPACE-grain bot charts — the surviving cross-bot charts of the retired Bots
// "Behaviour" inner tab (plan P1.1/C1, trimmed again by P1.2/C2): findings density,
// PR-size-vs-volume, cross-bot overlap and "where bots work" — and NOTHING ELSE at workspace
// grain. Rendered as a COLLAPSED-BY-DEFAULT "Workspace charts" section at the bottom of the ROI
// (Measure) branch of BotsView, gated on the `botDepth` capability (absent — not upsold —
// without it). Per-BOT depth (the old BotCard stack + that bot's severity/category slices) lives
// in the per-bot drill-down tab instead (BotDetailPanel, opened from the ROI table's "Depth →"
// pill); the old workspace ML block's inflation charts became the ROI table's Inflation column —
// where the HISTORY has since regrown a readable card of its own (`InflationHistoryChart`, in
// BotRoiPanel's chart row, off `/api/bot-analytics`). It is NOT here, and cannot be: this
// section's `/api/pro/bot-behaviour` wire carries no weekly inflation at all.
//
// FETCH DISCIPLINE: nothing here fetches while the section is collapsed — `useBotBehaviour`
// rides the section's open state, so the default Bots view issues no behaviour request at all.
// Scope + window come from the store exactly as the old panel's did: the ACTIVE WORKSPACE
// decides which logins count as automated reviewers, the optional `repoId` narrows the measured
// data to one repo, and the window is the same one the ROI panel's picker sets.

export type BotColorFn = (bot: {
  login?: string | null;
  kind: BotBehaviourBotStat['kind'];
}) => string;

// The window labels, shared with the per-bot depth tab (the ROI panel keeps its own copy —
// unchanged from the two-panel days).
export const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

// Density values are small decimals (threads per PR / per KLoC): 1 dp under 10, whole above.
const densAxis = (n: number): string => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

// A compact headline stat (label + value + optional sub-line). Shared with BotDetailPanel.
export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-base font-semibold text-gray-800 dark:text-gray-100">{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

// One categorical distribution (TTFR buckets / follow-up counts) → a single-series bar chart.
// Shared with BotDetailPanel.
export function DistChart({ bins, color }: { bins: AnalyticsBin[]; color: string }): JSX.Element {
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
export interface BotSubset {
  selected: Set<string> | null;
  isOn: (key: string) => boolean;
  toggle: (key: string) => void;
  reset: () => void;
}
// Memoised on (selection, key set) so a consumer can put the whole object in a useMemo dep list
// — a fresh object every render would silently rebuild every series on every parent render.
export function useBotSubset(allKeys: string[]): BotSubset {
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

// ── ML severity shapes shared with the per-bot depth tab ───────────────────────────────────────
// The workspace-grain ML block that used to live here (both severity mixes, the two inflation
// charts, "Severity over time", "Categories per vendor", "Category activity over time") was CUT
// by plan P1.2/C2: the inflation counts became the ROI table's Inflation column (its sparkline is
// the `botDepth` history — and, since, an enlarged twin of that sparkline in the same panel's
// chart row), and the per-bot severity-over-time slice + category mix live on the per-bot depth
// tab (BotDetailPanel). What survives here is exactly what that tab still imports:
// `MlBotView` (the per-bot join shape), `MlSeverityTrendChart` (rendered there over a
// single-element views array) and `useBotSubset`/`BotSubsetLegend` behind it.

// One bot's ML fold joined to its identity from the `bots` rows (the `key` is the join).
export interface MlBotView {
  key: string;
  // `users.id`, taken from the joined `bots` row — the number the flagging drill-down's per-bot
  // narrowing takes. Carried rather than parsed back out of `key`'s `u<id>` shape: a second
  // spelling of that format is how a bar and the list behind it come to name different bots.
  userId: number;
  label: string;
  login: string | null;
  kind: BotBehaviourBotStat['kind'];
  ml: BotBehaviourMlBot;
}

// nit(1) … critical(4) — the fixed ordinal axis the "severity over time" line is drawn on. A
// fractional value is a weekly MEAN, so it gets a number rather than a class name it isn't.
const SEV_ORD_LABEL: Record<number, string> = { 1: 'Nit', 2: 'Minor', 3: 'Major', 4: 'Critical' };
const sevOrdAxis = (n: number): string => SEV_ORD_LABEL[n] ?? n.toFixed(1);

// Weekly MEAN severity, one line per bot: "is this bot's bar rising or falling?".
// The mean is plotted on the 1–4 ordinal with the class names as the axis (an explicit yDomain;
// the default scale would tick at 0 and 5, two values a severity cannot take), and the week's
// actual counts ride along in the hover note so a mean drawn from three findings can be told
// apart from one drawn from ninety. Shared with BotDetailPanel (a single-element `views` slices
// one bot's series out of the same data shape).
export function MlSeverityTrendChart({
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
                <line x1={PAD_L} y1={y(v)} x2={w - PAD_R} y2={y(v)} className="decorative-mark text-gray-200 dark:text-gray-700" stroke="currentColor" strokeWidth={1} />
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

// ── PR SIZE vs BOT COMMENT VOLUME (CORE, free, deterministic) ─────────────────────────────────
//
// "Do the bots talk more on a big PR, and how much more?" — the five LOC-bucket means from
// `/api/bot-analytics/volume/scatter`, drawn as the pair of readings that together tell the truth:
// absolute volume per merged PR (which RISES with size) beside volume per 100 lines (which FALLS,
// hard). Either one alone is a half-story — the first invites "bots scale with the diff", the
// second invites "bots ignore big PRs" — and both are wrong.
//
// ⚠ THIS CARD IS **NOT** ML-GATED. Every number here is counted from stored comment rows; no
// severity-api, no model, no `mlSeverity` capability. On a deployment with the whole ML surface
// dark (which includes every `npx pierre-review` install — it ships no model) this card still
// renders, and putting it behind that flag would have hidden a free CORE feature from most
// installs.
//
// ⚠ FORM: BUCKET BARS, NOT A SCATTER. The response carries one point per sized merged PR and this
// card deliberately does not draw them. LOC spans four orders of magnitude with the mass piled at
// the bottom (measured live: one workspace here has 268 of 283 sized merged PRs under 50 lines), so
// a cloud of those points reads as a blob whose apparent shape is set by OVERPLOTTING rather than
// by the relationship — and the claim being made is about central tendency by size, which is
// exactly what the server already folded. Bars over the existing `BarChart` also keep the per-bucket
// PR counts sayable, which a scatter has nowhere to put.
//
// ⚠ READ-ONLY ON PURPOSE. A bucket does NOT open the volume drill-down: `BotVolumeRefine` narrows
// by `authorUserIds` and by nothing else, so there is no size-bucket refinement for the server to
// honour. A client-side "PRs in this bucket" filter would be a list the server's own `total` and
// `filteredTotal` then contradict — the exact failure the volume surfaces were specced against. So
// `BarChart` is given NO `onSelectBar`, which leaves it byte-identical to every other consumer:
// no pointer cursor, no hit targets, nothing added to the tab order.
function BotVolumeSizeChart({
  workspaceId,
  window: windowKind,
  repoScope,
  windowLabel,
}: {
  workspaceId: number | null;
  window: BotWindowKind;
  repoScope: number[] | null;
  windowLabel: string;
}): JSX.Element | null {
  // ⚠ `isPlaceholderData` COUNTS AS LOADING. `useBotVolumeScatter` carries its previous response
  // across a key change (`placeholderData: prev => prev`), so on a window or repo-scope switch
  // `isLoading` is FALSE while `data` still describes the OLD scope — and this card's own note
  // names the window ("merged PRs only · 30d"), so the stale bars would be captioned with the new
  // window. The panel around it has already repainted by then (`useBotBehaviour` has no
  // placeholder), which is exactly what makes the mismatch invisible.
  const { data, isLoading, isPlaceholderData, isError } = useBotVolumeScatter(
    workspaceId,
    windowKind,
    true,
    repoScope,
  );
  const pending = isLoading || isPlaceholderData;
  const model = useMemo(() => sizeBucketSeries(data?.buckets ?? []), [data?.buckets]);

  const avgSeries: Series[] = useMemo(
    () => [
      {
        key: 'avg',
        label: 'Bot comments per merged PR',
        color: PALETTE.blue,
        values: model.rows.map((r) => r.avg),
      },
    ],
    [model.rows],
  );
  const densitySeries: Series[] = useMemo(
    () => [
      {
        key: 'density',
        label: 'Bot comments per 100 lines',
        color: PALETTE.purple,
        values: model.rows.map((r) => r.density),
      },
    ],
    [model.rows],
  );

  // A failed fetch renders NOTHING rather than an error card: this is one supporting reading on a
  // tab whose other charts are already up, and a red box for a chart nobody asked to reload is
  // noise. The panel's own error state covers the case where the whole tab failed.
  if (isError) return null;
  // NOT `pending && !data` — a stale placeholder from the previous window satisfies `data` and
  // would draw the wrong scope's bars under this window's caption. See the ⚠ at the query above.
  if (pending) {
    return (
      <div className="h-40 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
    );
  }
  // No merged PR in scope had an observed size — there is no x-axis to draw and nothing honest to
  // say, so the card stays away entirely rather than showing five empty bands.
  if (model.rows.length === 0) return null;

  const labels = model.rows.map((r) => r.label);
  const unsized = unsizedNote(data?.sizedPrs ?? 0, data?.unsizedPrs ?? 0);
  // ⚠ THE SCAN CAP IS A CLAIM-WEAKENING FACT, NOT A PERFORMANCE DETAIL, so it belongs in the
  // note rather than in a tooltip. When it bites, these five bucket means describe the most
  // recent slice of the window instead of the window — and this card's whole job is to be the
  // baseline a PR's "× expected" is read against. A sampled baseline drawn as an authoritative
  // curve is exactly what got the post-merge autopsy deleted; say so on screen instead.
  const scanNote = data?.scanTruncated ? ' · newest PRs only (scan capped)' : '';

  return (
    <ChartCard
      title="PR size vs bot comment volume"
      note={`merged PRs only · ${windowLabel} · by lines changed (added + deleted)${scanNote}`}
    >
      {!model.hasComments ? (
        <ChartEmpty label="No bot comments on the PRs that merged in this window" />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div>
            <div className="mb-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
              Per merged PR <span className="font-normal text-gray-400">— rises with size</span>
            </div>
            <BarChart
              labels={labels}
              series={avgSeries}
              height={140}
              formatY={densAxis}
              formatValue={formatBucketAvg}
            />
          </div>
          <div>
            <div className="mb-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
              Per 100 lines{' '}
              <span className="font-normal text-gray-400">— falls, usually by a lot</span>
            </div>
            <BarChart
              labels={labels}
              series={densitySeries}
              height={140}
              formatY={densAxis}
              formatValue={formatBucketDensity}
            />
          </div>
        </div>
      )}

      {/* The support behind each bar. A mean over 3 PRs and a mean over 268 draw at identical
          visual weight, so the counts have to be on screen next to them, not in a tooltip. */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-gray-500 dark:text-gray-400">
        <span className="text-gray-400">Merged PRs behind each bar:</span>
        {model.rows.map((r) => (
          // The interpunct is not decoration: without it "<50 268 PRs 50–200 12 PRs" runs two
          // separate readings together, and the bucket edges are themselves numbers.
          <span key={r.label}>
            {r.label} · <span className="font-medium">{bucketPrCount(r.prs)}</span>
          </span>
        ))}
      </div>

      {/* A band that is absent from the axis because nothing of that size merged — named, so it
          cannot be read as "PRs this big are not measured here". Distinct from a band that IS on
          the axis with no bar, which is the real finding "PRs this size merged and drew nothing". */}
      {model.emptyLabels.length > 0 && (
        <div className="mt-1 text-[10px] text-gray-400">
          No merged PR of this size in this window: {model.emptyLabels.join(', ')} — those bands are
          left off the axis rather than drawn as a zero.
        </div>
      )}
      {unsized && <div className="mt-1 text-[10px] text-gray-400">{unsized}</div>}

      <div className="mt-1 text-[10px] text-gray-400">
        <span className="font-medium text-amber-600 dark:text-amber-400">
          <WarningIcon size={10} className="mr-0.5 inline-block align-[-0.1em]" />A correlation, not
          a rule — and it is repo-dependent.
        </span>{' '}
        Across the five repos we measured this on, log-LOC against bot-comment count ran 0.62 and
        0.54 on two heavily-configured repos, then 0.15, 0.13 and 0.03 on three others: where a bot
        is lightly configured it says roughly the same amount whatever the diff size, and size
        predicts nothing at all. Read this as the shape of <em>this</em> scope in{' '}
        <em>this</em> window — several repos and every bot in the workspace are pooled here, so a
        workspace whose repos are configured differently blends them into one curve. Counts every
        review comment, PR comment and review body an automated reviewer wrote (a wider definition
        than the ROI table&rsquo;s “Comments”), on PRs that <em>merged</em> in the window.
      </div>
    </ChartCard>
  );
}

// The collapsed-by-default "Workspace charts" section — the bottom of the ROI (Measure) branch
// of BotsView. Gated on `botDepth`: without the capability it renders NOTHING (absent, not
// upsold — the P0.2/P0.3 posture). Nothing is fetched until the section is opened.
export function WorkspaceBotCharts({ repoId }: { repoId?: number } = {}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const window = useFilters((s) => s.botAnalyticsWindow);
  const workspaceId = useFilters((s) => s.workspaceId);
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const botColor = useBotColors(workspaceId);
  const { botDepth } = useProCapabilities();
  // Fetch ONLY while the section is open — the default (collapsed) Bots view must not issue the
  // whole-workspace behaviour request. `useBotBehaviour` additionally self-gates on botDepth.
  const { data, isLoading, isError } = useBotBehaviour(workspaceId, window, open, repoScope);
  const bots = data?.bots ?? [];
  const windowLabel = WINDOWS.find((w) => w.key === window)?.label ?? '';

  if (!botDepth) return null;

  return (
    <div className="space-y-3" data-testid="workspace-bot-charts">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} size={11} />
        Workspace charts — cross-bot trends, overlap and coverage
      </button>
      {open && (
        <>
          <div className="text-[11px] text-gray-400">
            How your review bots behave over time — deterministic, no AI. Red rings & underlines
            mark where a bot diverged from its <span className="font-medium">own</span> typical (a
            self-baseline). Times are UTC; activity gaps are inferred (not a direct rate-limit
            signal). Per-bot depth lives on each bot&rsquo;s own tab — the “Depth →” pill on the
            ROI table. Window: the ROI picker&rsquo;s ({windowLabel}).
          </div>
          {isLoading ? (
            <div className="h-40 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
          ) : isError ? (
            <div className="text-sm text-red-500">Couldn’t load bot behaviour analytics.</div>
          ) : bots.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              No automated-reviewer activity in this window.
              <div className="mt-1 text-[11px]">
                When review bots (CodeRabbit, Copilot, in-house AI…) review your PRs, their latency
                and cadence land here. A bot that was active earlier may just be quiet — try
                widening the window above.
              </div>
            </div>
          ) : (
            <>
              <ChartCard
                title="Findings density"
                note="threads a bot opens per PR / KLoC · weekly · log scale · lower = cleaner · hover a ring for why"
              >
                <DensityTrendChart bots={bots} botColor={botColor} />
              </ChartCard>
              {/* PR size vs volume. Sits HERE — beside the density trend — because it answers the
                  same "how noisy is this" question the card above does, only cut by diff size
                  instead of by week. No ML gate: it needs no severity-api, so it must render on a
                  deployment where every ML chart is dark. */}
              <BotVolumeSizeChart
                workspaceId={workspaceId}
                window={window}
                repoScope={repoScope}
                windowLabel={windowLabel}
              />
              {/* The workspace ML block that used to sit here was CUT by plan P1.2/C2: the
                  inflation counts live on the ROI table's Inflation column (its drill-down is
                  still the flagging tab's receipt, SeverityAgreementMatrix included), and the
                  per-bot severity/category slices live on the per-bot depth tab. ⚠ THE HISTORY
                  CAME BACK, BUT NOT HERE — `InflationHistoryChart` sits in BotRoiPanel's chart
                  row, on the response that actually carries weekly inflation. Do not read this
                  tombstone as "inflation charts were deleted" and cut that one too. */}
              {data?.overlap != null && (
                <BotOverlapSection overlap={data.overlap} color={botColor({ login: null, kind: 'in_house' })} />
              )}
              {data?.repoBotDirs != null && data.repoBotDirs.length > 0 && (
                <BotRepoWorkChart data={data.repoBotDirs} botColor={botColor} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
