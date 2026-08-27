import { useMemo } from 'react';
import type { BotBehaviourAnomaly, BotBehaviourBotStat, BotBehaviourMlBot } from '@pierre-review/shared';
import { usePinnedTabs, parseBotDetailKey } from '../../store/pinnedTabs.js';
import { useBotBehaviour } from '../../hooks/useBotTriage.js';
import { useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { ML_CATEGORY_COLOR, ML_CATEGORY_LABEL, automatedReviewerMeta } from '../../lib/ui.js';
import { BotIcon } from '../Icons.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { Heatmap } from '../charts/Heatmap.js';
import { DayStrip } from '../charts/DayStrip.js';
import { ChartCard, ChartEmpty, fmtDuration, fmtNum, type Series } from '../charts/common.js';
import {
  DistChart,
  MlSeverityTrendChart,
  Stat,
  WINDOWS,
  useBotSubset,
  type MlBotView,
} from './WorkspaceBotCharts.js';

// ONE review bot's depth — the per-bot drill-down TAB that replaced the Bots "Behaviour" inner
// tab (plan P1.1/C1, decision D6): the old BotCard stack (4 headline stats, the 3 weekly
// TrendMinis, the daily-coverage DayStrip, the 3 distribution/heatmap charts) plus that bot's
// severity-over-time slice and its category mix, both sliced from the SAME per-bot data shapes
// the workspace charts read — nothing here recomputes.
//
// The tab's own key carries the bot's users.id (no seed to consume — the user-activity pattern),
// and the fetch is narrowed to that ONE bot via the behaviour route's `botUserId` parameter:
// opening one bot must not fetch fifteen bots' heatmaps. Scope: the ACTIVE WORKSPACE decides the
// judgement; the repo narrowing the ROI row was measured at rides the tab's botMeta; the window
// is the shared `botAnalyticsWindow` store field (the drill-down rule — a local window would let
// this tab and the table it was opened from disagree about one bot).
//
// Pro depth (`botDepth`) — the pill that opens this tab only renders under the capability, and
// the hook self-gates, so without it this panel renders a quiet absence line, never an error.

// A duration axis formatter (BarChart/LineChart never pass null).
const durAxis = (n: number): string => fmtDuration(n);
const countAxis = (n: number): string => String(Math.round(n));
const pctAxis = (n: number): string => `${Math.round(n)}%`;

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
  // `note` is a plain STRING prop on ChartCard, so this stays worded rather than iconised.
  const dir = latest.direction === 'high' ? 'higher' : 'lower';
  return `${hits.length} exception${hits.length === 1 ? '' : 's'} · latest ${dir}: ${obs} vs ${typ} typical`;
}

// The coverage-gap note for the daily strip (silence runs).
function silenceNote(bot: BotBehaviourBotStat): string | undefined {
  if (bot.silentRuns.length === 0) return undefined;
  const longest = Math.max(...bot.silentRuns.map((r) => r.days));
  return `${bot.silentRuns.length} gap${bot.silentRuns.length === 1 ? '' : 's'} · longest ${longest}d silent`;
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

// This bot's category mix — its own `byCategory` counts (a per-bot slice of the same data shape
// the workspace "Categories per vendor" chart stacks), drawn as plain COUNT bars: one bot means
// one denominator, so counts are the honest reading and there is no cross-bot share to normalise.
function CategoryMixChart({ ml }: { ml: BotBehaviourMlBot }): JSX.Element {
  const series: Series[] = useMemo(
    () => [
      {
        key: 'count',
        label: 'Mentions',
        color: ML_CATEGORY_COLOR[ml.byCategory[0]?.category ?? 'nitpick'],
        values: ml.byCategory.map((c) => c.count),
        colors: ml.byCategory.map((c) => ML_CATEGORY_COLOR[c.category]),
      },
    ],
    [ml.byCategory],
  );
  if (ml.byCategory.length === 0)
    return <ChartEmpty label="No categorised bot comments in this window" />;
  return (
    <BarChart
      labels={ml.byCategory.map((c) => ML_CATEGORY_LABEL[c.category])}
      series={series}
      height={150}
      rotateLabels
    />
  );
}

export function BotDetailPanel(): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  // The tab's own key carries the bot's users.id — re-opening the same bot's tab (or landing on
  // a stale key) can never show another bot's depth.
  const userId = parseBotDetailKey(activeTab);
  const tab = tabs.find((t) => t.key === activeTab) ?? null;
  const botMeta = tab?.botMeta ?? null;

  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const workspaceId = useFilters((s) => s.workspaceId);
  const { botDepth } = useProCapabilities();
  const botColor = useBotColors(workspaceId);
  const mlEnabled = useMlSeverityEnabled();
  // The repo narrowing the ROI row was measured at (per-repo Bots console), captured at open
  // time — the depth describes the same scope as the table the pill was clicked in.
  const repoScope = useMemo(
    () => (botMeta?.repoId != null ? [botMeta.repoId] : null),
    [botMeta?.repoId],
  );
  // ONE request, narrowed to this bot server-side (`botUserId`) — its own `bot:<id>` cache slot.
  const { data, isLoading, isError } = useBotBehaviour(
    workspaceId,
    window,
    userId != null,
    repoScope,
    userId,
  );
  const bot = useMemo(
    () => (userId != null ? (data?.bots ?? []).find((b) => b.userId === userId) ?? null : null),
    [data?.bots, userId],
  );
  // The ML slice for this one bot, in the workspace charts' `MlBotView` shape so the shared
  // severity-over-time chart renders it unchanged (a single-element views array).
  const mlViews = useMemo<MlBotView[]>(() => {
    if (bot == null || data?.ml == null) return [];
    const m = data.ml.perBot.find((x) => x.key === bot.key);
    return m
      ? [{ key: bot.key, userId: bot.userId, label: bot.label, login: bot.login, kind: bot.kind, ml: m }]
      : [];
  }, [bot, data?.ml]);
  const mlKeys = useMemo(() => mlViews.map((v) => v.key), [mlViews]);
  // Hooks-order rule: every hook above runs before ANY early return below.
  const subset = useBotSubset(mlKeys);

  const label = bot?.label ?? botMeta?.label ?? (botMeta?.login ?? `bot ${userId ?? '?'}`);
  const windowLabel = WINDOWS.find((w) => w.key === window)?.label ?? '';

  let body: JSX.Element;
  if (userId == null) {
    body = <div className="text-sm text-gray-500 dark:text-gray-400">No bot selected.</div>;
  } else if (!botDepth) {
    // Free-tier posture: the pill that opens this tab only renders under `botDepth`, so this is
    // a stale tab after a capability change — absence, never an error or a dead fetch loop.
    body = (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        Per-bot depth isn’t available on this plan.
      </div>
    );
  } else if (isLoading) {
    body = (
      <div className="h-40 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
    );
  } else if (isError) {
    body = <div className="text-sm text-red-500">Couldn’t load bot behaviour analytics.</div>;
  } else if (bot == null) {
    body = (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        No activity for this bot in this window.
        <div className="mt-1 text-[11px]">
          A bot that was active earlier may just be quiet — try widening the window above.
        </div>
      </div>
    );
  } else {
    const color = botColor({ login: bot.login, kind: bot.kind });
    const mlBot = mlViews[0]?.ml ?? null;
    body = (
      <div className="space-y-3">
        <BotCard bot={bot} color={color} prsOpenedPerDay={data?.prsOpenedPerDay} />
        {/* This bot's ML slice — dark entirely when the deployment has no severity-api, or when
            this bot has no non-summary label in the span (the server ships no perBot entry). */}
        {mlEnabled && mlBot != null && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <ChartCard
              title="Severity over time"
              note="weekly mean severity · findings only · hover for the week’s counts"
            >
              <MlSeverityTrendChart views={mlViews} subset={subset} botColor={botColor} />
            </ChartCard>
            <ChartCard title="Category mix" note={`what this bot talks about · ${windowLabel}`}>
              <CategoryMixChart ml={mlBot} />
              <div className="mt-1 text-[10px] text-gray-400">
                Multi-label: one comment can count under several categories, so the category total
                ({fmtNum(mlBot.byCategory.reduce((n, c) => n + c.count, 0))}) exceeds the finding
                count ({fmtNum(mlBot.findings)}) — bars are mentions, not findings. Walkthrough
                summaries are excluded (their categories are a read of the template, not of a
                finding); acknowledgments appear as “Praise”.
              </div>
            </ChartCard>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[100rem] space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-base font-semibold text-gray-800 dark:text-gray-100">
          <BotIcon size={15} />
          {label}
          <span className="font-normal text-gray-400"> · depth</span>
        </h2>
        <span className="text-[11px] text-gray-400">
          Deterministic, no AI. Red rings & underlines mark where this bot diverged from its{' '}
          <span className="font-medium">own</span> typical (a self-baseline). Times are UTC;
          activity gaps are inferred (not a direct rate-limit signal).
          {botMeta?.repoId != null && ' Measured on the repo the pill was opened from.'}
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
      {body}
    </div>
  );
}
