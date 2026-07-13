import { useEffect } from 'react';
import type { RepoAnalytics } from '@pierre-review/shared';
import { useRepoAnalytics } from '../hooks/useTriage.js';
import { useUsers } from '../hooks/useTimeline.js';
import { indexUsers, userLabel, DERIVED_STATE_META } from '../lib/ui.js';
import {
  PALETTE,
  SERIES_COLORS,
  fmtDuration,
  fmtNum,
  ChartCard,
  ChartEmpty,
  type Series,
} from './charts/common.js';
import { LineChart } from './charts/LineChart.js';
import { BarChart } from './charts/BarChart.js';
import { StackedAreaChart } from './charts/StackedAreaChart.js';
import { ScatterChart } from './charts/ScatterChart.js';
import { Heatmap } from './charts/Heatmap.js';

const sum = (a: number[]): number => a.reduce((s, v) => s + v, 0);

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {title}
      </h3>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{children}</div>
    </div>
  );
}

function Charts({ data }: { data: RepoAnalytics }): JSX.Element {
  const { data: users } = useUsers();
  const usersById = indexUsers(users);
  const weeks = data.weekBuckets;
  const weeksNote = `${data.windowDays / 7}-wk · weekly`;

  // Flow
  const throughput: Series[] = [
    { key: 'opened', label: 'Opened', color: PALETTE.blue, values: data.throughput.opened },
    { key: 'merged', label: 'Merged', color: PALETTE.green, values: data.throughput.merged },
    { key: 'closed', label: 'Closed', color: PALETTE.gray, values: data.throughput.closed },
  ];
  const backlog: Series[] = [
    { key: 'open', label: 'Open', color: PALETTE.blue, values: data.backlog.open },
    { key: 'stalled', label: 'Stalled', color: PALETTE.orange, values: data.backlog.stalled },
  ];

  // Speed
  const latencyTrend: Series[] = [
    { key: 'median', label: 'Median to 1st review', color: PALETTE.blue, values: data.reviewLatencyTrend.medianHours },
  ];
  const cycle: Series[] = [
    { key: 'ttfr', label: 'Open → 1st review', color: PALETTE.amber, values: data.cycleBreakdown.toFirstReview },
    { key: 'rtm', label: '1st review → close', color: PALETTE.blue, values: data.cycleBreakdown.reviewToMerge },
  ];
  const latencyDist: Series[] = [
    { key: 'count', label: 'PRs', color: PALETTE.blue, values: data.reviewLatencyDist.map((b) => b.count) },
  ];
  const latencyLabels = data.reviewLatencyDist.map((b) => b.label);

  // Review health
  const threadMix: Series[] = [
    { key: 'untouched', label: DERIVED_STATE_META.untouched.label, color: DERIVED_STATE_META.untouched.color, values: data.threadMix.untouched },
    { key: 'replied', label: DERIVED_STATE_META.replied_unresolved.label, color: DERIVED_STATE_META.replied_unresolved.color, values: data.threadMix.replied_unresolved },
    { key: 'likely', label: DERIVED_STATE_META.likely_addressed.label, color: DERIVED_STATE_META.likely_addressed.color, values: data.threadMix.likely_addressed },
    { key: 'resolved', label: DERIVED_STATE_META.resolved.label, color: DERIVED_STATE_META.resolved.color, values: data.threadMix.resolved },
  ];
  const verdicts: Series[] = [
    { key: 'approved', label: 'Approved', color: PALETTE.green, values: data.reviewVerdicts.approved },
    { key: 'changes', label: 'Changes requested', color: PALETTE.orange, values: data.reviewVerdicts.changes_requested },
    { key: 'commented', label: 'Commented', color: PALETTE.gray, values: data.reviewVerdicts.commented },
    { key: 'dismissed', label: 'Dismissed', color: PALETTE.slate, values: data.reviewVerdicts.dismissed },
  ];
  const reviewerLoad: Series[] = data.reviewerLoad.map((r, i) => ({
    key: String(r.userId),
    label: r.userId === -1 ? 'Others' : userLabel(usersById.get(r.userId), r.userId),
    color: SERIES_COLORS[i % SERIES_COLORS.length]!,
    values: r.weekly,
  }));

  // Size
  const sizeDist: Series[] = [
    { key: 'count', label: 'PRs', color: PALETTE.purple, values: data.sizeDist.map((b) => b.count) },
  ];
  const sizeLabels = data.sizeDist.map((b) => b.label);
  const scatter = data.sizeVsCycle.map((p) => ({
    x: p.loc,
    y: p.hoursOpen,
    label: `#${p.prNumber}`,
    merged: p.merged,
  }));
  const sizeCycleLabels = data.sizeCycleByBucket.map((b) => b.label);
  const sizeCycleSeries: Series[] = [
    {
      key: 'median',
      label: 'Median time open',
      color: PALETTE.teal,
      values: data.sizeCycleByBucket.map((b) => b.medianHours ?? 0),
    },
  ];

  // CI health (per-repo, from the CI transition log)
  const ciRecovery = data.ciRecovery;
  const ciRecoveryEmpty =
    ciRecovery.length === 0 || ciRecovery.every((r) => r.medianHours == null);
  const ciIncidents = sum(ciRecovery.map((r) => r.incidents));
  const ciRecoveryLabels = ciRecovery.map((r) => r.weekStart);
  const ciRecoverySeries: Series[] = [
    {
      key: 'recovery',
      label: 'Median recovery',
      color: PALETTE.red,
      values: ciRecovery.map((r) => r.medianHours),
    },
  ];
  const ciFailuresByStage = data.ciFailuresByStage;
  const ciStageLabels = ciFailuresByStage.map((f) => f.stage);
  const ciStageSeries: Series[] = [
    {
      key: 'failures',
      label: 'Failures',
      color: PALETTE.orange,
      values: ciFailuresByStage.map((f) => f.count),
    },
  ];

  return (
    <div className="space-y-4">
      <Section title="Flow & throughput">
        <ChartCard title="PR throughput" note={weeksNote}>
          {sum(throughput.flatMap((s) => s.values as number[])) === 0 ? (
            <ChartEmpty />
          ) : (
            <BarChart labels={weeks} series={throughput} mode="grouped" />
          )}
        </ChartCard>
        <ChartCard title="Open backlog & stalled" note="weekly snapshot">
          {Math.max(0, ...data.backlog.open) === 0 ? (
            <ChartEmpty />
          ) : (
            <LineChart labels={weeks} series={backlog} curved />
          )}
        </ChartCard>
      </Section>

      <Section title="Speed & latency">
        <ChartCard title="Time to first review" note="weekly median">
          {data.reviewLatencyTrend.medianHours.every((v) => v == null) ? (
            <ChartEmpty />
          ) : (
            <LineChart labels={weeks} series={latencyTrend} area formatY={fmtDuration} curved />
          )}
        </ChartCard>
        <ChartCard title="Cycle-time breakdown" note="by close week">
          {sum(data.cycleBreakdown.count) === 0 ? (
            <ChartEmpty />
          ) : (
            <BarChart labels={weeks} series={cycle} mode="stacked" formatY={fmtDuration} />
          )}
        </ChartCard>
        <ChartCard title="Review-latency distribution" note="open → 1st review">
          {sum(latencyDist[0]!.values as number[]) === 0 ? (
            <ChartEmpty />
          ) : (
            <BarChart labels={latencyLabels} series={latencyDist} />
          )}
        </ChartCard>
      </Section>

      <Section title="CI health">
        <ChartCard
          title="CI recovery time"
          note={ciRecoveryEmpty ? 'weekly median' : `${ciIncidents} recoveries · weekly median`}
        >
          {ciRecoveryEmpty ? (
            <ChartEmpty label="No CI failures recorded" />
          ) : (
            <LineChart
              labels={ciRecoveryLabels}
              series={ciRecoverySeries}
              area
              curved
              formatY={fmtDuration}
            />
          )}
        </ChartCard>
        <ChartCard title="CI failures by stage" note="by check name">
          {ciFailuresByStage.length === 0 ? (
            <ChartEmpty label="No CI failures recorded" />
          ) : (
            <BarChart labels={ciStageLabels} series={ciStageSeries} rotateLabels />
          )}
        </ChartCard>
      </Section>

      <Section title="Review health">
        <ChartCard title="Thread-resolution mix" note="by thread created week">
          {sum(threadMix.flatMap((s) => s.values as number[])) === 0 ? (
            <ChartEmpty />
          ) : (
            <StackedAreaChart labels={weeks} series={threadMix} />
          )}
        </ChartCard>
        <ChartCard title="Review verdicts" note={weeksNote}>
          {sum(verdicts.flatMap((s) => s.values as number[])) === 0 ? (
            <ChartEmpty />
          ) : (
            <BarChart labels={weeks} series={verdicts} mode="stacked" />
          )}
        </ChartCard>
        <ChartCard title="Reviews by reviewer" note={weeksNote}>
          {reviewerLoad.length === 0 ? (
            <ChartEmpty />
          ) : (
            <StackedAreaChart labels={weeks} series={reviewerLoad} />
          )}
        </ChartCard>
      </Section>

      <Section title="Size & risk">
        <ChartCard title="PR size distribution" note="opened, by LOC">
          {sum(sizeDist[0]!.values as number[]) === 0 ? (
            <ChartEmpty />
          ) : (
            <BarChart labels={sizeLabels} series={sizeDist} />
          )}
        </ChartCard>
        <ChartCard title="Median time open by size" note="PRs closed in window">
          {sum(data.sizeCycleByBucket.map((b) => b.count)) === 0 ? (
            <ChartEmpty />
          ) : (
            <BarChart
              labels={sizeCycleLabels}
              series={sizeCycleSeries}
              formatY={fmtDuration}
              formatValue={fmtDuration}
            />
          )}
        </ChartCard>
        <ChartCard title="Size vs. time open" note="log–log · power-law fit">
          {scatter.length === 0 ? (
            <ChartEmpty />
          ) : (
            <ScatterChart
              points={scatter}
              xLabel="LOC"
              yLabel="time open"
              formatX={fmtNum}
              formatY={fmtDuration}
              fit
            />
          )}
        </ChartCard>
      </Section>

      <Section title="Cadence">
        <ChartCard title="Activity heatmap" note="by weekday × hour (UTC)">
          {sum(data.activityHeatmap) === 0 ? (
            <ChartEmpty />
          ) : (
            <Heatmap cells={data.activityHeatmap} />
          )}
        </ChartCard>
      </Section>
    </div>
  );
}

export function RepoAnalyticsModal({
  repoId,
  repoName,
  onClose,
}: {
  repoId: number | null;
  repoName: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const { data, isLoading, error } = useRepoAnalytics(repoId);

  useEffect(() => {
    if (repoId == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [repoId, onClose]);

  if (repoId == null) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[88vh] w-[60rem] max-w-[96vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Repo analytics"
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{repoName ?? 'Analytics'}</h2>
            <p className="text-[11px] text-gray-400">
              Charts over the last {data ? data.windowDays / 7 : 12} weeks
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {isLoading && !data && (
            <div className="py-12 text-center text-sm text-gray-500">Loading analytics…</div>
          )}
          {error && (
            <div className="py-12 text-center text-sm text-red-500">Failed to load analytics.</div>
          )}
          {data && <Charts data={data} />}
        </div>
      </div>
    </div>
  );
}
