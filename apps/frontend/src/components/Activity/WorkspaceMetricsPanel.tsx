import { useState } from 'react';
import type { WorkspaceMetrics, WorkspaceMetricStat, WorkspaceMetricKey } from '@pierre-review/shared';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import {
  ChartCard,
  ChartEmpty,
  PALETTE,
  fmtDuration,
  type Series,
} from '../charts/common.js';

// The active WORKSPACE's DORA-ish flow metrics — the higher-order view that DRIVES the sprint
// report below it. Stat tiles compare this sprint to the prior one and are CLICKABLE (→ a
// per-metric drill-down tab listing the PRs behind the number). The charts reuse the per-repo
// analytics toolkit (LineChart/BarChart) over a 12-week x-axis; the two most operationally-urgent
// trends (CI recovery + failures-by-stage) sit up front, the rest fold into a "More charts"
// expander.
//
// The panel itself is scope-agnostic: it renders whatever WorkspaceMetrics it is handed. Its two
// mounts differ only in what they fetched — the cross-repo Feed header (the whole workspace) and
// the per-repo console (one repo, which overrides `openPrsSubtitle`).

const pctFmt = (n: number): string => `${Math.round(n)}%`;
const countFmt = (n: number): string => String(Math.round(n));
// Review-load values are small decimals (touches per PR): keep 1 dp so 2.5 isn't rounded to 3.
const loadFmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// One KPI tile with a delta arrow vs the prior sprint, coloured by whether the change is
// an improvement (merges/CI up = good; lead time / latency down = good). Clickable when
// `onActivate` is supplied → opens the metric's drill-down.
function Stat({
  label,
  stat,
  format,
  betterWhen,
  sub,
  onActivate,
}: {
  label: string;
  stat: WorkspaceMetricStat;
  format: (n: number) => string;
  betterWhen: 'up' | 'down';
  sub: string;
  onActivate?: () => void;
}): JSX.Element {
  const { value: v, previous: p, lowConfidence } = stat;
  const delta = v != null && p != null ? v - p : null;
  const improved = delta != null && delta !== 0 && (delta > 0) === (betterWhen === 'up');
  // Early in a sprint the elapsed-matched samples are often too thin to trust a delta (a single
  // carryover PR can define a median) — server flags those `lowConfidence`. Drop the ▲/▼ and
  // show a muted "at this point last sprint" reference instead of a misleading trend arrow.
  const showDelta = delta != null && delta !== 0 && !lowConfidence;
  return (
    <TileShell onActivate={onActivate}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-lg font-semibold text-gray-800 dark:text-gray-100">
        {v == null ? '—' : format(v)}
      </div>
      {showDelta ? (
        <div
          className={`text-[11px] ${
            improved ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
          }`}
        >
          {delta > 0 ? '▲' : '▼'} {format(Math.abs(delta))} <span className="text-gray-400">vs last</span>
        </div>
      ) : lowConfidence ? (
        <div
          className="text-[11px] text-gray-400"
          title="Too few data points to read a trend yet (small sample)"
        >
          {p == null ? 'building baseline' : `was ${format(p)}`}
        </div>
      ) : (
        <div className="text-[11px] text-gray-400">{p == null ? sub : 'no change'}</div>
      )}
      <div className="mt-0.5 text-[10px] text-gray-400">{sub}</div>
    </TileShell>
  );
}

// The tile chrome — a plain card, or a clickable button when `onActivate` is set.
function TileShell({
  onActivate,
  children,
}: {
  onActivate?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const base =
    'block w-full rounded-lg border border-gray-200 bg-white p-2 text-left dark:border-gray-800 dark:bg-gray-900/40';
  if (!onActivate) return <div className={base}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onActivate}
      title="Inspect the PRs behind this metric"
      className={`${base} cursor-pointer transition hover:border-gray-300 hover:bg-gray-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:border-gray-600 dark:hover:bg-gray-900/60`}
    >
      {children}
    </button>
  );
}

export function WorkspaceMetricsPanel({
  metrics,
  onOpenMetric,
  openPrsSubtitle = 'across this workspace',
  moreChartsSlot,
}: {
  metrics: WorkspaceMetrics;
  onOpenMetric?: (metric: WorkspaceMetricKey) => void;
  // The Open-PRs tile caption. The cross-repo mount keeps the default ("across this workspace" —
  // the workspace IS the scope now, so "across all repos" would overstate it); the per-repo console
  // passes a repo-scoped label (e.g. "in this repo").
  openPrsSubtitle?: string;
  // When provided, the "More charts" expander renders THIS node instead of the built-in
  // lead-time / merge-CI charts — lets the per-repo console inline the full RepoAnalytics
  // charts grid under the same single button. Absent ⇒ Insights' default expander, unchanged.
  moreChartsSlot?: React.ReactNode;
}): JSX.Element {
  const [showMore, setShowMore] = useState(false);
  const labels = metrics.weekBuckets;
  // The caption reflects the comparison-window MODE: 'sprint' → "day N of M · vs same point last
  // sprint" (elapsed-matched); 'rolling_*' → "rolling N days · vs prior N days" (always a full
  // window). Default rolling_14 when the field is absent (stale cache).
  const cmp = metrics.comparisonMode ?? 'rolling_14';
  const dayN = Math.max(
    1,
    Math.min(metrics.sprintDays, Math.ceil(metrics.elapsedDays ?? metrics.sprintDays)),
  );
  const windowLabel =
    cmp === 'sprint'
      ? `day ${dayN} of ${metrics.sprintDays} · vs same point last sprint`
      : `rolling ${metrics.sprintDays} days · vs prior ${metrics.sprintDays} days`;
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const open = (m: WorkspaceMetricKey): (() => void) | undefined =>
    onOpenMetric ? () => onOpenMetric(m) : undefined;

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

  // Review load per shipped PR, human vs bot — two area lines so "is human keeping pace with the
  // bots" reads directly (band comparison, not a stack). Absent on cached responses predating the
  // field. An approximate signal (touch counts, not weighted by depth) — the note says "per PR".
  const reviewLoad = metrics.reviewLoad;
  const reviewLoadSeries: Series[] = reviewLoad
    ? [
        { key: 'human', label: 'Human', color: PALETTE.blue, values: reviewLoad.human },
        { key: 'bot', label: 'Bot', color: PALETTE.orange, values: reviewLoad.bot },
      ]
    : [];
  const reviewLoadEmpty =
    reviewLoad == null ||
    (reviewLoad.human.every((v) => v == null) && reviewLoad.bot.every((v) => v == null));

  // Self-review depth (Phase 2), folded into the "More charts" expander. All by merge week.
  const crTrend = metrics.changesRequestedTrend;
  const reworkTrend = metrics.reworkTrend;
  const coverage = metrics.reviewCoverage;
  const crSeries: Series[] = crTrend
    ? [{ key: 'cr', label: 'Changes requested', color: PALETTE.orange, values: crTrend }]
    : [];
  const reworkSeries: Series[] = reworkTrend
    ? [{ key: 'rework', label: 'Rework', color: PALETTE.purple, values: reworkTrend }]
    : [];
  const coverageSeries: Series[] = coverage
    ? [
        { key: 'human', label: 'Human-reviewed', color: PALETTE.green, values: coverage.human },
        { key: 'botOnly', label: 'Bot-only', color: PALETTE.orange, values: coverage.botOnly },
        { key: 'unreviewed', label: 'Unreviewed', color: PALETTE.red, values: coverage.unreviewed },
      ]
    : [];
  const nullEvery = (xs?: (number | null)[]): boolean => xs == null || xs.every((v) => v == null);
  const coverageEmpty =
    coverage == null ||
    (coverage.human.every((v) => v === 0) &&
      coverage.botOnly.every((v) => v === 0) &&
      coverage.unreviewed.every((v) => v === 0));

  // Thread resolution latency (human vs bot self-resolve), by resolution week. Empty until
  // post-deploy syncs witness resolves (resolvedAt is set only on an observed unresolved→resolved).
  const resolution = metrics.resolutionLatencyTrend;
  const resolutionSeries: Series[] = resolution
    ? [
        { key: 'human', label: 'Human-resolved', color: PALETTE.blue, values: resolution.human },
        { key: 'bot', label: 'Bot self-resolved', color: PALETTE.orange, values: resolution.bot },
      ]
    : [];
  const resolutionEmpty =
    resolution == null || (nullEvery(resolution.human) && nullEvery(resolution.bot));

  // Review pickup latency (request → first review), by first-review week.
  const pickupTrend = metrics.reviewPickupTrend;
  const pickupSeries: Series[] = pickupTrend
    ? [{ key: 'pickup', label: 'Pickup', color: PALETTE.blue, values: pickupTrend }]
    : [];

  return (
    <div
      className="space-y-3 rounded-lg border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-800 dark:bg-gray-900/20"
      data-testid="flow-metrics"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-300">
          Flow metrics
        </h3>
        <span className="text-[11px] text-gray-400">
          DORA-ish · {windowLabel}
          {onOpenMetric ? ' · tap a tile to drill in' : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <TileShell onActivate={open('open_prs')}>
          <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
            Open PRs
          </div>
          <div className="text-lg font-semibold text-gray-800 dark:text-gray-100">
            {metrics.openPrs}
          </div>
          <div className="text-[11px] text-gray-400">{openPrsSubtitle}</div>
          <div className="mt-0.5 text-[10px] text-gray-400">currently open</div>
        </TileShell>
        <Stat
          label="Merges"
          stat={metrics.merges}
          format={countFmt}
          betterWhen="up"
          sub="deploy frequency"
          onActivate={open('merges')}
        />
        <Stat
          label="Lead time"
          stat={metrics.leadTimeHours}
          format={fmtDuration}
          betterWhen="down"
          sub="open → merge"
          onActivate={open('lead_time')}
        />
        <Stat
          label="Review latency"
          stat={metrics.timeToFirstReviewHours}
          format={fmtDuration}
          betterWhen="down"
          sub="to first review"
          onActivate={open('review_latency')}
        />
        <Stat
          label="Merge CI"
          stat={metrics.mergeCiSuccessPct}
          format={pctFmt}
          betterWhen="up"
          sub="green at merge"
          onActivate={open('merge_ci')}
        />
        <Stat
          label="CI recovery"
          stat={metrics.ciRecoveryHours}
          format={fmtDuration}
          betterWhen="down"
          sub="red → green"
          onActivate={open('ci_recovery')}
        />
        <TileShell onActivate={open('ci_red')}>
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
        </TileShell>
      </div>

      {/* Primary trends — throughput + the two operationally-urgent CI views up front. The
          "12-week trend" label sits HERE, over the charts, rather than up in the tiles' caption
          where it read as part of the comparison-window scope — the tiles compare over the
          window, but these weekly series span 12 weeks (per-chart notes say "weekly"/"window"). */}
      <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        12-week trend
      </h4>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <ChartCard title="Review load per PR" note="human vs bot touches per shipped PR · weekly">
          {reviewLoadEmpty ? (
            <ChartEmpty label="No merged-PR review activity yet" />
          ) : (
            <LineChart labels={labels} series={reviewLoadSeries} area curved formatY={loadFmt} />
          )}
        </ChartCard>
        <ChartCard title="Throughput" note="opened vs merged · weekly">
          {sum(metrics.throughput.opened) + sum(metrics.throughput.merged) === 0 ? (
            <ChartEmpty />
          ) : (
            <LineChart labels={labels} series={throughputSeries} area curved />
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
            <BarChart labels={reasonLabels} series={reasonSeries} rotateLabels />
          )}
        </ChartCard>
      </div>

      {/* Secondary trends — folded away by default to keep the panel focused. */}
      <div>
        <button
          type="button"
          onClick={() => setShowMore((s) => !s)}
          className="text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          {showMore ? '▾' : '▸'} More charts
          {moreChartsSlot == null ? ' — lead time · CI · review depth' : ''}
        </button>
        {showMore &&
          (moreChartsSlot != null ? (
            <div className="mt-2">{moreChartsSlot}</div>
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
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
              <ChartCard
                title="Changes-requested rate"
                note="% merged PRs sent back · weekly · lower = cleaner drafts"
              >
                {nullEvery(crTrend) ? (
                  <ChartEmpty />
                ) : (
                  <LineChart labels={labels} series={crSeries} curved formatY={pctFmt} />
                )}
              </ChartCard>
              <ChartCard
                title="Review coverage"
                note="merged PRs by who reviewed · weekly"
              >
                {coverageEmpty ? (
                  <ChartEmpty label="No merged PRs yet" />
                ) : (
                  <BarChart
                    labels={labels}
                    series={coverageSeries}
                    mode="stacked"
                    formatY={countFmt}
                  />
                )}
              </ChartCard>
              <ChartCard
                title="Rework after review"
                note="median % of commits pushed after first review · weekly"
              >
                {nullEvery(reworkTrend) ? (
                  <ChartEmpty label="No reviewed merges yet" />
                ) : (
                  <LineChart labels={labels} series={reworkSeries} area curved formatY={pctFmt} />
                )}
              </ChartCard>
              <ChartCard
                title="Time to resolve threads"
                note="median open→resolved · human vs bot self-resolve · weekly"
              >
                {resolutionEmpty ? (
                  <ChartEmpty label="No resolutions observed yet — accrues from sync" />
                ) : (
                  <LineChart
                    labels={labels}
                    series={resolutionSeries}
                    curved
                    formatY={fmtDuration}
                  />
                )}
              </ChartCard>
              <ChartCard title="Review pickup time" note="median requested→first review · weekly">
                {nullEvery(pickupTrend) ? (
                  <ChartEmpty label="No review requests recorded yet — accrues from sync" />
                ) : (
                  <LineChart labels={labels} series={pickupSeries} area curved formatY={fmtDuration} />
                )}
              </ChartCard>
            </div>
          ))}
      </div>
    </div>
  );
}
