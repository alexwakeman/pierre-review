import { useState } from 'react';
import { useWorkspaceMetrics } from '../../hooks/useWorkspaceInsights.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { ChevronIcon } from '../Icons.js';
import { ProLockPanel, useProGateState } from '../ProGate.js';
import { BottlenecksPanel } from './BottlenecksPanel.js';
import { effectiveInsightsTab } from './bottlenecksModel.js';
import { MergedPrsView } from './MergedPrsView.js';
import { PeriodReportsPanel } from './PeriodReportsPanel.js';
import { TrackUsage } from './TrackUsage.js';
import { WorkspaceFlowMetrics } from './WorkspaceFlowMetrics.js';

// The "Reports" pane — the Activity rail entry formerly labelled "Insights" (the store value
// behind it is still `activityRepoId === 'insights'`; see Activity/index.tsx).
//
// ⚠ THE WHOLE PANE IS PRO (`periodReports`) — flow metrics, the "where the work is happening"
// cards, period reports and Chronology alike. `InsightsView` below is the ONE gate:
// visible-but-locked, one ProLockPanel for the whole pane, the single ProBadge on the rail entry
// (Activity/index.tsx), no badges inside. The routes 402 (`/api/workspace-metrics*`,
// `/api/flow-findings`, the plugin's period-report routes) and every hook ANDs the flag into its
// own `enabled`. The inner Chronology/period-report locks stay as defence in depth.
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
// ── THE PANE IS THREE TABS ───────────────────────────────────────────────────────────────────
//   • Overview   — flow metrics, the two "where the work is happening" cards, period reports.
//   • Merged so far — the Open PRs cards over every PR merged in the REPORTING WINDOW
//     (MergedPrsView, GET /api/merged-prs), grouped per ticket when the workspace has a tracker.
//   • Chronology — the COURT LEDGER (BottlenecksPanel). PRO on `periodReports`; still
//     deterministic (no model anywhere behind it) and still the twin of the Bots rail — that
//     surface measures automation, this one measures where people's time went.
//
// ⚠ IT RIDES `periodReports` RATHER THAN A FLAG OF ITS OWN — one capability, no `apiVersion` bump,
// no plugin edit. The reasoning is written out on the route (api/routes/flow.ts), which is also
// where the enforcement lives: this file decides what the reader SEES, and a client gate is not a
// monetisation gate.
//
// ⚠ THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK (`effectiveInsightsTab`) — the rule
// `botsInnerTab` / `feedInnerTab` are commented against. A corrective `setInsightsInnerTab()`
// would permanently forget the reader's choice, and would break the round-trip urlHistory.test.ts
// pins.

/**
 * The Chronology tab's body: the real panel, the locked pane, or nothing at all for the beat
 * `/api/me` is in flight.
 *
 * ⚠ THE BLANK BEAT IS THE POINT, not an oversight. `useProCapabilities()` reads all-false until
 * `/api/me` resolves, so the obvious `!periodReports ? <lock/> : <panel/>` paints "See what Pro
 * includes" for one frame on every cold load AT AN ACCOUNT THAT PAYS. `useProGateState` is the
 * three-state answer to that; rendering the panel through the wait would be the mirror-image lie,
 * flashing "Measuring…" at a reader we are about to tell we measure nothing for.
 *
 * The lock's copy names the QUESTION this view answers, never the price — someone who will never
 * pay still learns the product has an answer to something they wonder about (ProGate.tsx, rule 2).
 */
function ChronologyTabBody(): JSX.Element | null {
  const { periodReports } = useProCapabilities();
  const gate = useProGateState(periodReports);
  if (gate === 'pending') return null;
  if (gate === 'locked') {
    return (
      // ⚠ A testid DISTINCT from `bottlenecks-panel`. Two states answering to one id is how a
      // misconfigured screenshot run photographs a lock screen and ships it as a marketing shot.
      <ProLockPanel heading="Chronology" testId="chronology-locked">
        Every hour a pull request is open, someone is holding it — a reviewer who hasn’t looked, an
        author who owes a reply, or nobody, approved and waiting to merge. Chronology splits that
        time between those three waits and names the repositories where one wait takes most of the
        time and pull requests are slow to merge.
      </ProLockPanel>
    );
  }
  return <BottlenecksPanel />;
}

export function InsightsView(): JSX.Element | null {
  const { periodReports } = useProCapabilities();
  // Three-state, so a paying account never sees the lock flash while /api/me is in flight.
  const gate = useProGateState(periodReports);
  if (gate === 'pending') return null;
  if (gate === 'locked') {
    return (
      <div className="space-y-4" data-testid="insights-view-locked">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Reports</h2>
        <ProLockPanel heading="Reports">
          How is the team&rsquo;s work flowing? See merge times, review waits and where the work
          is happening this sprint, then a stored report for each finished period you can compare
          and share.
        </ProLockPanel>
      </div>
    );
  }
  return <InsightsBody />;
}

function InsightsBody(): JSX.Element {
  const [showUsage, setShowUsage] = useState(false);
  const { activityDigest } = useProCapabilities();
  const workspaceId = useFilters((s) => s.workspaceId);
  const innerTab = useFilters((s) => s.insightsInnerTab);
  const setInnerTab = useFilters((s) => s.setInsightsInnerTab);
  const effectiveTab = effectiveInsightsTab(innerTab);
  // `workspaceId === null` means "not resolved yet" — the hook holds itself idle until then, so
  // this reads `undefined` rather than another workspace's numbers.
  const metrics = useWorkspaceMetrics(workspaceId);
  // `WorkspaceFlowMetrics` self-hides when the workspace has no measurable history; this empty
  // state stands in for that SECTION only — the period-report panel below keeps its own setup
  // prompt, because for an entitled account "no metrics yet" is not the end of the pane.
  const nothingToShow = metrics.data != null && metrics.data.metrics == null;

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

      {/* The pane's sub-tab strip.
          `effectiveTab` (derived, never written back) picks the body.
          No badges here: the whole pane is Pro and the rail entry carries the one ProBadge. */}
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {(
          [
            { key: 'overview', label: 'Overview' },
            { key: 'merged', label: 'Merged so far' },
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
        <ChronologyTabBody />
      ) : effectiveTab === 'merged' ? (
        <MergedPrsView />
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
