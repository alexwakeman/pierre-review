import { useTeamMetrics } from '../../hooks/useTeamInsights.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { TeamMetricsPanel } from './TeamMetricsPanel.js';

// The team flow-metric header (DORA-ish tiles + trend charts) at the TOP of the cross-repo Feed.
// CORE/free now — moved out of the Pro Insights pane (these overview features are free). Fetches
// the free /api/team-metrics (no capability gate); tiles drill down via the same metrics-detail
// tab as Insights (also freed). Scoped by the team selector, like the rest of the console.
// Renders nothing until metrics resolve (or when there are no repos in scope).
export function FeedMetricsPanel(): JSX.Element | null {
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const openMetricsDetail = useFilters((s) => s.openMetricsDetail);
  const { data } = useTeamMetrics(scope);
  if (!data?.metrics) return null;
  return <TeamMetricsPanel metrics={data.metrics} onOpenMetric={openMetricsDetail} />;
}
