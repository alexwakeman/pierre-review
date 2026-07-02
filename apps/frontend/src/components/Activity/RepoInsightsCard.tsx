import { useRepoAnalytics } from '../../hooks/useTriage.js';
import { PALETTE, ChartEmpty, type Series } from '../charts/common.js';
import { LineChart } from '../charts/LineChart.js';

// The Activity rail's per-repo Insights (item 12): the "PR merge rate over time" graph,
// sitting under the AI digest (in RepoFeedHeader) and above the open-PR list. The "Charts"
// button opens the full RepoAnalyticsModal — the same detailed drill-down the old Insights
// modal used. Reuses the analytics fetch (cached per repo), so opening Charts is instant.
export function RepoInsightsCard({
  repoId,
  onOpenCharts,
}: {
  repoId: number;
  onOpenCharts: () => void;
}): JSX.Element {
  const { data, isLoading } = useRepoAnalytics(repoId);
  const weeks = data?.weekBuckets ?? [];
  const series: Series[] = [
    { key: 'opened', label: 'Opened', color: PALETTE.blue, values: data?.throughput.opened ?? [] },
    { key: 'merged', label: 'Merged', color: PALETTE.green, values: data?.throughput.merged ?? [] },
  ];
  const hasData = series.some((s) => (s.values as number[]).some((v) => v > 0));

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          PR merge rate{data ? ` · ${data.windowDays / 7}-wk` : ''}
        </span>
        <button
          type="button"
          onClick={onOpenCharts}
          className="shrink-0 rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
          title="Open the full analytics charts for this repo"
        >
          📊 Charts
        </button>
      </div>
      {isLoading && data == null ? (
        <div className="h-[132px] animate-pulse rounded bg-gray-50 dark:bg-gray-900/40" />
      ) : hasData ? (
        <LineChart labels={weeks} series={series} area curved />
      ) : (
        <ChartEmpty />
      )}
    </div>
  );
}
