import { useEffect, useMemo, useState } from 'react';
import type { ActivityRepo, RepoBranchStatus, ThreadStateCounts } from '@pierre-review/shared';
import { useActivity } from '../../hooks/useActivity.js';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useProCapabilities, useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { openPrsTabCount } from '../../lib/openPrsTab.js';
import { useFilters } from '../../store/filters.js';
import { MaintainerShield } from '../MaintainerShield.js';
import { relativeTime, DERIVED_STATE_META } from '../../lib/ui.js';
import {
  BotIcon,
  PullRequestIcon,
  SparkleIcon,
  TimerIcon,
  WarningIcon,
  WorkspaceIcon,
} from '../Icons.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { BranchStatusChip } from './BranchStatusChip.js';
import { RepoFeedHeader } from './RepoFeedHeader.js';
import { RepoInsightsPanel } from './RepoInsightsPanel.js';
import { RepoOpenPrList } from './RepoOpenPrList.js';
import { FeedView } from './FeedView.js';
import { FeedIsolationBanner } from './FeedIsolationBanner.js';
import { HumanThemesPanel } from './HumanThemesPanel.js';
import { InsightsView } from './InsightsView.js';
import { AttentionView } from './AttentionView.js';
import { BotsView } from './BotsView.js';
import { BotSettingsPanel } from './BotSettingsPanel.js';
import { effectiveFeedTab, feedTabsFor } from './feedTabsModel.js';
import { FirstRunOnboarding } from './FirstRunOnboarding.js';
import { OpenPrsDetail } from './OpenPrsDetail.js';
import { ProBadge } from '../ProGate.js';

// DEFAULT LANDING = OPEN PRS, for every tier. The rail's top entry is what opens: Open PRs is one
// card per open PR (it was a fixed tab of its own until it moved here), and Pending — the ranked
// worklist — is one click below it. The store's plain 'open-prs' default IS the landing, and it
// is the one rail value `useUrlState` leaves out of the URL.

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
// rows, then this WORKSPACE's repos, flat) + a right detail that defaults to Open PRs (the first
// rail line) and narrows to a single-repo console on selection. Entirely on the core query layer —
// no AI. The Pro surfaces are the Bots Monitoring and Reports rail entries (each locked as a
// whole when unentitled) and the per-repo digest banner inside RepoFeedHeader.
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
  // The cross-repo Feed's inner sub-tab: 'feed' (the consolidated stream), the Pro "Discussion
  // themes" AI summary (listed only on the AI-summary tier) and the FREE "Bot classification".
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
  // the rail's third line; the strip heading Open PRs reads this SAME cache entry (an
  // argument-less call there too), and nothing else reads it — not the sort, not attentionCount,
  // not any badge.
  const { data: branchData } = useBranchStatus();
  const branchByRepo = useMemo(
    () => new Map((branchData?.repos ?? []).map((r) => [r.repoId, r])),
    [branchData],
  );
  const { data: allRepos } = useRepos();

  const sorted = useMemo(() => sortRepos(data?.repos ?? []), [data?.repos]);

  // The selected repo (single-repo console). null ⇒ one of the pseudo-rows.
  const selectedRepo =
    typeof activityRepoId === 'number'
      ? sorted.find((r) => r.repoId === activityRepoId) ?? null
      : null;
  // Open PRs is the default detail (also when nothing is set).
  // ('compare' left the activityRepoId union with the Compare rail entry — cross-workspace
  // comparison is Reports' "By workspace" axis now, and a legacy `?activityRepo=compare` link
  // already normalizes to Pending in useUrlState.)
  const showingFeed = activityRepoId === 'feed';
  // Open PRs — one card per open PR in the workspace. The default (null included).
  const showingOpenPrs = activityRepoId === 'open-prs' || activityRepoId == null;
  // The rail line's count: the workspace-wide open-PRs key OpenPrsDetail reads too — one more
  // observer, not a new request. Blank (never 0) until it answers.
  const openPrsQuery = useWorkspaceOpenPrs();
  const openPrsCount = openPrsTabCount(openPrsQuery.data, openPrsQuery.isPlaceholderData);
  // The CORE/free **Pending** cards console — always available, no Pro gate.
  const showingAttention = activityRepoId === 'attention';
  const showingInsights = activityRepoId === 'insights';
  // Bots Monitoring (BotsView) — Pro as a whole on `botDepth`. The RAIL ENTRY is listed on every
  // tier (visible-but-locked); BotsView renders the lock for the whole pane when unentitled.
  const showingBots = activityRepoId === 'bots';

  // (The one-shot "default to Insights when Pro is on" effect lived here — removed with P3.1:
  // Pending is the default landing; see the note at the top.)

  // The cross-repo Feed's sub-tab bar: Feed | Themes (Pro, listed only on `activityDigest`) |
  // Bot classification (FREE on every tier). The rules live in `feedTabsModel.ts`.
  const feedTabs = useMemo(() => feedTabsFor({ activityDigest }), [activityDigest]);
  // DERIVED, never written back to the store: Pro going away must not strand the pane on Themes,
  // and a corrective `setFeedInnerTab` would FORGET the choice so Themes would not come back.
  const visibleFeedTab = effectiveFeedTab(feedInnerTab, feedTabs);

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
          {/* RAIL ORDER, top to bottom: Open PRs · Pending · Feed · Bots · Reports (store value
              still 'insights') — then the per-repo rows BENEATH the whole block. Open PRs leads
              because it is where the app opens; Pending, the ranked worklist, is next.
              The Feed follows as the stream of what happened. Bots sits DIRECTLY under the Feed
              because the two are read together: most of what scrolls past on the Feed is
              bot-authored, and the Feed's own "Bot classification" tab owns the judgement that
              decides what the Feed shows — `hiddenBotUserIds` is the union of `users.isBot` and
              this workspace's automated reviewers, and a manual "human"/"bot" call made there wins
              in both directions. The control that filters the stream belongs next to the stream,
              not three entries away. Reports sits last as the retrospective surface.
              ⚠ Bots Monitoring and Reports are PRO AS A WHOLE: listed on every tier with one
              ProBadge each, their panes locked (ProLockPanel) when unentitled.
              (The "Compare workspaces" entry was folded into Reports' "By workspace" axis.) */}

          {/* OPEN PRS pseudo-row — FIRST, and the default landing: one card per open PR in the
              workspace, headed by the default-branch strip. Was a fixed tab of its own; a legacy
              `?view=open-prs` link lands here. */}
          <button
            type="button"
            onClick={() => setActivityRepo('open-prs')}
            aria-pressed={showingOpenPrs}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingOpenPrs
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Every open pull request in this workspace"
          >
            <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
              <PullRequestIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Open PRs
            </span>
            {openPrsCount != null && (
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
                {openPrsCount}
              </span>
            )}
          </button>

          {/* PENDING pseudo-row — the worklist, SECOND under Open PRs. Everything waiting on you
              or the workspace, in tabs, each ranked by db/work-plan.ts's Do next score
              (db/pending-tabs.ts). CORE/free — the RANK is code, only its narration is Pro — so
              it's ALWAYS shown.
              ⚠ LABEL-ONLY rename from "Needs attention": the rail id stays `'attention'` — it is
              in bookmarks and in history entries Back replays (`?activityRepo=attention`). */}
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
            {/* A STOPWATCH, not a warning triangle. This rail entry is a standing worklist that
                is non-empty on every healthy day, and a warning glyph sitting permanently in the
                navigation asserts a problem that usually isn't there — the icon that means
                "something is wrong" cannot also be the icon that means "here is your queue", or
                it stops meaning either. `TimerIcon` is the existing house stopwatch (auto-merge
                armed, a stalled PR, time-to-first-review): waiting on a clock, which is exactly
                what a pending item is. `WarningIcon` stays in this file for the per-repo
                attention COUNT chip, where a number genuinely is the alarm. */}
            <span className="shrink-0 text-amber-500">
              <TimerIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Pending
            </span>
          </button>

          {/* FEED pseudo-row — SECOND, under Pending. This workspace's consolidated state of play,
              across every repo in it. A Feed link carries `?activityRepo=feed` (it is no longer
              the default). The old "All repos" pseudo-row was removed (redundant with the Feed +
              the per-repo entries below). */}
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

          {/* BOTS MONITORING pseudo-row (LABEL-ONLY rename of "Bots"; the rail id stays 'bots').
              PRO AS A WHOLE (`botDepth`): VISIBLE on every tier with ONE ProBadge here, and the
              whole pane — every sub-tab, Settings included — renders `ProLockPanel` when the
              account is not entitled (BotsView gates itself). No per-sub-tab badges inside.
              Bot HIDING on the Feed and Timeline stays free: it reads the stored/auto
              classification through `/api/bot-reviewers`, which is not gated. */}
          <button
            type="button"
            onClick={() => setActivityRepo('bots')}
            aria-pressed={showingBots}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingBots
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Measure and triage this workspace's review bots (Pro)"
          >
            <span className="shrink-0">
              <BotIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Bots Monitoring
            </span>
            {/* UNCONDITIONAL, like every tier label here: keyed on the capability it would flicker
                on every cold load (capabilities read all-false until /api/me lands). */}
            <ProBadge variant="tab" className="shrink-0" title="Bots Monitoring is part of Pro." />
          </button>

          {/* REPORTS pseudo-row (formerly "Insights" — renamed with plan C5, once the pane became
              Reports-first and the chat moved inside the report). LABEL-ONLY rename: the store
              value stays `activityRepoId === 'insights'` on purpose — it is transient but
              referenced across several files (useUrlState's `?activityRepo=insights`, FilterBar's
              `isInsights`), and renaming a wire/URL-visible token buys nothing but broken deep
              links.
              PRO AS A WHOLE (`periodReports`), flow metrics included: VISIBLE on every tier with
              ONE ProBadge here, and InsightsView renders `ProLockPanel` for the whole pane when
              the account is not entitled. */}
          <button
            type="button"
            onClick={() => setActivityRepo('insights')}
            aria-pressed={showingInsights}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingInsights
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Flow metrics and period reports for this workspace (Pro)"
          >
            <span className="shrink-0 text-ai-signal">
              <WorkspaceIcon />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Reports
            </span>
            <ProBadge variant="tab" className="shrink-0" title="Reports are part of Pro." />
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
      {/* ⚠ `relative` IS LOAD-BEARING: it makes this pane the containing block for its own
          `absolute` descendants. Without it they resolve up to the nearest POSITIONED ancestor,
          which is App.tsx's `absolute inset-0` activity-overlay — so a sticky header or popover
          absolutely positioned deep in here stretched the OVERLAY's scroll height to the full
          content run (measured: 18805px vs 586px with this class present). The overlay then owns
          a phantom scroll range the user cannot scroll back, and any `scrollIntoView` in this
          subtree (the Pending Back-restore flash) clamps into it and pushes the whole screen —
          rail included — off the top. Scrolling belongs to THIS box; nothing above it scrolls. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto p-3">
        {noReposAtAll ? (
          // First-run: detect the viewer's recent repos + one-click add. Hoisted above the
          // rail-entry branches so a zero-repo account always lands here (a Pro account could
          // otherwise auto-select Insights and never reach the empty state).
          <FirstRunOnboarding />
        ) : showingOpenPrs ? (
          // Open PRs — the default landing. Owns its own empty-workspace state.
          <OpenPrsDetail />
        ) : showingBots ? (
          // Bots Monitoring — Pro as a whole; BotsView renders the lock itself. Scoped to the
          // whole active WORKSPACE (never the timeline's repo picker; the bot feed likewise ignores
          // the human-member filter); carries its own empty states, so it renders even before any
          // repo data loads.
          <BotsView />
        ) : showingAttention && !noRepos ? (
          // The CORE/free **Pending** board — the tabs in `PENDING_TABS`, each a scored list with
          // its own count. The default landing. Renders on every tier, before repo data loads (its
          // own empty/loading states); the Pro narration decorates it and is never required for it
          // to be complete. Its narrowings (a seated kind, the banner's "Only yours")
          // show as the selected tab and chip on the board itself, so no banner sits above it.
          // ⚠ `!noRepos`: an EMPTY workspace falls through to the "move some in" guidance below.
          // Pending is where the app opens, so without it a workspace just made in "Manage repos &
          // workspaces" opens on "Nothing is your turn right now." — true, and no help at all.
          // (`noRepos` waits for the repo data, so the board still paints before that loads.)
          <AttentionView />
        ) : showingInsights ? (
          <InsightsView />
        ) : noRepos ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400">
            {hasAnyRepo
              ? 'No repos in this workspace yet. Open "Manage repos & workspaces" in the header to move some in.'
              : 'Detecting the repos you work on…'}
          </div>
        ) : showingFeed ? (
          // The workspace Feed — a STREAM and nothing else. Beside it: a "Discussion themes"
          // sub-tab with Pro (the human sibling of Bots → Themes), and the FREE "Bot
          // classification" tab (who counts as a bot here — the Bots hiding on this Feed reads it).
          //
          // ⚠ Every survey panel has left it and none may come back: the work plan (the Pending
          // head), flow metrics (Reports), the daily-brief strip (DELETED — every line duplicated a
          // Pending tab) and the trunk + open-PR panels (the default-branch strip now heads the Open
          // PRs rail line). Panels of survey above a
          // stream is not a feed.
          <div className="space-y-3">
            <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
              {feedTabs.map((t) => {
                const on = visibleFeedTab === t.key;
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
                    {/* Only Themes is Pro; the Feed and Bot classification are core. */}
                    {t.key === 'themes' && (
                      <span className="rounded bg-ai-signal/10 px-1 text-[11px] font-semibold uppercase text-ai-signal">
                        pro
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {visibleFeedTab === 'themes' ? (
              <HumanThemesPanel />
            ) : visibleFeedTab === 'classification' ? (
              // FREE on every tier — who counts as a bot in this Workspace. The price editor on
              // each card renders only with `botDepth`; nothing else here is gated.
              <BotSettingsPanel />
            ) : (
              <FeedView />
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
