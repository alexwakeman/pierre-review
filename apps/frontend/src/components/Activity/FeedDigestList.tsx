import { useMemo } from 'react';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useRepoDigests, useRefreshRepoDigests } from '../../hooks/useRepoDigest.js';
import { useOpenPrTab } from '../../hooks/useOpenPrTab.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { useDigestCollapse } from '../../store/digestCollapse.js';
import { RepoDigestCard } from './RepoDigestCard.js';

// The cross-repo digest atop the Activity "Feed" — the ONLY Pro/flagged surface in the Feed
// (the consolidated list below it is core). Renders nothing unless pro.activityDigest is true.
// It is simply the COLLECTION of per-repo digests (one card per repo, each collapsible),
// scoped to the WATCHED repos intersected with the FilterBar-visible selection — so it
// never fans out to every added repo. There is no separate aggregate LLM pass; the cards
// reuse the same repo_digests rows the single-repo console shows.
export function FeedDigestList(): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const { data: repos } = useRepos();
  const storeRepoIds = useFilters((s) => s.repoIds);
  const openPr = useOpenPrTab();
  const refresh = useRefreshRepoDigests();
  const collapsedSet = useDigestCollapse((s) => s.collapsed);
  const toggle = useDigestCollapse((s) => s.toggle);

  // Watched ∩ visible (null store selection = all visible). This exact set is what the
  // Feed digest covers.
  const watchedVisibleIds = useMemo(
    () =>
      (repos ?? [])
        .filter((r) => r.inboxWatch && (storeRepoIds == null || storeRepoIds.includes(r.id)))
        .map((r) => r.id),
    [repos, storeRepoIds],
  );

  const { data, isLoading } = useRepoDigests(
    watchedVisibleIds,
    activityDigest && watchedVisibleIds.length > 0,
  );

  // Absent Pro → render nothing. This is the load-bearing gate.
  if (!activityDigest) return null;

  const digests = data?.digests ?? [];
  const anyWatched = watchedVisibleIds.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
          <span aria-hidden="true">✨</span> Digests · watched repos
        </span>
        <span className="rounded bg-violet-500/15 px-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300">
          Pro
        </span>
        <button
          type="button"
          onClick={() => refresh.mutate(watchedVisibleIds)}
          disabled={refresh.isPending || !anyWatched}
          className="ml-auto flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
          title="Regenerate digests for your watched repos (unchanged repos are free)"
        >
          <span aria-hidden="true">↻</span>
          {refresh.isPending ? 'Regenerating…' : 'Regenerate all'}
        </button>
      </div>
      {!anyWatched ? (
        <p className="px-0.5 text-xs text-gray-400">
          No watched repos in view — Watch a repo (the eye toggle) to get a digest here.
        </p>
      ) : isLoading ? (
        <div className="h-12 animate-pulse rounded-md border border-violet-200 bg-violet-50/40 dark:border-violet-900/40 dark:bg-violet-950/10" />
      ) : digests.length === 0 ? (
        <p className="px-0.5 text-xs text-gray-400">
          No digests yet — click Regenerate all to summarise your watched repos.
        </p>
      ) : (
        <div className="space-y-2">
          {digests.map((d) => (
            <RepoDigestCard
              key={d.repoId}
              digest={d}
              isLoading={false}
              title={d.repoFullName}
              collapsed={collapsedSet.has(d.repoId)}
              onToggle={() => toggle(d.repoId)}
              onRegenerate={() => refresh.mutate(d.repoId)}
              regenerating={refresh.isPending && refresh.variables === d.repoId}
              onOpenPr={openPr}
            />
          ))}
        </div>
      )}
    </div>
  );
}
