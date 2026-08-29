import { useState } from 'react';
import { useWorkspaceMetrics } from '../../hooks/useWorkspaceInsights.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { ChevronIcon } from '../Icons.js';
import { BottlenecksPanel } from './BottlenecksPanel.js';
import { effectiveInsightsTab } from './bottlenecksModel.js';
import { PeriodReportsPanel } from './PeriodReportsPanel.js';
import { TrackUsage } from './TrackUsage.js';
import { WorkspaceFlowMetrics } from './WorkspaceFlowMetrics.js';

// The "Reports" pane — the Activity rail entry formerly labelled "Insights" (the store value
// behind it is still `activityRepoId === 'insights'`; see Activity/index.tsx).
//
// ⚠ IT IS NO LONGER A PRO-ONLY PANE, and the rail entry that opens it is no longer gated. It is
// now TWO HALVES with different tiers, and the pane's job is to keep them visibly apart:
//
//   • Flow metrics — CORE/FREE. The DORA-ish tiles + trend charts, moved here off the Feed, where
//     a workspace-wide survey sat on top of a chronological stream. This is why the entry was
//     un-gated: hiding the pane would have taken a free feature behind the Pro wall.
//   • Period reports — PRO. The stored period-over-period artifact, its comparison, the forecast
//     and the grounded chat, all inside PeriodReportsPanel, which carries its own free posture
//     (a one-line nudge on cloud, nothing at all in OSS) and issues ZERO requests without the
//     capability.
//
// ⚠ THE `Pro` CHIP SITS ON THE PERIOD-REPORT HEADING, NOT THE PANE HEADER. It used to badge the
// whole pane, which for a free account would now read as "Pro" stamped over free metrics — the
// wrong first impression on the one screen this change exists to make worth opening.
//
// ⚠ "Track usage" IS PRO-GATED, and not merely for tidiness: it fires `/api/pro/ai-usage`, which
// 402s for a free cloud account and 404s in OSS — but `useAiUsage` seeds `placeholderData` off
// `/api/me`, so the meters would still PAINT over the failed request. A plausible AI-spend panel
// built from a stale seed is worse than no panel.
//
// The ad-hoc chat that WAS the Overview tab lives INSIDE PeriodReportsPanel as the collapsed
// "Ask about this period" section under the report, grounded in the viewed period's own
// [fromMs, toMs) rather than a trailing window.
//
// ── THE PANE IS TWO TABS ─────────────────────────────────────────────────────────────────────
//   • Overview    — exactly the body described above, unchanged.
//   • Where it's stuck — the COURT LEDGER (BottlenecksPanel). CORE, FREE ON EVERY TIER,
//     deterministic, and the twin of the Bots rail: that surface measures automation, this one
//     measures people's time. It renders in OSS mode with no plugin present.
//
// ⚠ THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK (`effectiveInsightsTab`) — the rule
// `botsInnerTab` / `feedInnerTab` are commented against. A corrective `setInsightsInnerTab()`
// would permanently forget the reader's choice the moment a value it could not render arrived
// (a hand-edited `?insightsTab=`, or a history entry naming a member a later build gates).
// Neither member is gated TODAY, which is exactly why the temptation to "just normalise it in
// the store" is easy to give in to and still wrong.
export function InsightsView(): JSX.Element {
  const [showUsage, setShowUsage] = useState(false);
  const { activityDigest, periodReports } = useProCapabilities();
  const workspaceId = useFilters((s) => s.workspaceId);
  const innerTab = useFilters((s) => s.insightsInnerTab);
  const setInnerTab = useFilters((s) => s.setInsightsInnerTab);
  const effectiveTab = effectiveInsightsTab(innerTab);
  // `workspaceId === null` means "not resolved yet" — the hook holds itself idle until then, so
  // this reads `undefined` rather than another workspace's numbers.
  const metrics = useWorkspaceMetrics(workspaceId);
  // Both halves have nothing to say: a free account on a workspace with no measurable history
  // would otherwise get the blank pane this change exists to eliminate.
  const nothingToShow =
    !periodReports && metrics.data != null && metrics.data.metrics == null;

  return (
    <div className="space-y-4" data-testid="insights-view">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Reports</h2>
        <div className="ml-auto flex items-center gap-1.5">
          {activityDigest && (
            <button
              type="button"
              onClick={() => setShowUsage((s) => !s)}
              aria-expanded={showUsage}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                showUsage
                  ? 'border-ai-signal/50 bg-ai-signal/10 text-ai-signal'
                  : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
              }`}
              title="Show your month-to-date AI usage (in credits)"
            >
              <ChevronIcon dir={showUsage ? 'down' : 'right'} size={10} />
              Track usage
            </button>
          )}
        </div>
      </div>

      {showUsage && activityDigest && <TrackUsage />}

      {/* The pane's sub-tab strip. Both members are FREE on every tier, so neither carries a
          badge and neither is conditionally listed — the list is a constant, and `effectiveTab`
          (derived, never written back) decides which body renders. */}
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {(
          [
            { key: 'overview', label: 'Overview' },
            { key: 'bottlenecks', label: "Where it's stuck" },
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
              className={`-mb-px flex items-center gap-1 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
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
      ) : nothingToShow ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          Nothing to measure in this Workspace yet.
          <div className="mt-1 text-[11px]">
            Flow metrics appear once this workspace has merged pull requests to measure.
          </div>
        </div>
      ) : (
        <>
          {/* FREE. Self-hides when the workspace has nothing to measure. */}
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Flow metrics
            </h3>
            <WorkspaceFlowMetrics />
          </section>

          {/* PRO. Carries its own free posture — a one-line nudge on cloud, nothing in OSS. */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Period reports
              <span className="rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal">
                Pro
              </span>
            </h3>
            <PeriodReportsPanel />
          </section>
        </>
      )}
    </div>
  );
}
