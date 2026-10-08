import { useState } from 'react';
import {
  reportingWindowTitle,
  type WorkspaceMetrics,
  type WorkspaceMetricStat,
  type WorkspaceMetricKey,
} from '@pierre-review/shared';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { CaretIcon, ChevronIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
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
      <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-semibold text-gray-800 dark:text-gray-100">
        {v == null ? '—' : format(v)}
      </div>
      {showDelta ? (
        <div
          className={`text-[11px] ${
            improved ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
          }`}
        >
          <CaretIcon dir={delta > 0 ? 'up' : 'down'} className="inline-block align-[-0.1em]" />{' '}
          {format(Math.abs(delta))} <span className="text-gray-400">vs before</span>
        </div>
      ) : lowConfidence ? (
        // Why there is no arrow is in the "Flow metrics" info modal; a title= alone is out of reach
        // on touch and keyboard.
        <div className="text-[11px] text-gray-400">
          {p == null ? 'nothing to compare yet' : `was ${format(p)}`}
        </div>
      ) : (
        <div className="text-[11px] text-gray-400">{p == null ? 'nothing to compare yet' : 'no change'}</div>
      )}
      <div className="mt-0.5 text-[11px] text-gray-400">{sub}</div>
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
      title="Show the pull requests behind this figure"
      className={`${base} cursor-pointer transition hover:border-gray-300 hover:bg-gray-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:border-gray-600 dark:hover:bg-gray-900/60`}
    >
      {children}
    </button>
  );
}

export function WorkspaceMetricsPanel({
  metrics,
  onOpenMetric,
  onOpenOpenPrs,
  openPrsSubtitle = 'across this workspace',
  moreChartsSlot,
}: {
  metrics: WorkspaceMetrics;
  onOpenMetric?: (metric: WorkspaceMetricKey) => void;
  // The "Open PRs" tile's drill-in. Separate from `onOpenMetric` because open PRs are NOT a
  // metrics-detail sub-tab: the tile reveals the fixed Open PRs tab (/api/open-prs,
  // workspace-wide). Absent ⇒ the tile is non-clickable (the per-repo console mount).
  onOpenOpenPrs?: () => void;
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
  // The group heading over the windowed tiles — the shared spelling ("This sprint so far" / "Last
  // 14 days"), the same words the cards below use for the same window.
  const windowGroupLabel = reportingWindowTitle({ mode: cmp, days: metrics.sprintDays });
  const windowLabel =
    cmp === 'sprint'
      ? `Day ${dayN} of ${metrics.sprintDays} of this sprint, compared with the same point last sprint`
      : `Last ${metrics.sprintDays} days, compared with the ${metrics.sprintDays} days before`;
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const open = (m: WorkspaceMetricKey): (() => void) | undefined =>
    onOpenMetric ? () => onOpenMetric(m) : undefined;

  const throughputSeries: Series[] = [
    { key: 'opened', label: 'Opened', color: PALETTE.blue, values: metrics.throughput.opened },
    { key: 'merged', label: 'Merged', color: PALETTE.green, values: metrics.throughput.merged },
  ];
  const leadSeries: Series[] = [
    { key: 'lead', label: 'Time to merge', color: PALETTE.purple, values: metrics.leadTimeTrend },
  ];
  const ciSeries: Series[] = [
    { key: 'ci', label: 'Green at merge', color: PALETTE.green, values: metrics.ciSuccessTrend },
  ];
  const recoverySeries: Series[] = [
    { key: 'recovery', label: 'Red to green', color: PALETTE.orange, values: metrics.ciRecoveryTrend },
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
        { key: 'human', label: 'People', color: PALETTE.blue, values: reviewLoad.human },
        { key: 'bot', label: 'Bots', color: PALETTE.orange, values: reviewLoad.bot },
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

  // Defined ONCE, rendered in the folded "More charts" section of BOTH branches (default grid
  // and Pro slot). Hidden by default by product decision; when a `moreChartsSlot` is present the
  // slot's grid omits its own per-repo CI-failures twin (Charts omitPrimaries) so the folded
  // section never shows the same concept twice from two data sources.
  const ciFailuresCard = (
    <ChartCard title="Failing checks" note="times each check was seen failing · last 12 weeks">
      {reasonLabels.length === 0 ? (
        <ChartEmpty label="No CI failures recorded yet" />
      ) : (
        <BarChart labels={reasonLabels} series={reasonSeries} rotateLabels />
      )}
    </ChartCard>
  );

  return (
    <div
      className="space-y-3 rounded-lg border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-800 dark:bg-gray-900/20"
      data-testid="flow-metrics"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-300">
            Flow metrics
          </h3>
          <InfoButton title="Flow metrics">
            <p>
              Each tile compares this window with the earlier one named beside the heading. Times
              are medians. Time to
              merge and Checks green at merge cover pull requests merged in the window; Time to
              first review covers pull requests opened in it that have been reviewed.
            </p>
            <p>
              When either window has fewer than 3 pull requests (or, for Time to fix red checks,
              fewer than 3 fixes) behind a figure, the tile shows the earlier value (&ldquo;was
              …&rdquo;) instead of an up or down arrow.
            </p>
            <p>
              The tiles under &ldquo;Right now&rdquo; are not tied to the window: Open pull requests
              and Red checks now count what is open at this moment, drafts not counted. A red
              check&rsquo;s age runs from the pull request&rsquo;s last commit.
            </p>
            <p>
              The charts under &ldquo;Last 12 weeks&rdquo; are weekly trends over 12 weeks, so they
              always cover more than one window.
            </p>
          </InfoButton>
        </div>
        <span className="text-[11px] text-gray-400">
          {windowLabel}
          {onOpenMetric ? ' · click a tile for the pull requests behind it' : ''}
        </span>
      </div>

      {/* ⚠ TWO GROUPS, AND THE SPLIT IS THE RULE MADE VISIBLE. Every Reports figure is tied to the
          workspace's reporting window — the five tiles on the left. "Open pull requests" and "Red
          checks now" are SNAPSHOTS of what is open at this moment, the labelled exception, so they
          sit apart under their own "Right now" heading where nobody reads them as sprint figures. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,2fr)]">
        <div role="group" aria-label={windowGroupLabel}>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {windowGroupLabel}
          </h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Stat
              label="Merged"
              stat={metrics.merges}
              format={countFmt}
              betterWhen="up"
              sub="pull requests"
              onActivate={open('merges')}
            />
            <Stat
              label="Time to merge"
              stat={metrics.leadTimeHours}
              format={fmtDuration}
              betterWhen="down"
              sub="median, opened to merged"
              onActivate={open('lead_time')}
            />
            <Stat
              label="Time to first review"
              stat={metrics.timeToFirstReviewHours}
              format={fmtDuration}
              betterWhen="down"
              sub="median, opened to first review"
              onActivate={open('review_latency')}
            />
            <Stat
              label="Checks green at merge"
              stat={metrics.mergeCiSuccessPct}
              format={pctFmt}
              betterWhen="up"
              sub="share of merged pull requests"
              onActivate={open('merge_ci')}
            />
            <Stat
              label="Time to fix red checks"
              stat={metrics.ciRecoveryHours}
              format={fmtDuration}
              betterWhen="down"
              sub="median, red to green"
              onActivate={open('ci_recovery')}
            />
          </div>
        </div>
        <div
          role="group"
          aria-label="Right now"
          className="border-gray-200 lg:border-l lg:pl-3 dark:border-gray-800"
          data-testid="flow-metrics-right-now"
        >
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Right now
          </h4>
          <div className="grid grid-cols-2 gap-2">
            <TileShell onActivate={onOpenOpenPrs}>
              <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Open pull requests
              </div>
              <div className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                {metrics.openPrs}
              </div>
              <div className="text-[11px] text-gray-400">{openPrsSubtitle}</div>
              <div className="mt-0.5 text-[11px] text-gray-400">open now, drafts not counted</div>
            </TileShell>
            <TileShell onActivate={open('ci_red')}>
              <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Red checks now
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
                  ? `red for ~${fmtDuration(metrics.ciFailingMedianAgeHours)} (median)`
                  : 'all green'}
              </div>
              <div className="mt-0.5 text-[11px] text-gray-400">open pull requests</div>
            </TileShell>
          </div>
        </div>
      </div>

      {/* Primary trends — throughput + the two operationally-urgent CI views up front. The
          "12-week trend" label sits HERE, over the charts, rather than up in the tiles' caption
          where it read as part of the comparison-window scope — the tiles compare over the
          window, but these weekly series span 12 weeks (per-chart notes say "weekly"/"window"). */}
      <h4 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Last 12 weeks
      </h4>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <ChartCard
          title="Reviews and comments per merged pull request"
          note="people vs bots · weekly"
        >
          {reviewLoadEmpty ? (
            <ChartEmpty label="No merged-PR review activity yet" />
          ) : (
            <LineChart labels={labels} series={reviewLoadSeries} area curved formatY={loadFmt} />
          )}
        </ChartCard>
        <ChartCard title="Pull requests opened and merged" note="weekly">
          {sum(metrics.throughput.opened) + sum(metrics.throughput.merged) === 0 ? (
            <ChartEmpty />
          ) : (
            <LineChart labels={labels} series={throughputSeries} area curved />
          )}
        </ChartCard>
        <ChartCard title="Time to fix red checks" note="median, red to green · weekly">
          {metrics.ciRecoveryTrend.every((v) => v == null) ? (
            <ChartEmpty label="No CI recoveries yet — accrues from sync" />
          ) : (
            <LineChart labels={labels} series={recoverySeries} area curved formatY={fmtDuration} />
          )}
        </ChartCard>
        {/* "CI failures by stage" deliberately NOT here — hidden by default, first card of the
            folded "More charts" section below. */}
      </div>

      {/* Secondary trends — folded away by default to keep the panel focused. */}
      <div>
        <button
          type="button"
          onClick={() => setShowMore((s) => !s)}
          className="text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ChevronIcon dir={showMore ? 'down' : 'right'} className="inline-block align-[-0.1em]" />{' '}
          More charts
          {moreChartsSlot == null ? ' — time to merge, checks, review depth' : ''}
        </button>
        {showMore &&
          (moreChartsSlot != null ? (
            <div className="mt-2 space-y-3">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{ciFailuresCard}</div>
              {moreChartsSlot}
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {ciFailuresCard}
              <ChartCard title="Time to merge" note="median, opened to merged · weekly">
                {metrics.leadTimeTrend.every((v) => v == null) ? (
                  <ChartEmpty />
                ) : (
                  <LineChart labels={labels} series={leadSeries} area curved formatY={fmtDuration} />
                )}
              </ChartCard>
              <ChartCard title="Checks green at merge" note="% of merged pull requests · weekly">
                {metrics.ciSuccessTrend.every((v) => v == null) ? (
                  <ChartEmpty />
                ) : (
                  <LineChart labels={labels} series={ciSeries} curved formatY={pctFmt} />
                )}
              </ChartCard>
              <ChartCard
                title="Changes requested"
                note="% of merged pull requests sent back for changes · weekly"
              >
                {nullEvery(crTrend) ? (
                  <ChartEmpty />
                ) : (
                  <LineChart labels={labels} series={crSeries} curved formatY={pctFmt} />
                )}
              </ChartCard>
              <ChartCard
                title="Review coverage"
                note="merged pull requests by who reviewed them · weekly"
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
                note="median · weekly"
                info={
                  <InfoButton title="Rework after review">
                    <p>
                      For each reviewed pull request merged that week, the share of its commits made
                      after its first review. The line is the median of those shares.
                    </p>
                    <p>Pull requests that were never reviewed are left out.</p>
                  </InfoButton>
                }
              >
                {nullEvery(reworkTrend) ? (
                  <ChartEmpty label="No reviewed merges yet" />
                ) : (
                  <LineChart labels={labels} series={reworkSeries} area curved formatY={pctFmt} />
                )}
              </ChartCard>
              <ChartCard
                title="Time to resolve threads"
                note="median · people vs bots · weekly"
                info={
                  <InfoButton title="Time to resolve threads">
                    <p>
                      Median time from a review thread being opened to being resolved, by the week it
                      was resolved. Split by who clicked resolve: a person or a bot.
                    </p>
                    <p>
                      Only resolutions Limn saw happen are counted. A thread that was already
                      resolved when its repository was first synced has no known resolve time.
                    </p>
                  </InfoButton>
                }
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
              <ChartCard title="Time from review request to first review" note="median · weekly">
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
