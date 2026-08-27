import { useEffect, useMemo, useState } from 'react';
import type { TimelinePr } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useScopedOpenPrs } from '../../hooks/useTriage.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { indexUsers } from '../../lib/ui.js';
import { RefreshIcon } from '../Icons.js';
import { MetricRepoFilter } from './MetricRepoFilter.js';
import { OpenPrsTable } from './OpenPrsTable.js';

// The all-open-PRs DRILL-DOWN — a persistent, singleton tab: the "Show all N open PRs" footers
// under the Activity open-PR lists open it per-repo, and the Flow metrics "Open PRs" tile opens
// it workspace-wide (the 'feed' scope — this is THE open-PRs view; the metrics drill-down no
// longer has its own). Resolves the `openPrsScope` seed to a label + repo narrowing and renders
// the shared sortable OpenPrsTable over /api/open-prs. Clicking a row opens the PR's detail tab.

export function OpenPrsDetail(): JSX.Element {
  // The scope seed — read (not consumed) for the tab's lifetime, like botPrsFocusRepoId. A
  // stale null (can't normally happen — the tab is ephemeral) falls back to the feed scope.
  const scope = useFilters((s) => s.openPrsScope);
  const repoScopeId = typeof scope === 'number' ? scope : null;
  // A repo GROUP scope (from a FeedOpenPrsPanel group footer): the group's exact repo set,
  // so the tab reproduces the group and the footer's promised count holds.
  const groupScope = scope != null && typeof scope === 'object' ? scope : null;
  // The server-side narrowing: one repo, a group's repo set, or null = the whole ACTIVE
  // WORKSPACE ('feed'). The workspace is the scope in every branch — useScopedOpenPrs always
  // sends `workspace=` alongside any `repoIds` (a bare repoIds is intersected against the
  // DEFAULT workspace's membership) and the null case is byte-identical to the Activity
  // surfaces' query string, sharing their cache entry. Member-AGNOSTIC and repo-picker-agnostic
  // (Timeline-only filters — see workspaceOpenPrsScope.test.ts).
  const scopeRepoIds =
    repoScopeId != null ? [repoScopeId] : groupScope != null ? groupScope.repoIds : null;
  const isWorkspaceWide = scopeRepoIds == null;
  const { data, isLoading, isError, refetch, isFetching } = useScopedOpenPrs(scopeRepoIds);

  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(
    () => new Map((repos ?? []).map((r) => [r.id, r.fullName])),
    [repos],
  );

  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  const prs = useMemo(() => data?.prs ?? [], [data]);

  // The workspace-wide scope gets a repo-filter dropdown — LOCAL state narrowing the loaded rows
  // client-side (null = all). Deliberately NOT `filters.repoIds` (the Timeline picker) and not a
  // refetch: the workspace's list is already here. The scoped mounts cover exactly the repos the
  // opener named, so they render no dropdown.
  const [repoSel, setRepoSel] = useState<number[] | null>(null);
  // The tab is a singleton that survives scope re-seeds (another "Show all" footer, the Flow
  // tile) and workspace switches (pinnedTabs is workspace-unaware) — a narrowing kept across
  // either would silently filter the new list by repos that may not even be in it, under a
  // label that promises the whole scope. Reset it.
  const workspaceId = useFilters((s) => s.workspaceId);
  useEffect(() => {
    setRepoSel(null);
  }, [scope, workspaceId]);
  const repoOptions = useMemo(() => {
    if (!isWorkspaceWide) return [];
    const byId = new Map<number, string>();
    for (const p of prs) byId.set(p.repoId, repoNameById.get(p.repoId) ?? `repo ${p.repoId}`);
    return [...byId.entries()]
      .map(([id, fullName]) => ({ id, fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [isWorkspaceWide, prs, repoNameById]);
  const rows =
    isWorkspaceWide && repoSel != null ? prs.filter((p) => repoSel.includes(p.repoId)) : prs;

  const openTab = (pr: TimelinePr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    const meta: TabMeta = {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      repoFullName: repoNameById.get(pr.repoId) ?? '',
      authorLogin: u?.githubLogin ?? null,
      authorDisplayName: u?.displayName ?? null,
      authorAvatarUrl: u?.avatarUrl ?? null,
    };
    openPrDetailTab(meta, { fromActivity: true });
  };

  const scopeLabel =
    repoScopeId != null
      ? repoNameById.get(repoScopeId) ?? `repo ${repoScopeId}`
      : groupScope != null
        ? groupScope.label
        : 'every repo in this Workspace';
  const draftCount = rows.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Open PRs</h2>
        <span className="text-[11px] text-gray-400">
          {/* Non-draft headline: the Flow tile and the rail's [N] stat count non-draft opens,
              and this header must reconcile with the number the user just clicked (the
              RepoOpenPrList convention), not contradict it. */}
          {scopeLabel} · {rows.length - draftCount} open
          {draftCount > 0 && ` · ${draftCount} draft${draftCount === 1 ? '' : 's'}`} · click a
          column to sort · click a row to open it
        </span>
        <div className="ml-auto flex items-center gap-2">
          {isWorkspaceWide && (
            <MetricRepoFilter repos={repoOptions} selected={repoSel} onChange={setRepoSel} />
          )}
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
          >
            <RefreshIcon
              size={11}
              className={`inline-block align-[-0.1em] ${isFetching ? 'animate-spin' : ''}`}
            />{' '}
            Refresh
          </button>
        </div>
      </div>

      <OpenPrsTable
        prs={rows}
        isLoading={isLoading}
        isError={isError}
        // Hidden only for the SINGLE-repo scope: a group scope spans several repos, whose rows
        // are indistinguishable without the column (isWorkspaceWide keys the dropdown, not this).
        showRepoColumn={repoScopeId == null}
        onOpenPr={openTab}
        emptyLabel={
          repoSel != null && prs.length > 0
            ? 'No open PRs for the selected repos — adjust the repo filter.'
            : undefined
        }
      />
    </div>
  );
}
