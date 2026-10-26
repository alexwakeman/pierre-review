import { useWorkspaceMetrics } from '../../hooks/useWorkspaceInsights.js';
import { useFilters } from '../../store/filters.js';
import { BottlenecksPanel } from './BottlenecksPanel.js';
import { effectiveInsightsTab } from './bottlenecksModel.js';
import { PeriodReportsPanel } from './PeriodReportsPanel.js';
import { StoriesView } from './StoriesView.js';
import { WorkspaceFlowMetrics } from './WorkspaceFlowMetrics.js';

// The "Reports" pane — the Activity rail entry formerly labelled "Insights" (the store value
// behind it is still `activityRepoId === 'insights'`; see Activity/index.tsx).
//
// ── THE PANE IS THREE TABS ──────────────────────────────────────────────────────────────────
//   • Overview   — flow metrics, the two "where the work is happening" cards, period reports.
//   • Stories    — every tracker ticket with a PR merged in the REPORTING WINDOW: two charts and
//     the lists (StoriesView, GET /api/stories).
//   • Chronology — the COURT LEDGER (BottlenecksPanel). Deterministic (no model anywhere behind
//     it) and the twin of the Bots rail — that surface measures automation, this one measures
//     where people's time went.
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

  return (
    <div className="space-y-4" data-testid="insights-view">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Reports</h2>

      {/* The pane's sub-tab strip.
          `effectiveTab` (derived, never written back) picks the body.
          The strip can be wider than a phone: the strip scrolls inside itself, never the page. */}
      <div role="tablist" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-gray-200 dark:border-gray-800">
        {(
          [
            { key: 'overview', label: 'Overview' },
            { key: 'stories', label: 'Stories' },
            // ⚠ LABEL-ONLY: the store/URL literal stays 'bottlenecks' (see InsightsInnerTab).
            { key: 'bottlenecks', label: 'Chronology' },
          ] as const
        ).map((t) => {
          const on = effectiveTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setInnerTab(t.key)}
              className={`-mb-px flex shrink-0 items-center gap-1 whitespace-nowrap rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                on
                  ? 'border-gray-300 bg-white text-sky-600 dark:border-gray-700 dark:bg-gray-950 dark:text-sky-300'
                  : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

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
            <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
              Nothing to measure in this Workspace yet.
              <div className="mt-1 text-[11px]">
                Flow metrics appear once this workspace has merged pull requests to measure.
              </div>
            </div>
          ) : (
            // No section heading here: the panel's own "Flow metrics" heading (with its info
            // button) is the heading, and a second one above it read as a stutter.
            <section className="space-y-2">
              <WorkspaceFlowMetrics />
            </section>
          )}

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Period reports
            </h3>
            <PeriodReportsPanel />
          </section>
        </>
      )}
    </div>
  );
}
