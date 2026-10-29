import { useWorkspaceMetrics } from '../../hooks/useWorkspaceInsights.js';
import { useFilters } from '../../store/filters.js';
import { BottlenecksPanel } from './BottlenecksPanel.js';
import { effectiveInsightsTab } from './bottlenecksModel.js';
import { PeriodReportsPanel } from './PeriodReportsPanel.js';
import { StoriesView } from './StoriesView.js';
import { WorkspaceFlowMetrics } from './WorkspaceFlowMetrics.js';
import { PageHeader, SectionHeading } from './reportChrome.js';
import { Tabs, useRegisterCommands, type Command, type TabItem } from '../ui/index.js';
import { useMemo } from 'react';
import { ChartIcon } from '../Icons.js';
import type { InsightsInnerTab } from '../../store/filters.js';

// ⚠ LABEL-ONLY rename: the store/URL literal stays 'bottlenecks' (see InsightsInnerTab).
const REPORT_TABS: readonly TabItem<InsightsInnerTab>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'bottlenecks', label: 'Chronology' },
  { id: 'stories', label: 'Stories' },
];

// The "Reports" pane — the Activity rail entry formerly labelled "Insights" (the store value
// behind it is still `activityRepoId === 'insights'`; see Activity/index.tsx).
//
// ── THE PANE IS THREE TABS ──────────────────────────────────────────────────────────────────
//   • Overview   — flow metrics, the two "where the work is happening" cards, period reports.
//   • Chronology — the COURT LEDGER (BottlenecksPanel). Deterministic (no model anywhere behind
//     it) and the twin of the Bots rail — that surface measures automation, this one measures
//     where people's time went.
//   • Stories    — every tracker ticket with a PR merged in the REPORTING WINDOW: two charts and
//     the lists (StoriesView, GET /api/stories). Sits to the RIGHT of Chronology.
// ("Merged so far" and "This sprint" LEFT this pane for the This Sprint tab —
// Sprint/SprintTabView; a legacy `?insightsTab=sprint|merged` lands there.)
//
// ⚠ THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK (`effectiveInsightsTab`) — the rule
// `botsInnerTab` / `sprintInnerTab` are commented against. A corrective `setInsightsInnerTab()`
// would permanently forget the reader's choice, and would break the round-trip urlHistory.test.ts
// pins.

export function InsightsView(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const innerTab = useFilters((s) => s.insightsInnerTab);
  const setInnerTab = useFilters((s) => s.setInsightsInnerTab);
  const effectiveTab = effectiveInsightsTab(innerTab);
  // `workspaceId === null` means "not resolved yet" — the hook holds itself idle until then, so
  // this reads `undefined` rather than another workspace's numbers.
  const metrics = useWorkspaceMetrics(workspaceId);
  // `WorkspaceFlowMetrics` self-hides when the workspace has no measurable history; this empty
  // state stands in for that SECTION only — the period-report panel below keeps its own setup
  // prompt, because "no metrics yet" is not the end of the pane.
  const nothingToShow = metrics.data != null && metrics.data.metrics == null;

  // ⌘K while Reports is showing: the period grain and every flow-metric drill-down.
  const commands = useMemo<Command[]>(() => {
    const f = (): ReturnType<typeof useFilters.getState> => useFilters.getState();
    const icon = <ChartIcon size={14} />;
    const metric = (key: Parameters<ReturnType<typeof useFilters.getState>['openMetricsDetail']>[0], label: string): Command => ({
      id: `reports:metric:${key}`,
      group: 'Actions',
      title: `Flow metrics: ${label}`,
      keywords: ['drill down', 'pull requests behind'],
      icon,
      run: () => f().openMetricsDetail(key),
    });
    return [
      { id: 'reports:grain:sprint', group: 'Actions', title: 'Period reports by sprint', icon, run: () => { f().setInsightsInnerTab('overview'); f().setInsightsReportGrain('sprint'); } },
      { id: 'reports:grain:month', group: 'Actions', title: 'Period reports by month', icon, run: () => { f().setInsightsInnerTab('overview'); f().setInsightsReportGrain('month'); } },
      metric('merges', 'Merged'),
      metric('lead_time', 'Time to merge'),
      metric('review_latency', 'Time to first review'),
      metric('merge_ci', 'Checks green at merge'),
      metric('ci_recovery', 'Time to fix red checks'),
      metric('ci_red', 'Red checks now'),
    ];
  }, []);
  useRegisterCommands('reports', commands);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6" data-testid="insights-view">
      {/* The page header: title + the sub-tab strip (the Tabs primitive; 1–3 pick a tab).
          `effectiveTab` (derived, never written back) picks the body. The strip scrolls inside
          itself on a phone, never the page. */}
      <PageHeader title="Reports">
        <Tabs
          label="Reports tabs"
          idPrefix="reports"
          numberKeys
          value={effectiveTab}
          onChange={setInnerTab}
          tabs={REPORT_TABS}
        />
      </PageHeader>

      {effectiveTab === 'bottlenecks' ? (
        <BottlenecksPanel />
      ) : effectiveTab === 'stories' ? (
        <StoriesView />
      ) : (
        <>
          {/* `WorkspaceFlowMetrics` self-hides when there is nothing to measure, so the empty
              state stands in for the SECTION — heading included — rather than being stacked under
              a heading with nothing beneath it. */}
          {nothingToShow ? (
            <div className="rounded-ui bg-ui-surface px-4 py-8 text-center text-body text-ui-ink">
              Nothing to measure in this Workspace yet.
              <div className="mt-1 text-meta text-ui-mute">
                Flow metrics appear once this workspace has merged pull requests to measure.
              </div>
            </div>
          ) : (
            // No section heading here: the panel's own "Flow metrics" heading (with its info
            // button) is the heading, and a second one above it read as a stutter.
            <section>
              <WorkspaceFlowMetrics />
            </section>
          )}

          <section className="space-y-3">
            <SectionHeading title="Period reports" />
            <PeriodReportsPanel />
          </section>
        </>
      )}
    </div>
  );
}
