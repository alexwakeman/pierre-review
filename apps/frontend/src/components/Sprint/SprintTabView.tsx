import { useRememberedScroll } from '../../hooks/useRememberedScroll.js';
import { useFilters } from '../../store/filters.js';
import { MergedPrsView } from '../Activity/MergedPrsView.js';
import { SprintView } from '../Activity/SprintView.js';
import { effectiveSprintTab, SPRINT_RAIL_TABS } from '../Activity/sprintRailModel.js';
import { panelId, tabId, Tabs, type TabItem } from '../ui/Tabs.js';
import { PAGE_GUTTER, PageHeader } from '../ui/PageHeader.js';
import type { SprintInnerTab } from '../../store/filters.js';

const TABS: ReadonlyArray<TabItem<SprintInnerTab>> = SPRINT_RAIL_TABS.map((t) => ({ id: t.key, label: t.label }));

// The **This Sprint** TAB (`activeTab === 'sprint'`, `?view=sprint`) — a FIXED tab beside Activity
// (strip order Activity · This Sprint · Timeline). It was an Activity rail line under Pending until
// it was promoted; a legacy `?activityRepo=sprint` lands here, as do the older Reports links
// `?insightsTab=sprint|merged` (useUrlState's landingTabFromUrl):
//   • Theme · Critical path · People — three independent views of the tracker's current sprint, each
//     a lane board over the same status-bucket columns (SprintView → SprintBoards, GET
//     /api/sprint-graph). Theme is the landing panel. The scroll position is remembered per tab
//     (useRememberedScroll). Viewing any of them stamps `sprint_reads.viewed_at`, which is what lets
//     the worker read the sprint at all. "Ask Claude" inside is agentic and LOCAL-ONLY, gated on
//     `me.ai` (useSprintAiOn). A ticket shows its story in the tray beside
//     the board (Sprint/SprintStoryTray.tsx, `?sprintStory=`).
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
  // THE PAGE HEADER (docs/redesign/DESIGN.md § 1): the page title once, then the page's own tabs —
  // the shared `Tabs`, which give 1–4 from anywhere on the page (`numberKeys`). The panel below is
  // labelled by its tab.
  return (
    <div ref={scrollRef} className="pb-10" data-testid="sprint-tab-view">
      <PageHeader title="This Sprint">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="This Sprint views" numberKeys idPrefix="sprint" className="-mx-1 mt-3" />
      </PageHeader>
      <div role="tabpanel" id={panelId('sprint', tab)} aria-labelledby={tabId('sprint', tab)} className={`pt-1 ${PAGE_GUTTER}`}>
        {tab === 'merged' ? <MergedPrsView /> : <SprintView view={tab} />}
      </div>
    </div>
  );
}
