import { useWorkspaceMetrics } from '../../hooks/useWorkspaceInsights.js';
import { useFilters } from '../../store/filters.js';
import { WorkspaceMetricsPanel } from './WorkspaceMetricsPanel.js';

// The workspace flow-metric header (DORA-ish tiles + trend charts) at the TOP of the cross-repo
// Feed. CORE/free — it moved out of the Pro Insights pane (these overview features are free) and
// fetches `/api/workspace-metrics` with no capability gate; tiles drill down via the same
// metrics-detail tab as Insights (also freed).
//
// Scoped by the ACTIVE WORKSPACE alone — a plain id, the whole scope. It is null until the
// workspaces query resolves the account's Default, and `useWorkspaceMetrics` holds the query idle
// (skipToken) until then, so this simply renders nothing rather than showing another workspace's
// numbers. Also renders nothing when the workspace has no repos.
export function FeedMetricsPanel(): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const openMetricsDetail = useFilters((s) => s.openMetricsDetail);
  const openOpenPrsDetail = useFilters((s) => s.openOpenPrsDetail);
  const { data } = useWorkspaceMetrics(workspaceId);
  if (!data?.metrics) return null;
  return (
    <WorkspaceMetricsPanel
      metrics={data.metrics}
      onOpenMetric={openMetricsDetail}
      // The Open-PRs tile routes to the SAME sortable open-PRs drill-down the "Show all"
      // footers open — workspace-wide ('feed'), not a metrics-detail sub-tab.
      onOpenOpenPrs={() => openOpenPrsDetail('feed')}
    />
  );
}
