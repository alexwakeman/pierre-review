import { useEffect, useMemo, useState } from 'react';
import type { ActivityRepo, RepoBranchStatus, ThreadStateCounts } from '@pierre-review/shared';
import { useActivity } from '../../hooks/useActivity.js';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { MaintainerShield } from '../MaintainerShield.js';
import { relativeTime, DERIVED_STATE_META } from '../../lib/ui.js';
import { BotIcon, SparkleIcon, WarningIcon, WorkspaceIcon } from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { BranchStatusChip } from './BranchStatusChip.js';
import { BranchStatusPanel } from './BranchStatusPanel.js';
import { RepoFeedHeader } from './RepoFeedHeader.js';
import { RepoInsightsPanel } from './RepoInsightsPanel.js';
import { RepoOpenPrList } from './RepoOpenPrList.js';
import { BriefStrip } from './BriefStrip.js';
import { FeedView } from './FeedView.js';
import { FeedIsolationBanner } from './FeedIsolationBanner.js';
import { HumanThemesPanel } from './HumanThemesPanel.js';
import { InsightsView } from './InsightsView.js';
import { AttentionView } from './AttentionView.js';
import { AttentionIsolationBanner } from './AttentionIsolationBanner.js';
import { BotsView } from './BotsView.js';
import { FirstRunOnboarding } from './FirstRunOnboarding.js';

// DEFAULT LANDING = THE FEED, for every tier (plan P3.1). There used to be a one-shot
// module-scoped effect here that auto-selected the Reports/Insights rail entry when Pro was on
// (`insightsDefaultApplied` + `suppressInsightsDefault()`, which the Welcome-back banner had to
// call to keep its own 'feed' navigation from being clobbered) — chosen when Insights was the
// daily chat surface. Post-C5 that pane is a fortnightly ARTIFACT (Reports), and the daily
// surface is the Feed with the BriefStrip on top, so the store's plain 'feed' default IS the
// landing and the whole apparatus is gone. Reports stays one click away on the rail.

// Rail sort: attention desc → unread → alphabetical. Computed once per data load so
// the rail is stable (not jumpy) as the user interacts.
function sortRepos(repos: ActivityRepo[]): ActivityRepo[] {
  return [...repos].sort((a, b) => {
    if (b.attentionCount !== a.attentionCount) return b.attentionCount - a.attentionCount;
    if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
    return a.repoFullName.localeCompare(b.repoFullName);
  });
}

// A tick that re-renders every 30s so the "generated N ago" staleness label stays
// fresh without refetching.
function useStalenessTick(): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
}

function RailRow({
  fullName,
  maintainerCount,
  hasUnread,
  attentionCount,
  openPrs,
  threadTotals,
  branch,
  selected,
  onSelect,
}: {
  fullName: string;
  maintainerCount: number;
  hasUnread: boolean;
  attentionCount: number;
  openPrs: number | null;
  threadTotals: ThreadStateCounts | null;
  // The repo's default-branch snapshot, or null when it has never been branch-synced.
  // Informational only — it deliberately does NOT participate in the rail sort.
  branch: RepoBranchStatus | null;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  // The metrics line is suppressed entirely while only the repo name is known (the
  // name-only loading fallback), so there's no empty second row.
  const hasMetrics = threadTotals != null || hasUnread || attentionCount > 0 || openPrs != null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      // A repo belongs to EXACTLY ONE workspace and the rail only ever shows that one workspace,
      // so there is nothing left for a per-row accent colour to disambiguate: the sky border is
      // the only border state, and it means "this is the open repo".
      className={`flex w-56 shrink-0 flex-col gap-0.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
        selected
          ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
    >
      {/* line 1: repo name */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
          {fullName}
        </span>
        {maintainerCount > 0 && <MaintainerShield />}
      </span>
      {/* line 2: metrics, only once loaded */}
      {hasMetrics && (
        <span className="flex items-center gap-1.5 pl-0.5">
          {hasUnread && (
            <span
              aria-hidden="true"
              title="New activity"
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
            />
          )}
          {threadTotals != null && <ThreadStateBar counts={threadTotals} compact />}
          {attentionCount > 0 && (
            <span
              className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
              title="PRs needing attention"
            >
              <WarningIcon size={10} className="mr-0.5 inline-block align-[-0.1em]" />
              {attentionCount}
            </span>
          )}
          <span className="ml-auto shrink-0 tabular-nums text-gray-400">
            {openPrs == null ? '' : openPrs > 0 ? `[${openPrs}]` : '[—]'}
          </span>
        </span>
      )}
      {/* line 3: default-branch readout (branch · CI dot · last commit). Self-hides until the
          repo has been branch-synced, so the row keeps its two-line shape on a fresh account. */}
      <BranchStatusChip status={branch} className="pl-0.5" />
    </button>
  );
}

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
      <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        {(['activity', 'bots'] as const).map((t) => {
          const on = tab === t;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setRepoConsoleTab(repo.repoId, t)}
              className={`-mb-px flex items-center gap-1 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                on
                  ? 'border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200'
                  : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
              }`}
            >
              {t === 'bots' && <BotIcon />}
              {t === 'activity' ? 'Activity' : 'Bots'}
            </button>
          );
        })}
      </div>
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

// The Activity "Triage Console with a Briefing Feed": a fixed left rail (the cross-repo pseudo-
// rows, then this WORKSPACE's repos, flat) + a right detail that defaults to the consolidated
// Feed and narrows to a single-repo console on selection. Entirely on the core query layer — no
// AI (the only Pro surfaces are the Insights rail entry and the per-repo digest banner inside
// RepoFeedHeader).
//
// SCOPE IS ONE WORKSPACE, always — the WHOLE workspace. There is no "all repos", no multi-select,
// and (deliberately) NO second visibility axis on top: this console reads `filters.workspaceId` and
// nothing else. The FilterBar's per-repo show/hide (`repoIds`) is a TIMELINE-board filter and is
// not even mounted while Activity is the active tab; narrowing here is the RAIL's job — clicking a
// repo row switches to that repo's console (`activityRepoId`), which is a different mechanism with
// a visible, obvious control. (The old "Compare workspaces" rail entry — the one entry that
// stepped outside the workspace — was folded into Reports as the "By workspace" axis; see
// PeriodReportsPanel.)
export function ActivityView(): JSX.Element {
  useStalenessTick();
  const workspaceId = useFilters((s) => s.workspaceId);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const { workspaceInsights, activityDigest } = useProCapabilities();
  // The cross-repo Feed's inner sub-tab: 'feed' (metrics + consolidated feed) vs the Pro
  // "Discussion themes" AI summary. The Themes tab only appears when the AI-summary tier is on.
  // ('compare' is NOT a member — cross-workspace comparison is Reports' "By workspace" axis.)
  const feedInnerTab = useFilters((s) => s.feedInnerTab);
  const setFeedInnerTab = useFilters((s) => s.setFeedInnerTab);
  // Scope is the ACTIVE WORKSPACE — the whole of it. Both narrowing arguments are NULL on purpose,
  // and they are null for the SAME reason: each is a TIMELINE-only filter that this console does
  // not show and therefore must not honour. `repoIds: null` means "every repo in this workspace",
  // which only the server can expand, hence the workspace id travelling beside it; `userIds: null`
  // is the long-standing Members rule. Passing the store's `repoIds` here is the bug this reads as
  // a fix for — the picker is unmounted on Activity, so its effect would be invisible and
  // unclearable from this screen. While `workspaceId` is still null (the workspaces query hasn't
  // landed) the hook is disabled: nothing workspace-scoped may render against a guessed scope.
  const { data, isFetching, isLoading } = useActivity(workspaceId, null, null);
  // Default-branch status for the SAME scope. `useBranchStatus` reads the workspace from the store
  // and narrows ONLY on an explicit argument, so an argument-less call here is the whole workspace
  // by construction and can never drift from useActivity's scope. Purely informational: it feeds
  // the rail's third line and the Feed strip, and nothing else — not the sort, not attentionCount,
  // not any badge.
  const { data: branchData } = useBranchStatus();
  const branchByRepo = useMemo(
    () => new Map((branchData?.repos ?? []).map((r) => [r.repoId, r])),
    [branchData],
  );
  const { data: allRepos } = useRepos();

  const sorted = useMemo(() => sortRepos(data?.repos ?? []), [data?.repos]);

  // The selected repo (single-repo console). null ⇒ the Feed pseudo-row.
  const selectedRepo =
    typeof activityRepoId === 'number'
      ? sorted.find((r) => r.repoId === activityRepoId) ?? null
      : null;
  // The cross-repo consolidated Feed is the default detail (also when nothing's set).
  // ('compare' left the activityRepoId union with the Compare rail entry — cross-workspace
  // comparison is Reports' "By workspace" axis now, and a legacy `?activityRepo=compare` link
  // already normalizes to the Feed in useUrlState.)
  const showingFeed = activityRepoId === 'feed' || activityRepoId == null;
  // The CORE/free **Pending** cards console — always available, no Pro gate.
  const showingAttention = activityRepoId === 'attention';
  const showingInsights = activityRepoId === 'insights';
  // The CORE/free review-bot triage console (BotsView) — always available (reads the core bot
  // routes), independent of the Pro Insights caps.
  const showingBots = activityRepoId === 'bots';

  // (The one-shot "default to Insights when Pro is on" effect lived here — removed with P3.1:
  // the Feed, brief on top, is the default landing for every tier. See the note at the top.)

  // The cross-repo Feed's sub-tab bar: Feed | Themes(Pro). Still built dynamically so a tab
  // exists only where it means something — Themes needs the Pro AI tier. ("Compare teams" left
  // this bar long ago; cross-workspace comparison is Reports' "By workspace" axis now.)
  const feedTabs = useMemo(() => {
    const tabs: { key: 'feed' | 'themes'; label: string }[] = [{ key: 'feed', label: 'Feed' }];
    if (activityDigest) tabs.push({ key: 'themes', label: 'Themes' });
    return tabs;
  }, [activityDigest]);
  // DERIVED, never written back to the store. Pro going away must not strand the pane on a tab
  // that no longer exists — but a corrective `setFeedInnerTab` would also FORGET the user's
  // choice, so the capability returning wouldn't restore Themes. Falling back for the render only
  // keeps the choice intact.
  const effectiveFeedTab = feedTabs.some((t) => t.key === feedInnerTab) ? feedInnerTab : 'feed';

  const generatedAt = data?.generatedAt ?? null;

  // Rail items: the loaded repos, or a name-only fallback from useRepos while the first aggregate
  // is loading (so names paint instantly).
  //
  // The fallback narrows to the ACTIVE WORKSPACE and to nothing else — the same bound the server
  // will apply a moment later, so the rail does not visibly reshuffle when the aggregate lands.
  // `useRepos()` is the ACCOUNT's repo list (it is not workspace-scoped), and `Repo.workspaceId` is
  // a database fact on the row precisely so a client surface holding only repo ids can answer
  // "which workspace is this?" without guessing. It deliberately does NOT consult
  // `filters.repoIds`: that is a timeline-board filter, so honouring it here would make the rail
  // disagree with the aggregate that replaces it a frame later.
  type RailItem = {
    repoId: number;
    fullName: string;
    maintainerCount: number;
    hasUnread: boolean;
    attentionCount: number;
    openPrs: number | null;
    threadTotals: ThreadStateCounts | null;
  };
  const fallbackRepos =
    workspaceId == null
      ? []
      : (allRepos ?? []).filter((r) => r.workspaceId === workspaceId);
  const railItems: RailItem[] =
    data != null
      ? sorted.map((r) => ({
          repoId: r.repoId,
          fullName: r.repoFullName,
          maintainerCount: r.maintainerIds.length,
          hasUnread: r.hasUnread,
          attentionCount: r.attentionCount,
          openPrs: r.stats.openPrs,
          threadTotals: r.threadTotals,
        }))
      : fallbackRepos.map((r) => ({
          repoId: r.id,
          fullName: r.fullName,
          maintainerCount: 0,
          hasUnread: false,
          attentionCount: 0,
          openPrs: null,
          threadTotals: null,
        }));

  // The repo id IS the key: a repo belongs to exactly one workspace and the rail shows one
  // workspace, so a repo appears exactly once. (It used to be a caller-supplied
  // `${teamId}:${repoId}` composite, because a repo shared by two teams rendered once per group.)
  const renderRailRow = (r: RailItem): JSX.Element => (
    <RailRow
      key={String(r.repoId)}
      fullName={r.fullName}
      maintainerCount={r.maintainerCount}
      hasUnread={r.hasUnread}
      attentionCount={r.attentionCount}
      openPrs={r.openPrs}
      threadTotals={r.threadTotals}
      branch={branchByRepo.get(r.repoId) ?? null}
      selected={activityRepoId === r.repoId}
      onSelect={() => setActivityRepo(r.repoId)}
    />
  );

  // The console is scoped to the WORKSPACE's repos, so an empty console has two distinct causes:
  // no repos on the account at all, vs. repos that all live in OTHER workspaces. The remedy
  // differs (add a repo vs. move one in), so distinguish them in the empty state below.
  // ("Watched" is gone as a concept — every repo in a workspace is fully live.)
  const noRepos = data != null && sorted.length === 0;
  const hasAnyRepo = (allRepos ?? []).length > 0;
  // A genuine FIRST-RUN account: the repos list has LOADED and is empty (distinct from
  // "still loading", where allRepos is undefined — we mustn't flash onboarding then). When
  // true, first-run onboarding replaces the whole console body REGARDLESS of the selected rail
  // entry (a zero-repo account must always reach it — bots/insights could otherwise win).
  const reposLoaded = allRepos != null;
  const noReposAtAll = reposLoaded && !hasAnyRepo;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* LEFT RAIL */}
      <div className="flex flex-col border-b border-gray-200 md:w-72 md:shrink-0 md:border-b-0 md:border-r dark:border-gray-800">
        {/* No manual Refresh: the console tracks the workspace's repo set live — add/move/sync all
            invalidate the Activity/Insights queries (ACTIVITY_QUERY_KEYS), and newly-arrived feed
            items are INSERTED as they land, each carrying a per-card "New" chip until the reader
            has seen it (`feedNewCohorts`) — so there is nothing to refresh by hand. (That chip
            replaced a feed-wide "New activity — Refresh" banner, which asked the reader to
            perform the update the feed can do itself.) */}
        {/* The workspace selector + "Manage repos & workspaces" live in the header's
            WorkspaceSelector (shown on every view), so the rail carries no header of its own. */}
        {generatedAt != null && (
          <div
            className="px-3 py-1 text-[10px] text-gray-400"
            title={new Date(generatedAt).toLocaleString()}
          >
            {relativeTime(generatedAt)}
          </div>
        )}

        {/* Progress hairline while refetching (keep last data, never blank). */}
        {isFetching && data != null && (
          <div className="h-0.5 w-full overflow-hidden bg-sky-100 dark:bg-sky-950">
            <div className="h-full w-1/3 animate-pulse bg-sky-500" />
          </div>
        )}

        <div
          className={`flex gap-1 overflow-x-auto p-2 md:min-h-0 md:flex-1 md:flex-col md:overflow-x-visible md:overflow-y-auto ${
            isFetching && data != null ? 'opacity-60 transition-opacity' : ''
          }`}
        >
          {/* RAIL ORDER, top to bottom: Feed · Pending · Bots · Reports (store value still
              'insights') — then the per-repo rows BENEATH the whole block. The two DAILY surfaces
              lead: the Feed is the default landing, and Pending is the worklist that absorbed the
              "Plan for today" panel. Reports sits last as the retrospective surface.
              ⚠ ALL FOUR ARE NOW UNGATED. Reports used to be first AND Pro-gated, from when it was
              nothing but the Pro period report; the FREE flow metrics moved into it off the Feed,
              so hiding the entry would have taken a free feature behind the Pro wall.
              (The "Compare workspaces" entry was folded into Reports' "By workspace" axis.) */}

          {/* FEED pseudo-row — this workspace's consolidated state of play, across every repo in
              it. The old "All repos" pseudo-row was removed (redundant with the Feed + the
              per-repo entries below). */}
          <button
            type="button"
            onClick={() => setActivityRepo('feed')}
            aria-pressed={showingFeed}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingFeed
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="One chronological stream across every repo in this workspace"
          >
            <span className="shrink-0 text-sky-500">
              <SparkleIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Feed
            </span>
          </button>

          {/* PENDING pseudo-row — the worklist. Everything waiting on you or the workspace, in
              ONE list, led by the ranked "Do next" head (`doNextIds`, scored by db/work-plan.ts).
              CORE/free — the RANK is code, only its narration is Pro — so it's ALWAYS shown.
              ⚠ LABEL-ONLY rename from "Needs attention": the rail id stays `'attention'`, because
              an unknown `?activityRepo=` value falls into the parseInt branch, yields NaN and
              lands the reader on the Feed, breaking Back on same-session history entries.
              Second in the rail, directly under the Feed: it absorbed the "Plan for today" panel
              that used to sit on the Feed, so it is now a DAILY surface rather than an
              occasional one. */}
          <button
            type="button"
            onClick={() => setActivityRepo('attention')}
            aria-pressed={showingAttention}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingAttention
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Everything waiting on you or your workspace, ranked most actionable first (free)"
          >
            <span className="shrink-0 text-amber-500">
              <WarningIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Pending
            </span>
          </button>

          {/* BOTS pseudo-row — "the calm layer above your review bots". CORE/free (reads the
              deterministic bot routes), so it's ALWAYS shown, on every tier, no Pro gate. A bot is
              one object per WORKSPACE: a vendor running in six of this workspace's repos is ONE
              row here, and everything about it — automated, role, vendor name, price — is edited
              at this level. */}
          <button
            type="button"
            onClick={() => setActivityRepo('bots')}
            aria-pressed={showingBots}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingBots
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Detect, measure and triage this workspace's automated review bots (free)"
          >
            <span className="shrink-0">
              <BotIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Bots
            </span>
          </button>

          {/* REPORTS pseudo-row (formerly "Insights" — renamed with plan C5, once the pane became
              Reports-first and the chat moved inside the report). LABEL-ONLY rename: the store
              value stays `activityRepoId === 'insights'` on purpose — it is transient but
              referenced across several files (useUrlState's `?activityRepo=insights`, FilterBar's
              `isInsights`), and renaming a wire/URL-visible token buys nothing but broken deep
              links.
              ⚠ SHOWN ON EVERY TIER. It used to be wrapped in `{workspaceInsights && …}`, correct
              while the pane was nothing but the Pro period report — but the FREE flow metrics
              moved in here off the Feed, so hiding the entry would have taken a free feature
              behind the Pro wall. The pane gates its own Pro halves internally. */}
          <button
            type="button"
            onClick={() => setActivityRepo('insights')}
            aria-pressed={showingInsights}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingInsights
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Flow metrics for this workspace, and period-over-period reports (Pro)"
          >
            <span className="shrink-0 text-ai-signal">
              <WorkspaceIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Reports
            </span>
          </button>

          {/* The workspace's repos — a FLAT list. There is nothing to group by: a repo belongs to
              exactly ONE workspace (a database fact, `workspace_repos` UNIQUE (account, repo)) and
              exactly one workspace is ever in scope. The per-team headers, their identity colour
              dots, the shared-repo duplicate rows and the "Other" bucket for unassigned repos are
              all gone with the many-to-many that created them. */}
          {railItems.map((r) => renderRailRow(r))}

          {/* Legend (hidden on the narrow chip strip) */}
          <div className="mt-auto hidden flex-wrap gap-x-3 gap-y-0.5 px-1 pt-3 md:flex">
            {(['untouched', 'replied_unresolved', 'likely_addressed', 'resolved'] as const).map(
              (k) => (
                <span
                  key={k}
                  className="flex items-center gap-1 text-[10px] text-gray-400"
                  title={DERIVED_STATE_META[k].description}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: DERIVED_STATE_META[k].color }}
                  />
                  {DERIVED_STATE_META[k].label.toLowerCase()}
                </span>
              ),
            )}
          </div>
        </div>
      </div>

      {/* RIGHT DETAIL */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {noReposAtAll ? (
          // First-run: detect the viewer's recent repos + one-click add. Hoisted above the
          // rail-entry branches so a zero-repo account always lands here (a Pro account could
          // otherwise auto-select Insights and never reach the empty state).
          <FirstRunOnboarding />
        ) : showingBots ? (
          // The CORE/free review-bot triage console (ROI panel + a bot-only feed). Scoped to the
          // whole active WORKSPACE (never the timeline's repo picker; the bot feed likewise ignores
          // the human-member filter); carries its own empty states, so it renders even before any
          // repo data loads.
          <BotsView />
        ) : showingAttention ? (
          // The CORE/free **Pending** board — every card kind in one list, led by the ranked
          // "Do next" head. Renders on every tier, before repo data loads (its own empty/loading
          // states); the Pro narration decorates it and is never required for it to be complete.
          //
          // The banner above it carries the board's two narrowings — the single KIND set by the
          // daily brief's lines, and the PERSONAL lens set by the notification surfaces — each
          // with its own way out. It is the attention-board twin of FeedIsolationBanner (which is
          // mounted only on the per-repo console + the fallback branch, never here), and renders
          // null when neither is on.
          <div className="space-y-3">
            <AttentionIsolationBanner />
            <AttentionView />
          </div>
        ) : showingInsights ? (
          <InsightsView />
        ) : noRepos ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400">
            {hasAnyRepo
              ? 'No repos in this workspace yet. Open "Manage repos & workspaces" in the header to move some in.'
              : 'Detecting the repos you work on…'}
          </div>
        ) : showingFeed ? (
          // The workspace Feed — a STREAM, and now only a stream. With Pro on, a "Discussion
          // themes" sub-tab (the human sibling of Bots → Themes) sits beside it.
          //
          // ⚠ TWO PANELS LEFT THIS BRANCH and neither was deleted; do not re-add either here.
          // The "Plan for today" card became the Pending board's ranked head (one population, one
          // surface), and the flow-metric header moved to Reports, where analytics belongs and
          // where the period framing gives the numbers a denominator. What is left is the brief
          // strip, the trunk chip and the feed — which is the point: three panels of survey above
          // a stream is not a feed.
          <div className="space-y-3">
            {feedTabs.length > 1 && (
              <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
                {feedTabs.map((t) => {
                  const on = effectiveFeedTab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => setFeedInnerTab(t.key)}
                      className={`-mb-px flex items-center gap-1 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
                        on
                          ? 'border-gray-300 bg-white text-sky-600 dark:border-gray-700 dark:bg-gray-950 dark:text-sky-300'
                          : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900/60'
                      }`}
                    >
                      {t.label}
                      {/* Only Themes is Pro; the Feed itself is core. */}
                      {t.key === 'themes' && (
                        <span className="rounded bg-ai-signal/10 px-1 text-[9px] font-semibold uppercase text-ai-signal">
                          pro
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {effectiveFeedTab === 'themes' ? (
              <HumanThemesPanel />
            ) : (
              <>
                {/* The daily brief (P3.1/P3.3) — the morning's "what needs me" in one strip,
                    each line deep-linking to its owning surface. THE one mount (this branch
                    renders exactly once — the numeric-fallback FeedView below deliberately
                    doesn't carry it, and per-repo consoles never do). Self-hides at all-zero. */}
                <BriefStrip />
                {/* "Is trunk green?" across every repo in scope — a red default branch
                    invalidates every open PR's CI at once and is the first thing worth knowing.
                    Read-only; self-hides until branch-synced, and collapses to a one-line chip
                    while every branch is clear. */}
                <BranchStatusPanel />
                <FeedView />
              </>
            )}
          </div>
        ) : isLoading && data == null ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40"
              />
            ))}
          </div>
        ) : selectedRepo != null ? (
          // Keyed by repoId so switching repos remounts the console cleanly; its Activity|Bots
          // sub-tab is store-remembered per repo (repoConsoleTabs), so the remount restores it.
          <RepoConsole key={selectedRepo.repoId} repo={selectedRepo} />
        ) : (
          // A numeric repo id that didn't resolve (e.g. removed, or moved to another workspace so
          // it's absent from this workspace's aggregate) — fall back to the cross-repo Feed, still
          // surfacing the "Showing only #N" banner + Clear when a PR is isolated here.
          <div className="space-y-3">
            <FeedIsolationBanner />
            <FeedView />
          </div>
        )}
      </div>
    </div>
  );
}
