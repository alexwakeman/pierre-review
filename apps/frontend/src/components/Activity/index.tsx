import { useEffect, useMemo, useState } from 'react';
import type { ActivityRepo, ThreadStateCounts } from '@pierre-review/shared';
import { useActivity } from '../../hooks/useActivity.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { MaintainerShield } from '../MaintainerShield.js';
import { relativeTime, DERIVED_STATE_META } from '../../lib/ui.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { RepoFeedHeader } from './RepoFeedHeader.js';
import { RepoInsightsCard } from './RepoInsightsCard.js';
import { RepoOpenPrList } from './RepoOpenPrList.js';
import { FeedView } from './FeedView.js';
import { InsightsView } from './InsightsView.js';
import { RepoAnalyticsModal } from '../RepoAnalyticsModal.js';

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
  selected,
  onSelect,
}: {
  fullName: string;
  maintainerCount: number;
  hasUnread: boolean;
  attentionCount: number;
  openPrs: number | null;
  threadTotals: ThreadStateCounts | null;
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
              ⚠{attentionCount}
            </span>
          )}
          <span className="ml-auto shrink-0 tabular-nums text-gray-400">
            {openPrs == null ? '' : openPrs > 0 ? `[${openPrs}]` : '[—]'}
          </span>
        </span>
      )}
    </button>
  );
}

// The Activity "Triage Console with a Briefing Feed": a fixed left rail of repos (the
// cross-repo glance) + a right detail that defaults to the cross-repo consolidated Feed
// and narrows to a single-repo console on selection. Entirely on the core query layer —
// no AI (the only Pro surface is the per-repo digest banner inside RepoFeedHeader).
export function ActivityView(): JSX.Element {
  useStalenessTick();
  const userIds = useFilters((s) => s.userIds);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  const setActivityRepo = useFilters((s) => s.setActivityRepo);
  const { teamInsights } = useProCapabilities();
  // The cross-repo Activity aggregate is scoped to ALL watched repos ∩ Members — it IGNORES
  // the FilterBar repo-visibility selection (null → the backend resolves all-watched), so the
  // rail + "new activity" check reflect the whole team, not just the visible-on-timeline repos.
  const { data, isFetching, isLoading } = useActivity(null, userIds);
  const { data: allRepos } = useRepos();
  // The per-repo analytics drill-down (item 12): the rail's "Charts" button opens the full
  // RepoAnalyticsModal for that repo.
  const [analyticsRepo, setAnalyticsRepo] = useState<{ repoId: number; name: string } | null>(
    null,
  );

  const sorted = useMemo(() => sortRepos(data?.repos ?? []), [data?.repos]);

  // The selected repo (single-repo console). null ⇒ the Feed pseudo-row.
  const selectedRepo =
    typeof activityRepoId === 'number'
      ? sorted.find((r) => r.repoId === activityRepoId) ?? null
      : null;
  // The cross-repo consolidated Feed is the default detail (also when nothing's set).
  const showingFeed = activityRepoId === 'feed' || activityRepoId == null;
  const showingInsights = activityRepoId === 'insights';
  const showingRetro = activityRepoId === 'retro';

  // Make Insights the default view when Pro is available — but only once per page load, and
  // only from the pristine 'feed' default (never overriding a deep-linked repo or a choice
  // the user has already made this session).
  useEffect(() => {
    if (!insightsDefaultApplied && teamInsights) {
      insightsDefaultApplied = true;
      if (useFilters.getState().activityRepoId === 'feed') setActivityRepo('insights');
    }
  }, [teamInsights, setActivityRepo]);

  const generatedAt = data?.generatedAt ?? null;

  // Rail items: the loaded inbox repos, or a name-only fallback from useRepos while
  // the first aggregate is loading (so names paint instantly).
  const railItems: {
    repoId: number;
    fullName: string;
    maintainerCount: number;
    hasUnread: boolean;
    attentionCount: number;
    openPrs: number | null;
    threadTotals: ThreadStateCounts | null;
  }[] =
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
      : (allRepos ?? []).map((r) => ({
          repoId: r.id,
          fullName: r.fullName,
          maintainerCount: 0,
          hasUnread: false,
          attentionCount: 0,
          openPrs: null,
          threadTotals: null,
        }));

  // The Activity console is scoped to WATCHED repos, so an empty console has two distinct
  // causes: no repos added at all, vs. repos added but none watched. The remedy differs
  // (add a repo vs. toggle Watch), so distinguish them in the empty state below.
  const noRepos = data != null && sorted.length === 0;
  const hasAnyRepo = (allRepos ?? []).length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* LEFT RAIL */}
      <div className="flex flex-col border-b border-gray-200 md:w-72 md:shrink-0 md:border-b-0 md:border-r dark:border-gray-800">
        {/* No manual Refresh: the console tracks the WATCHED set live — watch/add/sync all
            invalidate the Activity/Insights queries (ACTIVITY_QUERY_KEYS), and the feed has its
            own "new activity" banner — so there's nothing to refresh by hand. */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            State of play
          </span>
        </div>
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

          {railItems.map((r) => (
            <RailRow
              key={r.repoId}
              fullName={r.fullName}
              maintainerCount={r.maintainerCount}
              hasUnread={r.hasUnread}
              attentionCount={r.attentionCount}
              openPrs={r.openPrs}
              threadTotals={r.threadTotals}
              selected={activityRepoId === r.repoId}
              onSelect={() => setActivityRepo(r.repoId)}
            />
          ))}

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
        {showingInsights ? (
          <InsightsView />
        ) : showingRetro ? (
          // Legacy/deep-linked 'retro' rail value now lands on the Retro sub-tab INSIDE
          // Insights (the standalone Retro rail entry was removed).
          <InsightsView initialSubTab="retro" />
        ) : noRepos ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400">
            {hasAnyRepo
              ? 'No watched repos yet. Open the repos dropdown in the filter bar and toggle Watch on a repo to populate the Activity console.'
              : 'No repos yet. Add a repo from the filter bar to populate the Activity console.'}
          </div>
        ) : showingFeed ? (
          <FeedView />
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
          <div className="space-y-3" data-testid="repo-console">
            <RepoFeedHeader repo={selectedRepo} />
            {/* Item 12: per-repo Insights — the merge-rate graph (+ Charts drill-down) sits
                under the AI digest (in the header) and above the open-PR list. */}
            <RepoInsightsCard
              repoId={selectedRepo.repoId}
              onOpenCharts={() =>
                setAnalyticsRepo({
                  repoId: selectedRepo.repoId,
                  name: selectedRepo.repoFullName,
                })
              }
            />
            {/* All the repo's open PRs (at-a-glance metrics) BEFORE its activity feed. */}
            <RepoOpenPrList prs={selectedRepo.prs} repoFullName={selectedRepo.repoFullName} />
            <FeedView repoId={selectedRepo.repoId} />
          </div>
        ) : (
          // A numeric repo id that didn't resolve (e.g. removed) — fall back to Feed.
          <FeedView />
        )}
      </div>

      <RepoAnalyticsModal
        repoId={analyticsRepo?.repoId ?? null}
        repoName={analyticsRepo?.name ?? null}
        onClose={() => setAnalyticsRepo(null)}
      />
    </div>
  );
}
