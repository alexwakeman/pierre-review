import { useEffect, useMemo, useState } from 'react';
import type { ActivityRepo, RepoBranchStatus, ThreadStateCounts } from '@pierre-review/shared';
import { useActivity } from '../../hooks/useActivity.js';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useTeams } from '../../hooks/useTeams.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters, isMultiTeamScope, scopeToParam, teamIdsInScope } from '../../store/filters.js';
import { MaintainerShield } from '../MaintainerShield.js';
import { relativeTime, DERIVED_STATE_META } from '../../lib/ui.js';
import { buildTeamColorMap, teamColorFor } from '../../lib/teamColors.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { BranchStatusChip } from './BranchStatusChip.js';
import { BranchStatusPanel } from './BranchStatusPanel.js';
import { RepoFeedHeader } from './RepoFeedHeader.js';
import { RepoInsightsPanel } from './RepoInsightsPanel.js';
import { RepoOpenPrList } from './RepoOpenPrList.js';
import { FeedView } from './FeedView.js';
import { FeedIsolationBanner } from './FeedIsolationBanner.js';
import { FeedMetricsPanel } from './FeedMetricsPanel.js';
import { HumanThemesPanel } from './HumanThemesPanel.js';
import { TeamComparisonPanel } from './TeamComparisonPanel.js';
import { InsightsView } from './InsightsView.js';
import { AttentionView } from './AttentionView.js';
import { BotsView } from './BotsView.js';
import { FirstRunOnboarding } from './FirstRunOnboarding.js';

// One-shot per page load: when Pro Insights is available, it becomes the DEFAULT landing
// rail entry (and it's rendered first). Module-scoped so it survives ActivityView
// remounts (switching tabs) within a session — we only ever auto-select once, so a user's
// later choice of Feed/a repo is never overridden; a full reload re-applies the default.
let insightsDefaultApplied = false;

// Called by explicit "open the Feed" navigations (the Welcome-back banner) that mount the
// Activity console for the first time this session. It marks the one-shot Insights default
// consumed so the effect below won't clobber the caller's chosen 'feed' back to 'insights'
// on that first mount. Idempotent; no-op once the default has already been applied.
export function suppressInsightsDefault(): void {
  insightsDefaultApplied = true;
}

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
  accent,
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
  // The owning team's identity colour when the rail is grouped by team, else null. Rendered as
  // the row's left border so a row visually belongs to the header above it — and so a repo that
  // legitimately appears under TWO teams is distinguishable at a glance.
  accent: string | null;
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
      // SELECTION WINS over the team accent: the sky border is how you find the open repo, and
      // an accent that overrode it would make the selected row indistinguishable. The inline
      // style is only applied on unselected rows, and only when grouped (accent != null) —
      // Tailwind can't express a runtime palette value.
      style={!selected && accent ? { borderLeftColor: accent } : undefined}
      className={`flex w-56 shrink-0 flex-col gap-0.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
        selected
          ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
          : accent
            ? 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
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
              ⚠{attentionCount}
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
              {t === 'bots' && <span aria-hidden="true">🤖</span>}
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

// The Activity "Triage Console with a Briefing Feed": a fixed left rail of repos (the
// cross-repo glance) + a right detail that defaults to the cross-repo consolidated Feed
// and narrows to a single-repo console on selection. Entirely on the core query layer —
// no AI (the only Pro surface is the per-repo digest banner inside RepoFeedHeader).
export function ActivityView(): JSX.Element {
  useStalenessTick();
  const teamScope = useFilters((s) => s.teamScope);
  const repoIds = useFilters((s) => s.repoIds);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const { teamInsights, activityDigest } = useProCapabilities();
  // The cross-repo Feed's inner sub-tab: 'feed' (metrics + consolidated feed) vs the Pro
  // "Discussion themes" AI summary. The Themes tab only appears when the AI-summary tier is on.
  const feedInnerTab = useFilters((s) => s.feedInnerTab);
  const setFeedInnerTab = useFilters((s) => s.setFeedInnerTab);
  // Scope the aggregate to the active TEAM: 'all' → null (every watched repo), a team → its
  // teamScope-derived repoIds (kept in lockstep by setTeamScope / useTeamScopeSync). Members
  // is a TIMELINE-only filter, so it never narrows the console (userIds → null). When 'all'
  // the backend resolves the whole watched set, so the rail + "new activity" check reflect
  // the whole team, not just one repo.
  const scopeRepoIds = teamScope === 'all' ? null : repoIds;
  const { data, isFetching, isLoading } = useActivity(scopeRepoIds, null);
  // Default-branch status for the SAME scope (the hook reads teamScope/repoIds itself, so this
  // needs no argument and can never drift from useActivity's scope). Purely informational: it
  // feeds the rail's third line and the Feed strip, and nothing else — not the sort, not
  // attentionCount, not any badge.
  const { data: branchData } = useBranchStatus();
  const branchByRepo = useMemo(
    () => new Map((branchData?.repos ?? []).map((r) => [r.repoId, r])),
    [branchData],
  );
  const { data: allRepos } = useRepos();
  // The rail is grouped by team whenever 2+ teams are in scope (a repo in several teams shows
  // under each). See `scopedTeamIds` below for why the predicate is not a scope-shape test.
  const { data: teams } = useTeams();
  const allTeamIds = useMemo(() => (teams ?? []).map((t) => t.id), [teams]);
  // The teams currently in scope, and the ONE gate every cross-team surface here shares.
  //
  // LANDMINE (this is the bug the whole change fixes): neither `teamScope === 'teams'` nor
  // `Array.isArray(teamScope)` is a correct multi-team test. `teamSetToScope` canonicalises a
  // selection covering EVERY team to the 'teams' sentinel and a one-team selection to a bare
  // number, so the count must come from the RESOLVED ids. The old rail + Compare gates both
  // tested the sentinel, which is why ticking two of five teams silently un-grouped the rail
  // and made the Compare tab disappear.
  const scopedTeamIds = useMemo(
    () => teamIdsInScope(teamScope, allTeamIds),
    [teamScope, allTeamIds],
  );
  const groupRail = isMultiTeamScope(teamScope, allTeamIds);
  // Colours are seeded from the ACCOUNT-WIDE roster, never `scopedTeamIds` — otherwise every
  // team's hue would shift as the selection changed, and the rail would disagree with the
  // Compare matrix built from a different subset. (Same discipline as buildBotColorMap.)
  const teamColors = useMemo(() => buildTeamColorMap(allTeamIds), [allTeamIds]);

  const sorted = useMemo(() => sortRepos(data?.repos ?? []), [data?.repos]);

  // The selected repo (single-repo console). null ⇒ the Feed pseudo-row.
  const selectedRepo =
    typeof activityRepoId === 'number'
      ? sorted.find((r) => r.repoId === activityRepoId) ?? null
      : null;
  // The cross-repo consolidated Feed is the default detail (also when nothing's set).
  const showingFeed = activityRepoId === 'feed' || activityRepoId == null;
  // The CORE/free "Needs attention" cards console — always available, no Pro gate.
  const showingAttention = activityRepoId === 'attention';
  const showingInsights = activityRepoId === 'insights';
  // The CORE/free review-bot triage console (BotsView) — always available (reads the core bot
  // routes), independent of the Pro Insights caps.
  const showingBots = activityRepoId === 'bots';

  // Make Insights the default view when Pro is available — but only once per page load, and
  // only from the pristine 'feed' default (never overriding a deep-linked repo or a choice
  // the user has already made this session).
  useEffect(() => {
    if (!insightsDefaultApplied && teamInsights) {
      insightsDefaultApplied = true;
      if (useFilters.getState().activityRepoId === 'feed') setActivityRepo('insights');
    }
  }, [teamInsights, setActivityRepo]);

  // The cross-repo Feed's sub-tab bar. Built dynamically so a tab exists only where it means
  // something: Themes needs the Pro AI tier, Compare needs 2+ teams to compare.
  const feedTabs = useMemo(() => {
    const tabs: { key: 'feed' | 'themes' | 'compare'; label: string }[] = [
      { key: 'feed', label: 'Feed' },
    ];
    if (activityDigest) tabs.push({ key: 'themes', label: 'Themes' });
    if (groupRail) tabs.push({ key: 'compare', label: 'Compare teams' });
    return tabs;
  }, [activityDigest, groupRail]);
  // DERIVED, never written back to the store. Un-ticking a team (or Pro going away) must not
  // strand the pane on a tab that no longer exists — but a corrective `setFeedInnerTab` would
  // also FORGET the user's choice, so re-ticking the team wouldn't restore Compare. Falling back
  // for the render only keeps the choice intact. This also fixes the pre-existing wart where
  // `activityDigest` flipping off left feedInnerTab stuck on 'themes' with no tab highlighted.
  const effectiveFeedTab = feedTabs.some((t) => t.key === feedInnerTab) ? feedInnerTab : 'feed';

  const generatedAt = data?.generatedAt ?? null;

  // Rail items: the loaded inbox repos, or a name-only fallback from useRepos while the first
  // aggregate is loading (so names paint instantly). When ANY team is in scope the fallback is
  // restricted to the union of THOSE teams' repos — else, on a cold load (activity isn't
  // IndexedDB-persisted, so this happens every time), every account repo briefly paints and the
  // out-of-scope ones land under "Other" until the scoped aggregate resolves, which reads as the
  // rail reshuffling itself. This used to narrow only for the All-Teams sentinel, so both the
  // 2-team and the single-team scopes flashed the whole account.
  type RailItem = {
    repoId: number;
    fullName: string;
    maintainerCount: number;
    hasUnread: boolean;
    attentionCount: number;
    openPrs: number | null;
    threadTotals: ThreadStateCounts | null;
  };
  const fallbackRepos = (() => {
    const repos = allRepos ?? [];
    if (scopedTeamIds.length > 0) {
      const scoped = new Set(scopedTeamIds);
      const union = new Set(
        (teams ?? []).filter((t) => scoped.has(t.id)).flatMap((t) => t.repoIds),
      );
      return repos.filter((r) => union.has(r.id));
    }
    // No team in scope ('all' / 'none'): fall back to the FilterBar's repo visibility if it
    // narrows anything, else the whole list.
    return repoIds != null ? repos.filter((r) => repoIds.includes(r.id)) : repos;
  })();
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

  // `key` is passed by the caller, not derived from repoId: under grouping a repo shared by two
  // teams renders once per group, so the key must be `${teamId}:${repoId}` there.
  const renderRailRow = (r: RailItem, key: string, accent: string | null): JSX.Element => (
    <RailRow
      key={key}
      accent={accent}
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

  // With 2+ teams in scope, group the rail rows under a header per team.
  //
  // A repo can belong to SEVERAL teams. It is shown under EACH of them, deliberately: hiding it
  // from one group would misrepresent that team's surface area, and silently picking one owner
  // would be arbitrary. The rows are genuinely the same repo, so selecting either highlights
  // both — accepted, and the reason the accent colour matters (you can see which group you are
  // reading). `matched` tracks placed repos so a row in NO selected team (a repo that is watched
  // but unassigned, or assigned only to a team outside the scope) lands under "Other" rather
  // than vanishing from the rail.
  //
  // LANDMINE: the loop iterates the SELECTED teams, not every team. Iterating all of them — as
  // it did when this was All-Teams-only and "all teams" was the same set — would emit a header
  // for an unselected team the moment one of its repos was shared with a selected one.
  const teamGroups: { id: number; name: string; rows: RailItem[] }[] = [];
  let leftoverRows: RailItem[] = [];
  if (groupRail) {
    const matched = new Set<number>();
    const scoped = new Set(scopedTeamIds);
    for (const team of (teams ?? []).filter((t) => scoped.has(t.id))) {
      const ids = new Set(team.repoIds);
      const rows = railItems.filter((r) => ids.has(r.repoId));
      if (rows.length === 0) continue;
      rows.forEach((r) => matched.add(r.repoId));
      teamGroups.push({ id: team.id, name: team.name, rows });
    }
    leftoverRows = railItems.filter((r) => !matched.has(r.repoId));
  }

  // The Activity console is scoped to WATCHED repos, so an empty console has two distinct
  // causes: no repos added at all, vs. repos added but none watched. The remedy differs
  // (add a repo vs. toggle Watch), so distinguish them in the empty state below.
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
        {/* No manual Refresh: the console tracks the WATCHED set live — watch/add/sync all
            invalidate the Activity/Insights queries (ACTIVITY_QUERY_KEYS), and the feed has its
            own "new activity" banner — so there's nothing to refresh by hand. */}
        {/* The team scope selector + "Manage repos & teams" now live in the header's
            TeamSelector (shown on every view), so the rail no longer carries its own header. */}
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
          {/* INSIGHTS pseudo-row — team review-intelligence (Pro; teamInsights). When Pro is
              on it is the FIRST entry AND the default landing view (see the effect above);
              hidden entirely in OSS / when Pro is off. */}
          {teamInsights && (
            <button
              type="button"
              onClick={() => setActivityRepo('insights')}
              aria-pressed={showingInsights}
              className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
                showingInsights
                  ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                  : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
              }`}
              title="Team review-intelligence across your watched repos (Pro)"
            >
              <span aria-hidden="true" className="shrink-0 text-violet-500">
                ◈
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
                Insights
              </span>
              <span className="shrink-0 rounded bg-violet-500/10 px-1 text-[9px] font-semibold uppercase text-violet-600 dark:text-violet-300">
                Pro
              </span>
            </button>
          )}

          {/* FEED pseudo-row — the cross-repo consolidated state of play. The old "All repos"
              pseudo-row was removed (redundant with the Feed + the per-repo entries below). */}
          <button
            type="button"
            onClick={() => setActivityRepo('feed')}
            aria-pressed={showingFeed}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingFeed
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="A relevance-ranked stream across all your repos"
          >
            <span aria-hidden="true" className="shrink-0 text-sky-500">
              ✦
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Feed
            </span>
          </button>

          {/* NEEDS-ATTENTION pseudo-row — the attention cards (stalled reviews / untouched threads /
              reviewer load / needs-a-reviewer), moved out from under the Pro Insights AI panels.
              CORE/free (reads the deterministic /api/attention route), so it's ALWAYS shown. */}
          <button
            type="button"
            onClick={() => setActivityRepo('attention')}
            aria-pressed={showingAttention}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingAttention
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Stalled reviews, untouched threads, reviewer load and un-assigned PRs (free)"
          >
            <span aria-hidden="true" className="shrink-0 text-amber-500">
              ⚠
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Needs attention
            </span>
          </button>

          {/* BOTS pseudo-row — "the calm layer above your review bots". CORE/free (reads the
              deterministic bot routes), so it's ALWAYS shown, on every tier, no Pro gate. */}
          <button
            type="button"
            onClick={() => setActivityRepo('bots')}
            aria-pressed={showingBots}
            className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
              showingBots
                ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
            title="Detect, measure, and triage your automated review bots (free)"
          >
            <span aria-hidden="true" className="shrink-0">
              🤖
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-gray-700 dark:text-gray-200">
              Bots
            </span>
          </button>

          {/* Grouped by team (2+ teams in scope) vs the flat list. The single-team and no-team
              cases render EXACTLY as before — same rows, no header, accent null. */}
          {groupRail ? (
            <>
              {teamGroups.map((g) => {
                const color = teamColorFor(teamColors, g.id);
                return (
                  <div key={g.id} className="flex w-56 shrink-0 flex-col gap-1 md:w-full">
                    <div className="flex items-center gap-1.5 px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: color }}
                      />
                      <span className="min-w-0 truncate">{g.name}</span>
                      <span className="shrink-0 font-normal normal-case tabular-nums text-gray-400">
                        · {g.rows.length}
                      </span>
                    </div>
                    {g.rows.map((r) => renderRailRow(r, `${g.id}:${r.repoId}`, color))}
                  </div>
                );
              })}
              {leftoverRows.length > 0 && (
                <div className="flex w-56 shrink-0 flex-col gap-1 md:w-full">
                  {/* Repos in NO selected team still need a home — they are watched and in the
                      aggregate, so dropping them would lose real activity. */}
                  <div className="px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    Other · {leftoverRows.length}
                  </div>
                  {leftoverRows.map((r) => renderRailRow(r, `other:${r.repoId}`, null))}
                </div>
              )}
            </>
          ) : (
            railItems.map((r) => renderRailRow(r, String(r.repoId), null))
          )}

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
          // First-run: detect the viewer's recent repos + one-click watch. Hoisted above the
          // rail-entry branches so a zero-repo account always lands here (a Pro account could
          // otherwise auto-select Insights and never reach the empty state).
          <FirstRunOnboarding />
        ) : showingBots ? (
          // The CORE/free review-bot triage console (ROI panel + a bot-only feed). Scoped by the
          // FilterBar repos (the bot feed ignores the human-member filter); carries its own empty
          // states, so it renders even before any repo data loads.
          <BotsView />
        ) : showingAttention ? (
          // The CORE/free "Needs attention" cards (stalled reviews / untouched threads / reviewer
          // load / needs-a-reviewer) — moved out from under the Pro Insights AI panels. Renders on
          // every tier, before repo data loads (its own empty/loading states).
          <AttentionView />
        ) : showingInsights ? (
          <InsightsView />
        ) : noRepos ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400">
            {hasAnyRepo
              ? 'No watched repos yet. Open "Manage repos & teams" in the header and toggle Watch on a repo to populate the Activity console.'
              : 'Detecting the repos you work on…'}
          </div>
        ) : showingFeed ? (
          // The cross-repo Feed: the team flow-metric header (DORA-ish tiles + trend charts —
          // CORE/free, moved out of the Pro Insights pane) atop the consolidated feed stream. With
          // Pro on, a "Discussion themes" sub-tab (the human sibling of Bots → Themes) sits beside it.
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
                      {/* Only Themes is Pro. Compare deliberately carries NO pill — it is core. */}
                      {t.key === 'themes' && (
                        <span className="rounded bg-violet-500/10 px-1 text-[9px] font-semibold uppercase text-violet-600 dark:text-violet-300">
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
            ) : effectiveFeedTab === 'compare' ? (
              // Cross-team flow-metric matrix — beside the free DORA header whose window it
              // shares, and reachable from ANY 2+ team selection (not just All-Teams).
              <TeamComparisonPanel teamIds={scopedTeamIds} scope={scopeToParam(teamScope)} />
            ) : (
              <>
                {/* "Is trunk green?" across every repo in scope — above the flow metrics,
                    because a red default branch invalidates every open PR's CI at once and is
                    the first thing worth knowing. Read-only; self-hides until branch-synced. */}
                <BranchStatusPanel />
                <FeedMetricsPanel />
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
          // A numeric repo id that didn't resolve (e.g. removed, or added-but-unwatched so it's
          // absent from the watched aggregate) — fall back to the cross-repo Feed, still
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
