import { useMemo, useState } from 'react';
import { useFilters, type InsightsSubTab } from '../../store/filters.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { AdHocChatPanel } from './AdHocChatPanel.js';
import { PeriodReportsPanel } from './PeriodReportsPanel.js';
import { TrackUsage } from './TrackUsage.js';

// The Pro "Insights" pane. Overview is a SINGLE consolidated surface: the ad-hoc chat with
// quick-question pills (the former Sprint-report card + the six-question preset carousel were
// folded into the chat — a pill pre-fills the box, the user presses Ask). The attention cards
// that used to sit beneath the AI panels moved to the CORE/free "Needs attention" rail entry
// (AttentionView).
//
// "Reports" is the period-over-period surface: one completed sprint-cadence period as a stored,
// forwardable artifact (figures + a like-for-like comparison + a refusable forecast + a grounded
// drill-down). It is the SECOND tab, which is what re-activated this tablist — SUB_TABS held one
// entry for a long time and the bar rendered not at all.
//
// The "Compare" sub-tab MOVED OUT twice and now lives on the Activity RAIL as its own line
// ("Compare workspaces", `activityRepoId === 'compare'`; see Activity/index.tsx). It was gated
// here on the old All-Teams scope sentinel, so an explicit two-of-five selection made the tab
// silently vanish; it then sat briefly on the Feed's sub-tab bar. It is CORE/free, compares EVERY
// workspace in the account rather than anything the selection narrows, and is shown whenever the
// account owns 2+ workspaces — which is why it could not stay under a scoped pane at all.

// InsightsSubTab lives in the store (filters.ts) — the last-active tab is remembered there.
// The tab LIST is now derived per render from the capabilities, so a tab exists only where it
// means something; anything else stored or deep-linked (the vestigial 'sprint', which was folded
// into Overview) normalizes back to Overview below.
const OVERVIEW_TAB: { key: InsightsSubTab; label: string } = { key: 'overview', label: 'Overview' };

/**
 * Normalize a stored/stale sub-tab to one that still exists IN THIS CONTEXT. A membership test
 * against the live list rather than a chain of `=== 'sprint'` literals, so a value removed from
 * the union (the way 'compare' and 'retro' were) — or one whose capability is currently off —
 * cannot strand the pane on a tab that renders nothing.
 *
 * ⚠ The result is DERIVED FOR THE RENDER ONLY and is never written back to the store. That is the
 * same rule the Feed's and Bots' inner tabs follow: a stored scalar may legitimately name a tab
 * the current context does not render (Pro flickering, a capability toggled off and back on), and
 * a corrective `setInsightsSubTab` here would permanently forget the user's choice.
 */
function normalizeSubTab(
  tab: InsightsSubTab | null,
  tabs: { key: InsightsSubTab }[],
): InsightsSubTab {
  return tabs.some((t) => t.key === tab) ? (tab as InsightsSubTab) : 'overview';
}

export function InsightsView(): JSX.Element {
  // The last-active tab is store-remembered (insightsSubTab) so a remount restores it; tab
  // changes write BOTH the local state and the store.
  const storedSubTab = useFilters((s) => s.insightsSubTab);
  const setInsightsSubTab = useFilters((s) => s.setInsightsSubTab);
  const [subTab, setSubTabLocal] = useState<InsightsSubTab>(() => storedSubTab ?? 'overview');
  const setSubTab = (tab: InsightsSubTab): void => {
    setSubTabLocal(tab);
    setInsightsSubTab(tab);
  };

  const { periodReports } = useProCapabilities();
  const subTabs = useMemo(() => {
    const tabs: { key: InsightsSubTab; label: string }[] = [OVERVIEW_TAB];
    if (periodReports) tabs.push({ key: 'reports', label: 'Reports' });
    return tabs;
  }, [periodReports]);

  // A one-item tablist is noise, so the bar only renders once there are ≥2 tabs. Written as a
  // derived guard rather than deleting the tab apparatus outright: the store field + the stale-value
  // redirect stay live and type-checked, and a capability going dark re-hides the bar with no
  // other change.
  const showSubTabs = subTabs.length > 1;
  const activeSubTab = normalizeSubTab(subTab, subTabs);

  const [showUsage, setShowUsage] = useState(false);

  return (
    <div className="space-y-3" data-testid="insights-view">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Insights</h2>
        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowUsage((s) => !s)}
            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
              showUsage
                ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-300'
                : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500'
            }`}
            title="Show your month-to-date AI usage (in credits)"
          >
            {showUsage ? '▾' : '▸'} Track usage
          </button>
        </div>
      </div>

      {showUsage && <TrackUsage />}

      {showSubTabs && (
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
          {subTabs.map(({ key, label }) => {
            const on = key === activeSubTab;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setSubTab(key)}
                className={`-mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                  on
                    ? 'border-gray-300 bg-white text-violet-600 dark:border-gray-700 dark:bg-gray-950 dark:text-violet-300'
                    : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Overview is consolidated: JUST the ad-hoc chat (with quick-question pills). The Sprint
          report card + the "Sprint questions" preset carousel folded into it; the attention cards
          moved to the free "Needs attention" rail entry, and Compare to the free "Compare
          workspaces" one. */}
      {activeSubTab === 'reports' ? <PeriodReportsPanel /> : <AdHocChatPanel />}
    </div>
  );
}
