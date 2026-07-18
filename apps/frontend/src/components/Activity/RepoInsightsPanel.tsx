import { useRepoTeamMetrics } from '../../hooks/useRepoTeamMetrics.js';
import { useRepoAnalytics, useProCapabilities } from '../../hooks/useTriage.js';
import { Charts } from '../RepoAnalyticsModal.js';
import { TeamMetricsPanel } from './TeamMetricsPanel.js';

// The per-repo replica of the Insights Overview, scoped to ONE repo. Visually mirrors the
// team Insights panel — the same "FLOW METRICS · DORA-ish" tile row + the 3 primary trend
// charts + a single "More charts" button — except the tiles are NON-clickable (no
// `onOpenMetric`) and "More charts" reveals the FULL per-repo charts grid inline (the old
// RepoAnalyticsModal content) instead of just lead-time/merge-CI. Reuses the two per-repo
// caches: useRepoTeamMetrics (the tile/trend header) + useRepoAnalytics (the charts grid).
//
// `repoFullName` is part of the console's contract (passed by the repo-detail mount); the
// panel is scoped by `repoId` and captions the Open-PRs tile "in this repo".
export function RepoInsightsPanel({
  repoId,
}: {
  repoId: number;
  repoFullName: string;
}): JSX.Element {
  // The flow-metric header (DORA-ish tiles + trend charts) is the Pro Insights surface, so gate
  // its fetch on teamInsights. When Pro is off (no PRO_DIGEST_ENABLED) rm stays undefined and the
  // panel degrades to just the CORE per-repo charts below — the same as the OSS/no-plugin path.
  const { teamInsights } = useProCapabilities();
  const { data: rm, isLoading: rmLoading } = useRepoTeamMetrics(repoId, teamInsights);
  const { data: analytics, isLoading: analyticsLoading } = useRepoAnalytics(repoId);

  // The full per-repo charts grid, inlined under the panel's "More charts" expander (null
  // until the analytics fetch resolves — the expander simply has no content yet).
  const chartsSlot = analytics ? <Charts data={analytics} /> : null;

  // Metrics header available → the full Insights-style panel (non-clickable tiles + primary
  // trends + the inline charts grid under "More charts").
  if (rm?.metrics) {
    return (
      <TeamMetricsPanel
        metrics={rm.metrics}
        openPrsSubtitle="in this repo"
        moreChartsSlot={chartsSlot}
      />
    );
  }

  // Header still loading (nothing to show yet) → skeleton, mirroring RepoInsightsCard.
  if (rmLoading && rm == null) {
    return (
      <div className="h-44 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
    );
  }

  // Header unavailable (Pro off / repo not owned / no metrics) — degrade gracefully to the
  // per-repo charts. Collapsible so the free/core repo view defaults to the same primary trio
  // as the Insights pane (throughput · CI recovery · CI failures by stage) with a "More charts"
  // expander, rather than dumping the whole grid expanded.
  if (analytics) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-800 dark:bg-gray-900/20">
        <Charts data={analytics} collapsible />
      </div>
    );
  }

  if (analyticsLoading) {
    return (
      <div className="h-44 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
    );
  }

  // Nothing available for this repo.
  return <></>;
}
