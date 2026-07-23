import { useEffect, useMemo, useState } from 'react';
import { useFilters, type InsightsSubTab } from '../../store/filters.js';
import { RetroView } from './RetroView.js';
import { AdHocChatPanel } from './AdHocChatPanel.js';
import { TeamComparisonPanel } from './TeamComparisonPanel.js';
import { TrackUsage } from './TrackUsage.js';

// The Pro "Insights" pane. Overview is now a SINGLE consolidated surface: the ad-hoc chat with
// quick-question pills (the former Sprint-report card + the six-question preset carousel were
// folded into the chat — a pill pre-fills the box, the user presses Ask). The attention cards that
// used to sit beneath the AI panels moved to the CORE/free Feed "Needs attention" tab
// (AttentionView). Retro = the retrospective narrative; Compare = the cross-team matrix (All-Teams
// scope only). Everything here self-gates on the activityDigest capability inside its own panel.

// InsightsSubTab lives in the store (filters.ts) — the last-active tab is remembered there. The
// former 'Sprint' sub-tab was folded into Overview, so a stale stored/deep-linked 'sprint'
// redirects to overview.
const SUB_TABS: { key: InsightsSubTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'retro', label: 'Retro' },
];
// The cross-team "Compare" sub-tab is only meaningful (and only shown) in All-Teams scope.
const COMPARE_TAB: { key: InsightsSubTab; label: string } = { key: 'compare', label: 'Compare teams' };

export function InsightsView({
  initialSubTab,
}: {
  initialSubTab?: InsightsSubTab;
} = {}): JSX.Element {
  const teamScope = useFilters((s) => s.teamScope);

  // Internal sub-tab bar (Overview | Retro | Compare). The last-active tab is store-remembered
  // (insightsSubTab) so a remount restores it; a deep-linked initialSubTab (e.g. the legacy 'retro'
  // rail value) wins over the memory. Tab changes write BOTH the local state and the store.
  const storedSubTab = useFilters((s) => s.insightsSubTab);
  const setInsightsSubTab = useFilters((s) => s.setInsightsSubTab);
  const [subTab, setSubTabLocal] = useState<InsightsSubTab>(() => {
    const init = initialSubTab ?? storedSubTab ?? 'overview';
    return init === 'sprint' ? 'overview' : init;
  });
  const setSubTab = (tab: InsightsSubTab): void => {
    setSubTabLocal(tab);
    setInsightsSubTab(tab);
  };
  useEffect(() => {
    if (initialSubTab) setSubTab(initialSubTab);
    // setSubTab is a stable pair of setters re-created per render; only initialSubTab matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSubTab]);

  // The Compare tab exists only in All-Teams scope. Show it there; if the scope leaves 'teams'
  // while it's active, fall back to Overview so the tab strip never strands on a hidden tab.
  const isAllTeams = teamScope === 'teams';
  const subTabs = useMemo(() => (isAllTeams ? [...SUB_TABS, COMPARE_TAB] : SUB_TABS), [isAllTeams]);
  useEffect(() => {
    if (subTab === 'compare' && !isAllTeams) setSubTab('overview');
    // The removed 'Sprint' sub-tab redirects to Overview (where its content now lives).
    else if (subTab === 'sprint') setSubTab('overview');
  }, [subTab, isAllTeams]);

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

      {/* Internal sub-tab bar — Overview / Retro (+ Compare in All-Teams scope). */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {subTabs.map(({ key, label }) => {
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

      {subTab === 'overview' ? (
        // Consolidated: JUST the ad-hoc chat (with quick-question pills). The Sprint report card +
        // the "Sprint questions" preset carousel folded into it; the attention cards moved to the
        // free Feed "Needs attention" tab.
        <AdHocChatPanel />
      ) : subTab === 'compare' ? (
        // Cross-team comparison — only reachable in All-Teams scope (the tab is hidden otherwise).
        <TeamComparisonPanel />
      ) : (
        <RetroView />
      )}
    </div>
  );
}
