import { useWorkspaceMetrics } from '../../hooks/useWorkspaceInsights.js';
import { useFilters } from '../../store/filters.js';
import { WorkspaceMetricsPanel } from './WorkspaceMetricsPanel.js';
import { WorkspaceRepoActivityCharts } from './WorkspaceRepoActivityCharts.js';

// The workspace flow-metric header (DORA-ish tiles + trend charts). CORE/free — it fetches
// `/api/workspace-metrics` with no capability gate; tiles drill down via the same metrics-detail
// tab as the reports (also free).
//
// ⚠ IT LIVES ON **REPORTS**, NOT THE FEED. It sat at the top of the cross-repo Feed for one
// generation, which put a workspace-wide SURVEY above a chronological STREAM and pushed the feed
// itself two screens down. Reports is where analytics belongs and where the period framing gives
// the numbers a denominator — and moving it is exactly why the Reports rail entry is no longer
// Pro-gated: this panel is free, so hiding its only home behind the Pro wall would have taken a
// free feature away.
//
// ⚠ It is in the Feed/Bots/Reports class: it covers EVERY repo in the workspace and never reads
// `filters.repoIds`. The repo picker is Timeline-only.
//
// Scoped by the ACTIVE WORKSPACE alone — a plain id, the whole scope. It is null until the
// workspaces query resolves the account's Default, and `useWorkspaceMetrics` holds the query idle
// (skipToken) until then, so this simply renders nothing rather than showing another workspace's
// numbers. Also renders nothing when the workspace has no repos.
//
// ⚠ THE PER-REPO BREAKDOWN IS MOUNTED HERE, NOT INSIDE `WorkspaceMetricsPanel`. That panel has TWO
// mounts: this one (the whole workspace) and `RepoInsightsPanel`, which renders it for ONE repo
// behind the Pro `workspaceInsights` gate. A per-repository comparison there degenerates to a
// single row — and would appear only for paying accounts, on the one screen where it answers
// nothing. Its activity half rides the SAME `/api/workspace-metrics` response as the panel above
// it, so there is no second request and the two halves can never be a refresh apart.
//
// ⚠ `WorkspaceRepoActivityCharts` NOW OWNS A SECOND CARD BESIDE ITS OWN — `WorkspaceReachCard`,
// which folds the pull requests MERGED in the reporting window (`reach` on this SAME response)
// through the ONE `blastRadius()` resolver; the levels are decided client-side so the sensitivity
// dial stays a render-time comparison. CORE/free like everything else here.
//
// ⚠ EVERY CARD HERE IS TIED TO ONE REPORTING WINDOW (`data.window`: this sprint so far, or the last
// 7/14 days), resolved once on the server. The labelled exceptions are the "Right now" tiles and
// the 12-week trend band.
export function WorkspaceFlowMetrics(): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const openMetricsDetail = useFilters((s) => s.openMetricsDetail);
  const openOpenPrsDetail = useFilters((s) => s.openOpenPrsDetail);
  const { data } = useWorkspaceMetrics(workspaceId);
  if (!data?.metrics) return null;
  return (
    <div className="space-y-3" data-testid="workspace-flow-metrics">
      <WorkspaceMetricsPanel
        metrics={data.metrics}
        onOpenMetric={openMetricsDetail}
        // The Open-PRs tile reveals the fixed Open PRs tab, every repo (it clears a repo the
        // "Show all" footer pre-selected) — not a metrics-detail sub-tab.
        onOpenOpenPrs={() => openOpenPrsDetail()}
      />
      {/* Absent on a response that predates the field, and the component self-hides when nothing
          was opened in the window. */}
      {data.repoActivity && (
        <WorkspaceRepoActivityCharts activity={data.repoActivity} window={data.window} />
      )}
    </div>
  );
}
