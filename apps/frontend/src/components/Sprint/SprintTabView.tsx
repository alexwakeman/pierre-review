import { useRememberedScroll } from '../../hooks/useRememberedScroll.js';
import { useFilters } from '../../store/filters.js';
import { MergedPrsView } from '../Activity/MergedPrsView.js';
import { SprintView } from '../Activity/SprintView.js';
import { effectiveSprintTab, SPRINT_RAIL_TABS } from '../Activity/sprintRailModel.js';

// The **This Sprint** TAB (`activeTab === 'sprint'`, `?view=sprint`) — a FIXED tab beside Activity
// (strip order Activity · This Sprint · Timeline). It was an Activity rail line under Pending until
// it was promoted; a legacy `?activityRepo=sprint` lands here, as do the older Reports links
// `?insightsTab=sprint|merged` (useUrlState's landingTabFromUrl). FREE on every tier — no ProBadge,
// no ProLockPanel, and none of its routes 402:
//   • Theme · Critical path · People — three independent views of the tracker's current sprint, each
//     a lane board over the same status-bucket columns (SprintView → SprintBoards, GET
//     /api/sprint-graph). Theme is the landing panel. The scroll position is remembered per tab
//     (useRememberedScroll). Viewing any of them stamps `sprint_reads.viewed_at`, which is what lets
//     the worker read the sprint at all. "Ask Claude" inside is agentic and LOCAL-ONLY, gated on
//     `me.ai` (useSprintAiOn), never on a Pro capability. A ticket opens in its story view.
//   • Merged so far — every PR merged in the reporting window (MergedPrsView, GET /api/merged-prs).
//     It needs no tracker.
// ⚠ NO TRACKER ⇒ THE THREE BOARDS SHOW THE SETUP LINE (`SprintTrackerSetup`, drawn by SprintView on
// the graph's own `trackerOn: false`, the server's one liveness test). Merged so far needs no tracker.
// ⚠ THE VISIBLE TAB IS DERIVED, NEVER WRITTEN BACK (`effectiveSprintTab`).
export function SprintTabView(): JSX.Element {
  const raw = useFilters((s) => s.sprintInnerTab);
  const setTab = useFilters((s) => s.setSprintInnerTab);
  const tab = effectiveSprintTab(raw);
  // Back, or re-opening the tab, returns to where the reader was on THIS sub-tab (per session).
  const scrollRef = useRememberedScroll<HTMLDivElement>(`sprint:${tab}`);
  return (
    <div ref={scrollRef} className="space-y-4 p-4" data-testid="sprint-tab-view">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">This Sprint</h2>
      <div role="tablist" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-gray-200 dark:border-gray-800">
        {SPRINT_RAIL_TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.key)}
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
      {tab === 'merged' ? <MergedPrsView /> : <SprintView view={tab} />}
    </div>
  );
}
