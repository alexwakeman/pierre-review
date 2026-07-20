import { useMemo } from 'react';
import type {
  AnalyticsBin,
  BotBehaviourBotStat,
  BotBehaviourTrendPoint,
  BotWindowKind,
} from '@pierre-review/shared';
import { useBotBehaviour } from '../../hooks/useBotTriage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { automatedReviewerMeta } from '../../lib/ui.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { Heatmap } from '../charts/Heatmap.js';
import { ChartCard, ChartEmpty, fmtDuration, type Series } from '../charts/common.js';

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
// Per-week median-TTFR extractor — module-level so its identity is stable across renders.
const ttfrVal = (p: BotBehaviourTrendPoint): number | null => p.medianTtfrHours;

function dur(h: number | null): string {
  return h == null ? '—' : fmtDuration(h);
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

// The cross-bot median-TTFR trend (one line per bot over the shared ≤12-week weeks) — the
// headline "who gets to PRs fastest, and is it drifting" comparison. Mirrors BotRoiPanel's
// VendorTrendChart: union of weekStarts → last 12, a missing week reads as a null gap.
function TtfrTrendChart({
  bots,
  botColor,
}: {
  bots: BotBehaviourBotStat[];
  botColor: (b: { login?: string | null; kind: BotBehaviourBotStat['kind'] }) => string;
}): JSX.Element {
  const { labels, series } = useMemo(() => {
    const weekSet = new Set<string>();
    for (const b of bots) for (const p of b.ttfrTrend) weekSet.add(p.weekStart);
    const labels = Array.from(weekSet).sort().slice(-12);
    const series: Series[] = bots
      .filter((b) => b.ttfrTrend.some((p) => p.medianTtfrHours != null))
      .map((b) => {
        const byWeek = new Map(b.ttfrTrend.map((p) => [p.weekStart, ttfrVal(p)]));
        return {
          key: b.key,
          label: b.label,
          color: botColor({ login: b.login, kind: b.kind }),
          values: labels.map((w) => byWeek.get(w) ?? null),
        };
      });
    return { labels, series };
  }, [bots, botColor]);
  if (labels.length < 2 || series.length === 0)
    return <ChartEmpty label="Not enough weekly history yet" />;
  return <LineChart labels={labels} series={series} height={150} curved formatY={durAxis} />;
}

// Per-bot detail: headline stats + TTFR distribution + the week×hour activity heatmap + the
// follow-up distribution. One card per bot, brand-coloured.
function BotCard({
  bot,
  color,
}: {
  bot: BotBehaviourBotStat;
  color: string;
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

export function BotBehaviourPanel({ repoId }: { repoId?: number } = {}): JSX.Element {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const botColor = useBotColors();
  const { data, isLoading, isError } = useBotBehaviour(window, true, scope, repoScope);
  const bots = data?.bots ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
          Experimental
        </span>
        <span className="text-[11px] text-gray-400">
          How your review bots behave over time — deterministic, no AI. Times are UTC; activity
          gaps are inferred (not a direct rate-limit signal).
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
          <ChartCard title="Median time to first review" note="per bot · weekly · last 12">
            <TtfrTrendChart bots={bots} botColor={botColor} />
          </ChartCard>
          {bots.map((b) => (
            <BotCard key={b.key} bot={b} color={botColor({ login: b.login, kind: b.kind })} />
          ))}
        </>
      )}
    </div>
  );
}
