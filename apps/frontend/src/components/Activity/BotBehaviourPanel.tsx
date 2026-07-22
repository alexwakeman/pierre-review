import { useMemo, useState } from 'react';
import type {
  AnalyticsBin,
  BotBehaviourAnomaly,
  BotBehaviourBotStat,
  BotDirectoryUsage,
  BotOverlapStats,
  BotRepoPresence,
  BotWindowKind,
} from '@pierre-review/shared';
import { useBotBehaviour } from '../../hooks/useBotTriage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { automatedReviewerMeta } from '../../lib/ui.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { Heatmap } from '../charts/Heatmap.js';
import { DayStrip } from '../charts/DayStrip.js';
import { ChartCard, ChartEmpty, PALETTE, fmtDuration, type Series } from '../charts/common.js';

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
// Scope + window come from the store (shared with the ROI panel), so it inherits repo/team/window.

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
  const [showTrend, setShowTrend] = useState(false);
  // null = all bots selected (stays correct across window refetches); a Set = an explicit subset.
  const [selected, setSelected] = useState<Set<string> | null>(null);

  // Bots that actually have density history — the selectable set (stable x-axis from all of them).
  const botsWithData = useMemo(
    () =>
      bots.filter((b) =>
        b.trend.some((p) => p.findingsPerKloc != null || p.findingsPerPr != null),
      ),
    [bots],
  );
  const allKeys = useMemo(() => botsWithData.map((b) => b.key), [botsWithData]);
  const isOn = (key: string): boolean => selected == null || selected.has(key);
  const toggleBot = (key: string): void =>
    setSelected((prev) => {
      const base = prev == null ? new Set(allKeys) : new Set(prev);
      if (base.has(key)) base.delete(key);
      else base.add(key);
      return base.size === allKeys.length ? null : base; // full set → back to "all"
    });

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
          color: PALETTE.slate,
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
                ? 'border-slate-400 bg-slate-500/10 text-slate-700 dark:text-slate-200'
                : 'border-gray-300 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            <span
              className="inline-block h-0 w-3 border-t-2 border-dashed"
              style={{ borderColor: PALETTE.slate }}
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

      {/* Interactive legend / bot selector — click to show/hide a bot's line. */}
      {botsWithData.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {botsWithData.map((b) => {
            const on = isOn(b.key);
            const color = botColor({ login: b.login, kind: b.kind });
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => toggleBot(b.key)}
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
          {selected != null && (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-[10px] text-sky-600 hover:underline dark:text-sky-400"
            >
              all
            </button>
          )}
        </div>
      )}

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
          centerTip
          hideLegend
          formatY={densAxis}
        />
      )}
    </div>
  );
}

// Per-bot detail: headline stats + TTFR distribution + the week×hour activity heatmap + the
// follow-up distribution. One card per bot, brand-coloured.
function BotCard({
  bot,
  color,
  prsOpenedPerDay,
  dir,
}: {
  bot: BotBehaviourBotStat;
  color: string;
  // Shared across bots: human-authored, non-draft PRs opened per day over the same span.
  prsOpenedPerDay?: number[];
  // This bot's per-directory review-thread breakdown (which sections it operates in).
  dir?: BotDirectoryUsage;
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

      {/* Which sections of the codebase this bot's inline review threads land in. */}
      {dir != null && dir.dirs.length > 0 && (
        <ChartCard
          title="Top directories"
          note={`inline threads by top-level dir · ${dir.totalThreads} total`}
        >
          <BarChart
            labels={dir.dirs.map((d) => (d.dir === '.' ? '(root)' : d.dir))}
            series={[{ key: 'threads', label: 'Threads', color, values: dir.dirs.map((d) => d.count) }]}
            height={130}
            rotateLabels
          />
        </ChartCard>
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

// ── Global "which bots operate on each repo" (EXPERIMENTAL) — a repo × bot stacked chart, so
// repos worked by MULTIPLE bots show multiple stacked segments. ──────────────────────────────────
function RepoPresenceSection({
  repoPresence,
  botColor,
}: {
  repoPresence: BotRepoPresence[];
  botColor: BotColorFn;
}): JSX.Element | null {
  if (repoPresence.length === 0) return null;
  // Distinct bots across all repos, ordered by total footprint → one stacked series each.
  const botTotals = new Map<string, { label: string; login: string | null; kind: BotBehaviourBotStat['kind']; total: number }>();
  for (const r of repoPresence)
    for (const b of r.bots) {
      const e = botTotals.get(b.key) ?? { label: b.label, login: b.login, kind: b.kind, total: 0 };
      e.total += b.threads;
      botTotals.set(b.key, e);
    }
  const botsOrdered = [...botTotals.entries()].sort((a, b) => b[1].total - a[1].total);
  const repos = repoPresence.slice(0, 14);
  const labels = repos.map((r) => r.repoName.split('/').pop() ?? r.repoName);
  const series: Series[] = botsOrdered.map(([key, meta]) => ({
    key,
    label: meta.label,
    color: botColor({ login: meta.login, kind: meta.kind }),
    values: repos.map((r) => r.bots.find((b) => b.key === key)?.threads ?? 0),
  }));
  const multiRepos = repoPresence.filter((r) => r.totalBots >= 2).length;
  return (
    <ChartCard
      title="Where bots operate"
      note={
        (multiRepos > 0
          ? `${multiRepos} repo${multiRepos === 1 ? '' : 's'} reviewed by ≥2 bots · `
          : '') + 'inline review threads per repo, by bot'
      }
    >
      <BarChart labels={labels} series={series} mode="stacked" rotateLabels height={200} />
    </ChartCard>
  );
}

export function BotBehaviourPanel({ repoId }: { repoId?: number } = {}): JSX.Element {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const botColor = useBotColors();
  const { data, isLoading, isError } = useBotBehaviour(window, true, scope, repoScope);
  const bots = data?.bots ?? [];
  const dirByKey = useMemo(
    () => new Map((data?.directories ?? []).map((d) => [d.key, d])),
    [data?.directories],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
          Experimental
        </span>
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
          {data?.overlap != null && (
            <BotOverlapSection overlap={data.overlap} color={botColor({ login: null, kind: 'in_house' })} />
          )}
          {data?.repoPresence != null && data.repoPresence.length > 0 && (
            <RepoPresenceSection repoPresence={data.repoPresence} botColor={botColor} />
          )}
          {bots.map((b) => (
            <BotCard
              key={b.key}
              bot={b}
              color={botColor({ login: b.login, kind: b.kind })}
              prsOpenedPerDay={data?.prsOpenedPerDay}
              dir={dirByKey.get(b.key)}
            />
          ))}
        </>
      )}
    </div>
  );
}
