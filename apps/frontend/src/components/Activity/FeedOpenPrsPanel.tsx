import { useMemo } from 'react';
import type { Repo, TimelinePr } from '@pierre-review/shared';
import { useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useMaintainersByRepo } from '../../hooks/useMaintainers.js';
import { useFilters } from '../../store/filters.js';
import { useFeedOpenPrsPanel } from '../../store/digestCollapse.js';
import { indexUsers, sortOpenPrsByActivity } from '../../lib/ui.js';
import { ChevronIcon } from '../Icons.js';
import { OpenPrRows } from './RepoOpenPrList.js';

interface PrGroup {
  repoId: number;
  repoName: string; // owner/name
  prs: TimelinePr[];
}

// Bucket the scope's open PRs by the REPO they belong to — one section per repo, so the
// cross-repo Feed's open work reads as "which repo has what open" (the per-repo console shows a
// single repo; this Workspace-wide feed spans them). The PR set is exactly what
// useWorkspaceOpenPrs returns (every repo in the active workspace); grouping is purely
// presentational. Within a section the caller preserves the activity-sort; sections are ordered
// most-recently-active first.
function groupOpenPrsByRepo(prs: TimelinePr[], reposById: Map<number, Repo>): PrGroup[] {
  const byRepo = new Map<number, TimelinePr[]>();
  for (const p of prs) {
    const arr = byRepo.get(p.repoId);
    if (arr) arr.push(p);
    else byRepo.set(p.repoId, [p]);
  }
  return [...byRepo.entries()].map(([repoId, rprs]) => ({
    repoId,
    repoName: reposById.get(repoId)?.fullName ?? `repo #${repoId}`,
    prs: rprs,
  }));
}

// A collapsible panel atop the cross-repo Feed listing the scope's open PRs, grouped into a
// section PER REPO (see groupOpenPrsByRepo). Collapsed by default (persisted). Clicking a PR opens
// its own pr-detail tab (its Show/Focus links then drive the timeline / feed); a section's
// "Show all" opens the sortable all-open-PRs drill-down scoped to that repo.
export function FeedOpenPrsPanel(): JSX.Element | null {
  // Every open PR in the ACTIVE WORKSPACE. Members AND the FilterBar's repo picker are both
  // TIMELINE-only filters, so neither narrows this panel — the Feed always spans its whole
  // workspace, and you narrow it by picking a repo in the Activity rail.
  const { data: openPrs } = useWorkspaceOpenPrs();
  const { data: repos } = useRepos();
  const { data: users } = useUsers();
  const openOpenPrsDetail = useFilters((s) => s.openOpenPrsDetail);
  const collapsed = useFeedOpenPrsPanel((s) => s.collapsed);
  const toggleCollapsed = useFeedOpenPrsPanel((s) => s.toggle);
  const maintainersByRepo = useMaintainersByRepo();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const reposById = useMemo(() => {
    const m = new Map<number, Repo>();
    for (const r of repos ?? []) m.set(r.id, r);
    return m;
  }, [repos]);

  const prs = openPrs?.prs ?? [];
  // Group by repo, order each section by sortOpenPrsByActivity (maintainer-authored first, then
  // recency, then volume), then order the SECTIONS by their most-recently-active PR so the busiest
  // repos float up — matching the feed's recency-first ethos. Each section paginates independently.
  const groups = useMemo(() => {
    const isMaintainerAuthor = (pr: TimelinePr): boolean => {
      const set = maintainersByRepo.get(pr.repoId);
      return pr.authorId != null && set != null && set.has(pr.authorId);
    };
    const g = groupOpenPrsByRepo(prs, reposById).map((grp) => ({
      ...grp,
      prs: sortOpenPrsByActivity(grp.prs, isMaintainerAuthor),
    }));
    g.sort(
      (a, b) =>
        Math.max(...b.prs.map((p) => Date.parse(p.updatedAt))) -
        Math.max(...a.prs.map((p) => Date.parse(p.updatedAt))),
    );
    return g;
  }, [prs, reposById, maintainersByRepo]);

  // Nothing to show → no panel (keeps the Feed header clean when there's no open work).
  if (prs.length === 0) return null;

  const draftCount = prs.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);
  const openCount = prs.length - draftCount;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/40"
      >
        <ChevronIcon
          dir={collapsed ? 'right' : 'down'}
          className="shrink-0 text-gray-400"
        />
        Open PRs · {openCount}
        {draftCount > 0 && (
          <span className="font-normal normal-case text-gray-400">
            · {draftCount} draft{draftCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto font-normal normal-case text-gray-400">
          click a PR to open it
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-gray-200 dark:border-gray-800">
          {groups.map((g) => (
            <div key={g.repoId}>
              {/* One section per repo — the "include the repo the PR belongs to" header. */}
              <div className="bg-gray-50/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:bg-gray-900/40">
                {g.repoName}
                <span className="font-normal"> · {g.prs.length}</span>
              </div>
              <OpenPrRows
                prs={g.prs}
                usersById={usersById}
                keyPrefix={`repo:${g.repoId}:`}
                // The "Show all" footer promises THIS repo's count, so the drill-down scopes to it.
                onShowAll={() => openOpenPrsDetail(g.repoId)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
