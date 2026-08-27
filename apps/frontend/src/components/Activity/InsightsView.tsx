import { useState } from 'react';
import { ChevronIcon } from '../Icons.js';
import { PeriodReportsPanel } from './PeriodReportsPanel.js';
import { TrackUsage } from './TrackUsage.js';

// The Pro "Reports" pane — the Activity rail entry formerly labelled "Insights" (the store value
// behind it is still `activityRepoId === 'insights'`; see Activity/index.tsx). Reports-FIRST:
// the period-over-period report is the whole body, and the Overview/Reports sub-tab bar is gone
// (plan C5) — there is nothing left to switch between. The ad-hoc chat that WAS the Overview tab
// now lives INSIDE PeriodReportsPanel as the collapsed "Ask about this period" section under the
// report, grounded in the viewed period's own [fromMs, toMs) rather than a trailing window.
//
// The former sub-tab plumbing (`InsightsSubTab` / `insightsSubTab` in store/filters.ts, the
// derive-never-write-back normalization here) was retired with the bar: the field was transient
// (never persisted, never URL-emitted), so there is nothing stale to migrate — `?report=` still
// deep-links a period via `insightsReportKey` alone.
//
// "Track usage" stays on the pane header: it is the account's month-to-date AI spend, which
// belongs beside every surface on this pane that can spend (report generation AND the chat).
export function InsightsView(): JSX.Element {
  const [showUsage, setShowUsage] = useState(false);

  return (
    <div className="space-y-3" data-testid="insights-view">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Reports</h2>
        <span className="rounded bg-ai-signal/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ai-signal">
          Pro
        </span>
        <div className="ml-auto flex items-center gap-1.5">
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
        </div>
      </div>

      {showUsage && <TrackUsage />}

      <PeriodReportsPanel />
    </div>
  );
}
