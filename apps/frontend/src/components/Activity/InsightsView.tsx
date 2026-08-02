import { useState } from 'react';
import { useFilters, type InsightsSubTab } from '../../store/filters.js';
import { AdHocChatPanel } from './AdHocChatPanel.js';
import { TrackUsage } from './TrackUsage.js';

// The Pro "Insights" pane. Overview is a SINGLE consolidated surface: the ad-hoc chat with
// quick-question pills (the former Sprint-report card + the six-question preset carousel were
// folded into the chat — a pill pre-fills the box, the user presses Ask). The attention cards
// that used to sit beneath the AI panels moved to the CORE/free "Needs attention" rail entry
// (AttentionView).
//
// The "Compare" sub-tab MOVED OUT twice and now lives on the Activity RAIL as its own line
// ("Compare workspaces", `activityRepoId === 'compare'`; see Activity/index.tsx). It was gated
// here on the old All-Teams scope sentinel, so an explicit two-of-five selection made the tab
// silently vanish; it then sat briefly on the Feed's sub-tab bar. It is CORE/free, compares EVERY
// workspace in the account rather than anything the selection narrows, and is shown whenever the
// account owns 2+ workspaces — which is why it could not stay under a scoped pane at all.

// InsightsSubTab lives in the store (filters.ts) — the last-active tab is remembered there.
// SUB_TABS is the list of tabs that CURRENTLY exist; anything else stored or deep-linked (the
// vestigial 'sprint', which was folded into Overview) normalizes back to Overview below.
const SUB_TABS: { key: InsightsSubTab; label: string }[] = [{ key: 'overview', label: 'Overview' }];

// A one-item tablist is noise, so the bar only renders once there are ≥2 tabs. Written as a
// derived guard rather than deleting the tab apparatus outright: the store field + the stale-value
// redirect stay live and type-checked, and adding a sub-tab back re-shows the bar with no other
// change. (Today SUB_TABS has exactly one entry, so the bar does not render at all.)
const SHOW_SUB_TABS = SUB_TABS.length > 1;

/**
 * Normalize a stored/stale sub-tab to one that still exists. A membership test rather than the
 * old chain of `=== 'sprint'` literals, so a value removed from the union in the future (the way
 * 'compare' and 'retro' just were) cannot strand the pane on a tab that renders nothing.
 */
function normalizeSubTab(tab: InsightsSubTab | null): InsightsSubTab {
  return SUB_TABS.some((t) => t.key === tab) ? (tab as InsightsSubTab) : 'overview';
}

export function InsightsView(): JSX.Element {
  // The last-active tab is store-remembered (insightsSubTab) so a remount restores it; tab
  // changes write BOTH the local state and the store.
  const storedSubTab = useFilters((s) => s.insightsSubTab);
  const setInsightsSubTab = useFilters((s) => s.setInsightsSubTab);
  const [subTab, setSubTabLocal] = useState<InsightsSubTab>(() => normalizeSubTab(storedSubTab));
  const setSubTab = (tab: InsightsSubTab): void => {
    setSubTabLocal(tab);
    setInsightsSubTab(tab);
  };

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

      {SHOW_SUB_TABS && (
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
          {SUB_TABS.map(({ key, label }) => {
            const on = key === subTab;
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

      {/* Consolidated: JUST the ad-hoc chat (with quick-question pills). The Sprint report card +
          the "Sprint questions" preset carousel folded into it; the attention cards moved to the
          free "Needs attention" rail entry, and Compare to the free "Compare workspaces" one. */}
      <AdHocChatPanel />
    </div>
  );
}
