import type { ActivityRepo } from '@pierre-review/shared';
import { useActivity } from '../../hooks/useActivity.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { BotIcon, GearIcon } from '../Icons.js';
import { Tabs } from '../ui/Tabs.js';
import { openWorkspaceManager } from '../WorkspaceSelector.js';
import { RepoFeedHeader } from './RepoFeedHeader.js';
import { RepoInsightsPanel } from './RepoInsightsPanel.js';
import { RepoOpenPrList } from './RepoOpenPrList.js';
import { FeedView } from './FeedView.js';
import { FeedIsolationBanner } from './FeedIsolationBanner.js';
import { InsightsView } from './InsightsView.js';
import { DocsView } from './DocsView.js';
import { AttentionView } from './AttentionView.js';
import { BotsView } from './BotsView.js';
import { FirstRunOnboarding } from './FirstRunOnboarding.js';
import { OpenPrsDetail } from './OpenPrsDetail.js';

// DEFAULT LANDING = OPEN PRS, for every tier. The rail's top entry is what opens: Open PRs is one
// card per open PR (it was a fixed tab of its own until it moved here), and Pending — the ranked
// worklist — is one click below it. The store's plain 'open-prs' default IS the landing, and it
// is the one rail value `useUrlState` leaves out of the URL.

// One repo's console, with an Activity | Bots sub-tab strip. Activity is the default (repo
// digest header + per-repo Insights + open-PR list + the repo feed); Bots is the per-repo
// replica of the cross-repo Bots rail (BotsView scoped to this repo — its ROI panel, charts
// and bot-only feed all narrow to this repo, and only bots active here surface). Mounted keyed
// by repoId (see the caller); the active sub-tab is store-remembered PER REPO
// (repoConsoleTabs), so rail switches / pr-detail Back / Timeline round-trips — all of which
// unmount this — restore the last-active tab instead of resetting to Activity.
function RepoConsole({ repo }: { repo: ActivityRepo }): JSX.Element {
  const tab = useFilters((s) => s.repoConsoleTabs[repo.repoId] ?? 'activity');
  const setRepoConsoleTab = useFilters((s) => s.setRepoConsoleTab);
  // When the feed is isolated to a single PR ("Showing only #N"), the console becomes a focused
  // single-PR view: the repo-wide charts + open-PR list are noise, so they're hidden, and the
  // isolation banner sits right under the repo summary header.
  const isolated = useFilters((s) => s.feedIsolatedPrId != null);
  return (
    <div className="space-y-3" data-testid="repo-console">
      <Tabs
        label="Repository views"
        value={tab}
        onChange={(t) => setRepoConsoleTab(repo.repoId, t)}
        tabs={[
          { id: 'activity', label: 'Activity' },
          { id: 'bots', label: 'Bots', icon: <BotIcon size={13} /> },
        ]}
      />
      {tab === 'activity' ? (
        <>
          <RepoFeedHeader repo={repo} />
          {/* "Showing only #N" sits directly UNDER the repo summary header (not floating).
              Self-hides when nothing is isolated. */}
          <FeedIsolationBanner />
          {!isolated && (
            <>
              {/* Per-repo Insights — the Insights Overview replicated for this ONE repo: the
                  DORA-ish tile row (NON-clickable) + primary trend charts + a "More charts"
                  button that reveals the full per-repo charts grid inline. HIDDEN in the
                  single-PR isolated view (repo-wide charts are noise there). */}
              <RepoInsightsPanel repoId={repo.repoId} repoFullName={repo.repoFullName} />
              {/* All the repo's open PRs (at-a-glance metrics) BEFORE its activity feed —
                  also HIDDEN when isolated to a single PR. */}
              <RepoOpenPrList repoId={repo.repoId} prs={repo.prs} />
            </>
          )}
          <FeedView repoId={repo.repoId} />
        </>
      ) : (
        <BotsView repoId={repo.repoId} />
      )}
    </div>
  );
}

// THE ACTIVITY PANE: whichever Activity destination is selected — Open PRs (the default), Pending,
// Docs, the Feed, Reports, Bots Monitoring, or one repo's console. Entirely on the core query layer.
//
// ⚠ THE RAIL THAT USED TO SIT ON ITS LEFT IS THE SIDEBAR NOW (components/shell/Sidebar.tsx): the
// destination rows, each repo's row (name, shield, unread dot, thread bar, attention count, open
// PRs, default-branch line), the legend (behind the ⓘ beside "Repositories"), the "generated N ago"
// stamp and the refetch hairline. What stays here is the routing on `filters.activityRepoId`.
//
// SCOPE IS ONE WORKSPACE, always — the WHOLE workspace. There is no "all repos", no multi-select,
// and (deliberately) NO second visibility axis on top: this pane reads `filters.workspaceId` and
// nothing else. The Timeline's per-repo show/hide (`repoIds`) is a TIMELINE-board filter and is not
// even mounted here; narrowing to a repo is the sidebar's job (its repo rows open a console).
export function ActivityView(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  // Scope is the ACTIVE WORKSPACE — the whole of it. Both narrowing arguments are NULL on purpose:
  // each is a TIMELINE-only filter this pane does not show and therefore must not honour. While
  // `workspaceId` is still null the hook is disabled: nothing workspace-scoped may render against a
  // guessed scope. (The sidebar's Repositories group reads this SAME key.)
  const { data, isLoading } = useActivity(workspaceId, null, null);
  const { data: allRepos } = useRepos();

  // The selected repo (single-repo console). null ⇒ one of the destinations.
  const selectedRepo: ActivityRepo | null =
    typeof activityRepoId === 'number'
      ? ((data?.repos ?? []).find((r) => r.repoId === activityRepoId) ?? null)
      : null;
  const showingFeed = activityRepoId === 'feed';
  // Open PRs — one card per open PR in the workspace. The default (null included). A legacy
  // `?view=open-prs` link lands here.
  const showingOpenPrs = activityRepoId === 'open-prs' || activityRepoId == null;
  // ⚠ The store and URL value stays `'attention'` for Pending — it is in bookmarks and in history
  // entries Back replays (`?activityRepo=attention`).
  const showingAttention = activityRepoId === 'attention';
  // ⚠ And `'insights'` for Reports (a LABEL-only rename).
  const showingInsights = activityRepoId === 'insights';
  // Docs — the sidebar shows it only where agentic AI runs; a `?activityRepo=docs` link opened
  // elsewhere still selects the pane, which then says in one line why there is nothing to show.
  const showingDocs = activityRepoId === 'docs';
  const showingBots = activityRepoId === 'bots';

  // The pane is scoped to the WORKSPACE's repos, so an empty pane has two distinct causes: no repos
  // on the account at all, vs. repos that all live in OTHER workspaces. The remedy differs (add a
  // repo vs. move one in), so the empty state below tells them apart.
  const noRepos = data != null && data.repos.length === 0;
  const hasAnyRepo = (allRepos ?? []).length > 0;
  // A genuine FIRST-RUN account: the repos list has LOADED and is empty (distinct from "still
  // loading", where allRepos is undefined — we mustn't flash onboarding then). First-run onboarding
  // then replaces the whole pane REGARDLESS of the selected destination.
  const noReposAtAll = allRepos != null && !hasAnyRepo;

  return (
    // ⚠ `relative` IS LOAD-BEARING: it makes this pane the containing block for its own `absolute`
    // descendants. Without it they resolve up to App.tsx's `absolute inset-0` activity-overlay, so
    // a sticky header or popover deep in here stretched the OVERLAY's scroll height to the full
    // content run (measured: 18805px vs 586px with this class present) — a phantom scroll range
    // the user cannot scroll back, into which any `scrollIntoView` (the Pending Back-restore flash)
    // clamps and pushes the whole screen off the top. Scrolling belongs to THIS box.
    <div className="relative h-full min-h-0 overflow-y-auto p-3 md:p-4">
      {noReposAtAll ? (
        // First-run: detect the viewer's recent repos + one-click add.
        <FirstRunOnboarding />
      ) : showingOpenPrs ? (
        // Open PRs — the default landing. Owns its own empty-workspace state.
        <OpenPrsDetail />
      ) : showingBots ? (
        // Bots Monitoring, scoped to the whole active WORKSPACE; carries its own empty states.
        <BotsView />
      ) : showingAttention && !noRepos ? (
        // The **Pending** board. ⚠ `!noRepos`: an EMPTY workspace falls through to the "move some
        // in" guidance below rather than "Nothing is your turn right now." — true, and no help.
        <AttentionView />
      ) : showingInsights ? (
        <InsightsView />
      ) : showingDocs ? (
        // Docs — the reference library. Needs no repos; owns its own empty and AI-off states.
        <DocsView />
      ) : noRepos ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-body text-ui-mute">
          {hasAnyRepo ? (
            <>
              <p>No repos in this workspace yet. Move some in from Manage repos &amp; workspaces, in the workspace menu at the top of the sidebar.</p>
              <button
                type="button"
                onClick={openWorkspaceManager}
                className="inline-flex h-8 items-center gap-2 rounded-ui bg-ui-raise px-3 text-body font-medium text-ui-ink hover:bg-ui-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-11"
              >
                <GearIcon size={13} />
                Manage repos &amp; workspaces
              </button>
            </>
          ) : (
            <p>Detecting the repos you work on…</p>
          )}
        </div>
      ) : showingFeed ? (
        // The workspace Feed — a STREAM and nothing else, with no sub-tabs (bot classification is
        // Bots Monitoring → Classification). ⚠ No survey panel may come back above it.
        <FeedView />
      ) : isLoading && data == null ? (
        // Skeletons at the real card height while the first aggregate loads.
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-ui bg-ui-surface motion-safe:animate-pulse" />
          ))}
        </div>
      ) : selectedRepo != null ? (
        // Keyed by repoId so switching repos remounts the console cleanly; its Activity|Bots sub-tab
        // is store-remembered per repo (repoConsoleTabs), so the remount restores it.
        <RepoConsole key={selectedRepo.repoId} repo={selectedRepo} />
      ) : (
        // A numeric repo id that didn't resolve (removed, or moved to another workspace) — fall
        // back to the cross-repo Feed, still surfacing "Showing only #N" + Clear when isolated.
        <div className="space-y-3">
          <FeedIsolationBanner />
          <FeedView />
        </div>
      )}
    </div>
  );
}
