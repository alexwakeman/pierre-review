import type { TeamMetrics, TeamMetricStat } from '@pierre-review/shared';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import {
  ChartCard,
  ChartEmpty,
  PALETTE,
  fmtDuration,
  type Series,
} from '../charts/common.js';

// The team's DORA-ish flow metrics at the top of Insights — the higher-order view that
// DRIVES the sprint report below it. Stat tiles compare this sprint to the prior one;
// the charts reuse the exact per-repo analytics toolkit (LineChart/BarChart) over a
// 12-week weekly x-axis. Recovery (CI red) is a current-state proxy (no CI history).

const pctFmt = (n: number): string => `${Math.round(n)}%`;
const countFmt = (n: number): string => String(Math.round(n));

// One KPI tile with a delta arrow vs the prior sprint, coloured by whether the change is
// an improvement (merges/CI up = good; lead time / latency down = good).
function Stat({
  label,
  stat,
  format,
  betterWhen,
  sub,
}: {
  label: string;
  stat: TeamMetricStat;
  format: (n: number) => string;
  betterWhen: 'up' | 'down';
  sub: string;
}): JSX.Element {
  const { value: v, previous: p } = stat;
  const delta = v != null && p != null ? v - p : null;
  const improved = delta != null && delta !== 0 && (delta > 0) === (betterWhen === 'up');
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-lg font-semibold text-gray-800 dark:text-gray-100">
        {v == null ? '—' : format(v)}
      </div>
      {delta != null && delta !== 0 ? (
        <div
          className={`text-[11px] ${
            improved ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
          }`}
        >
          {delta > 0 ? '▲' : '▼'} {format(Math.abs(delta))} <span className="text-gray-400">vs last</span>
        </div>
      ) : (
        <div className="text-[11px] text-gray-400">{p == null ? sub : 'no change'}</div>
      )}
      <div className="mt-0.5 text-[10px] text-gray-400">{sub}</div>
    </div>
  );
}

export function TeamMetricsPanel({ metrics }: { metrics: TeamMetrics }): JSX.Element {
  const labels = metrics.weekBuckets;
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

  const throughputSeries: Series[] = [
    { key: 'opened', label: 'Opened', color: PALETTE.blue, values: metrics.throughput.opened },
    { key: 'merged', label: 'Merged', color: PALETTE.green, values: metrics.throughput.merged },
  ];
  const leadSeries: Series[] = [
    { key: 'lead', label: 'Lead time', color: PALETTE.purple, values: metrics.leadTimeTrend },
  ];
  const ciSeries: Series[] = [
    { key: 'ci', label: 'Merge CI success', color: PALETTE.green, values: metrics.ciSuccessTrend },
  ];
  const recoverySeries: Series[] = [
    { key: 'recovery', label: 'CI recovery', color: PALETTE.orange, values: metrics.ciRecoveryTrend },
  ];
  const reasonSeries: Series[] = [
    {
      key: 'failures',
      label: 'Failures',
      color: PALETTE.red,
      values: metrics.ciFailureReasons.map((r) => r.count),
    },
  ];
  const reasonLabels = metrics.ciFailureReasons.map((r) => r.stage);

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-800 dark:bg-gray-900/20">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-300">
          Flow metrics
        </h3>
        <span className="text-[11px] text-gray-400">
          DORA-ish · last 2 weeks vs prior · 12-week trend
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Merges"
          stat={metrics.merges}
          format={countFmt}
          betterWhen="up"
          sub="deploy frequency"
        />
        <Stat
          label="Lead time"
          stat={metrics.leadTimeHours}
          format={fmtDuration}
          betterWhen="down"
          sub="open → merge"
        />
        <Stat
          label="Review latency"
          stat={metrics.timeToFirstReviewHours}
          format={fmtDuration}
          betterWhen="down"
          sub="to first review"
        />
        <Stat
          label="Merge CI"
          stat={metrics.mergeCiSuccessPct}
          format={pctFmt}
          betterWhen="up"
          sub="green at merge"
        />
        <Stat
          label="CI recovery"
          stat={metrics.ciRecoveryHours}
          format={fmtDuration}
          betterWhen="down"
          sub="red → green"
        />
        <div className="rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900/40">
          <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
            CI red now
          </div>
          <div
            className={`text-lg font-semibold ${
              metrics.ciFailingNow > 0
                ? 'text-red-500 dark:text-red-400'
                : 'text-gray-800 dark:text-gray-100'
            }`}
          >
            {metrics.ciFailingNow}
          </div>
          <div className="text-[11px] text-gray-400">
            {metrics.ciFailingNow > 0 && metrics.ciFailingMedianAgeHours != null
              ? `~${fmtDuration(metrics.ciFailingMedianAgeHours)} unresolved`
              : 'all green'}
          </div>
          <div className="mt-0.5 text-[10px] text-gray-400">recovery pressure</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <ChartCard title="Throughput" note="opened vs merged · weekly">
          {sum(metrics.throughput.opened) + sum(metrics.throughput.merged) === 0 ? (
            <ChartEmpty />
          ) : (
            <BarChart labels={labels} series={throughputSeries} mode="grouped" />
          )}
        </ChartCard>
        <ChartCard title="Lead time for changes" note="median open→merge · weekly">
          {metrics.leadTimeTrend.every((v) => v == null) ? (
            <ChartEmpty />
          ) : (
            <LineChart labels={labels} series={leadSeries} area curved formatY={fmtDuration} />
          )}
        </ChartCard>
        <ChartCard title="Merge CI success" note="% green at merge · weekly">
          {metrics.ciSuccessTrend.every((v) => v == null) ? (
            <ChartEmpty />
          ) : (
            <LineChart labels={labels} series={ciSeries} curved formatY={pctFmt} />
          )}
        </ChartCard>
        <ChartCard title="CI recovery time" note="median red→green · weekly">
          {metrics.ciRecoveryTrend.every((v) => v == null) ? (
            <ChartEmpty label="No CI recoveries yet — accrues from sync" />
          ) : (
            <LineChart labels={labels} series={recoverySeries} area curved formatY={fmtDuration} />
          )}
        </ChartCard>
        <ChartCard title="CI failures by stage" note="which checks fail · window">
          {reasonLabels.length === 0 ? (
            <ChartEmpty label="No CI failures recorded yet" />
          ) : (
            <BarChart labels={reasonLabels} series={reasonSeries} />
          )}
        </ChartCard>
      </div>
    </div>
  );
}
