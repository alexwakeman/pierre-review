import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InboxRepo, ThreadStateCounts } from '@pierre-review/shared';
import { useInbox } from '../../hooks/useInbox.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useMe } from '../../hooks/useTriage.js';
import { useLocalStorage } from '../../hooks/useLocalStorage.js';
import { useFilters } from '../../store/filters.js';
import { MaintainerShield } from '../MaintainerShield.js';
import { relativeTime, DERIVED_STATE_META } from '../../lib/ui.js';
import { ThreadStateBar } from './ThreadStateBar.js';
import { RepoSection } from './RepoSection.js';
import { FeedView } from './FeedView.js';

const EMPTY_COUNTS: ThreadStateCounts = {
  untouched: 0,
  replied_unresolved: 0,
  likely_addressed: 0,
  resolved: 0,
};

function addCounts(a: ThreadStateCounts, b: ThreadStateCounts): ThreadStateCounts {
  return {
    untouched: a.untouched + b.untouched,
    replied_unresolved: a.replied_unresolved + b.replied_unresolved,
    likely_addressed: a.likely_addressed + b.likely_addressed,
    resolved: a.resolved + b.resolved,
  };
}

// Rail sort: attention desc → unread → alphabetical. Computed once per data load so
// the rail is stable (not jumpy) as the user interacts.
function sortRepos(repos: InboxRepo[]): InboxRepo[] {
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
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-56 shrink-0 items-center gap-1.5 rounded border-l-2 px-2 py-1.5 text-left text-xs md:w-full ${
        selected
          ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30'
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
    >
      <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
        {fullName}
      </span>
      {maintainerCount > 0 && <MaintainerShield />}
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
      <span className="shrink-0 tabular-nums text-gray-400">
        {openPrs == null ? '' : openPrs > 0 ? `[${openPrs}]` : '[—]'}
      </span>
    </button>
  );
}

// The Inbox "Triage Console with a Briefing Feed": a fixed left rail of repos (the
// cross-repo glance) + a right detail that defaults to an all-repos briefing feed and
// narrows to a single-repo console on selection. Entirely on the core query layer —
// no AI (the only Pro surface is the per-repo digest banner inside RepoSection).
export function InboxView(): JSX.Element {
  useStalenessTick();
  const repoIds = useFilters((s) => s.repoIds);
  const inboxRepoId = useFilters((s) => s.inboxRepoId);
  const setInboxRepo = useFilters((s) => s.setInboxRepo);
  const { data, isFetching, isLoading, refetch } = useInbox(repoIds);
  const { data: allRepos } = useRepos();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const claudeEnabled = me?.claudeReviewEnabled ?? false;

  // Per-card expand state for the all-repos feed, persisted + re-asserted across
  // refresh. Stored as an explicit list of expanded repoIds. `null` = the untouched
  // default (expand only the top repo); `[]` = the user explicitly collapsed
  // everything (distinct from the default — so collapsing the lone default-expanded
  // top card actually sticks instead of snapping back open).
  const [expandedList, setExpandedList] = useLocalStorage<number[] | null>(
    'pierre:inboxExpanded',
    null,
  );

  const sorted = useMemo(() => sortRepos(data?.repos ?? []), [data?.repos]);

  // ALL REPOS aggregate row.
  const aggregate = useMemo(() => {
    let threadTotals = EMPTY_COUNTS;
    let attention = 0;
    let open = 0;
    let unread = false;
    for (const r of sorted) {
      threadTotals = addCounts(threadTotals, r.threadTotals);
      attention += r.attentionCount;
      open += r.stats.openPrs;
      unread = unread || r.hasUnread;
    }
    return { threadTotals, attention, open, unread, stalled: sorted.reduce((n, r) => n + r.stats.stalledPrs, 0) };
  }, [sorted]);

  // The selected repo (single-repo console). null ⇒ a pseudo-row (Feed / All repos).
  const selectedRepo =
    typeof inboxRepoId === 'number'
      ? sorted.find((r) => r.repoId === inboxRepoId) ?? null
      : null;
  // The cross-repo consolidated Feed is the default detail (also when nothing's set).
  const showingFeed = inboxRepoId === 'feed' || inboxRepoId == null;
  const showingAll = inboxRepoId === 'all';

  const topRepoId = sorted[0]?.repoId ?? null;
  const isExpanded = (repoId: number): boolean =>
    expandedList == null ? repoId === topRepoId : expandedList.includes(repoId);
  const toggleExpand = (repoId: number): void => {
    const cur = new Set(
      expandedList == null ? (topRepoId != null ? [topRepoId] : []) : expandedList,
    );
    if (cur.has(repoId)) cur.delete(repoId);
    else cur.add(repoId);
    setExpandedList([...cur]);
  };

  // Staleness: amber past ~10 minutes.
  const generatedAt = data?.generatedAt ?? null;
  const stale =
    generatedAt != null && Date.now() - new Date(generatedAt).getTime() > 10 * 60_000;

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

  const noRepos = data != null && sorted.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* LEFT RAIL */}
      <div className="flex flex-col border-b border-gray-200 md:w-72 md:shrink-0 md:border-b-0 md:border-r dark:border-gray-800">
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            State of play
          </span>
          <button
            type="button"
            onClick={() => {
              void refetch();
              // The Feed entry reads a separate query — refresh it too (pure DB read).
              void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
            }}
            disabled={isFetching}
            className="ml-auto flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            title="Re-query the local database (does not trigger a GitHub sync)"
          >
            <span aria-hidden="true" className={isFetching ? 'animate-spin' : ''}>
              ↻
            </span>
            Refresh
          </button>
        </div>
        {generatedAt != null && (
          <div
            className={`px-3 py-1 text-[10px] ${
              stale ? 'text-amber-500' : 'text-gray-400'
            }`}
            title={new Date(generatedAt).toLocaleString()}
          >
            {relativeTime(generatedAt)}
            {stale ? ' · stale' : ''}
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
          {/* FEED pseudo-row — the cross-repo consolidated state of play (the default
              landing detail). Sits above "All repos". */}
          <button
            type="button"
            onClick={() => setInboxRepo('feed')}
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

          {/* ALL REPOS pseudo-row */}
          <RailRow
            fullName="All repos"
            maintainerCount={0}
            hasUnread={aggregate.unread}
            attentionCount={aggregate.attention}
            openPrs={data != null ? aggregate.open : null}
            threadTotals={data != null ? aggregate.threadTotals : null}
            selected={showingAll}
            onSelect={() => setInboxRepo('all')}
          />
          {railItems.map((r) => (
            <RailRow
              key={r.repoId}
              fullName={r.fullName}
              maintainerCount={r.maintainerCount}
              hasUnread={r.hasUnread}
              attentionCount={r.attentionCount}
              openPrs={r.openPrs}
              threadTotals={r.threadTotals}
              selected={!showingAll && inboxRepoId === r.repoId}
              onSelect={() => setInboxRepo(r.repoId)}
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
        {noRepos ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            No watched repos yet. Add a repo from the filter bar to populate the Inbox.
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
        ) : showingAll ? (
          <div className="space-y-3">
            <div className="text-xs text-gray-400">
              All watched repos · {sorted.length} repo{sorted.length === 1 ? '' : 's'} ·{' '}
              {aggregate.open} open
              {aggregate.stalled > 0 ? ` · ${aggregate.stalled} stalled` : ''}
            </div>
            {sorted.map((r, i) => (
              <RepoSection
                key={r.repoId}
                repo={r}
                density="feed"
                tintIndex={i}
                claudeEnabled={claudeEnabled}
                expanded={isExpanded(r.repoId)}
                onToggleExpand={() => toggleExpand(r.repoId)}
              />
            ))}
          </div>
        ) : selectedRepo != null ? (
          <RepoSection
            repo={selectedRepo}
            density="console"
            tintIndex={sorted.findIndex((r) => r.repoId === selectedRepo.repoId)}
            claudeEnabled={claudeEnabled}
          />
        ) : (
          // A numeric repo id that didn't resolve (e.g. removed) — fall back to Feed.
          <FeedView />
        )}
      </div>
    </div>
  );
}
