import { useMemo, useState } from 'react';
import type { TimelinePr } from '@pierre-review/shared';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useScopedOpenPrs } from '../../hooks/useTriage.js';
import { useTrackerOn } from '../../hooks/useWorkspaceTracker.js';
import { useWorkspaces } from '../../hooks/useWorkspaces.js';
import { useOpenPrsView } from '../../store/openPrsView.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { indexUsers } from '../../lib/ui.js';
import { RefreshIcon } from '../Icons.js';
import { MetricRepoFilter } from './MetricRepoFilter.js';
import { FirstRunOnboarding } from './FirstRunOnboarding.js';
import { DefaultBranchesSlot } from './DefaultBranchesSlot.js';
import { AutoReviewUsageLine, OpenPrsCards, OpenPrsSortMenu, OpenPrsViewToggle } from './OpenPrsCards.js';
import type { OpenPrsSort } from '../../lib/openPrsSort.js';

// Activity → Open PRs — the FIRST rail line and the app's default (a URL with no `view=`), so it
// is always the WHOLE active workspace: one card per open PR (OpenPrsCards) over /api/open-prs,
// headed by the default-branch strip. Every opener (the rail line, the Reports → Flow metrics
// "Open PRs" tile, the per-repo "Show all N open PRs" footer, a workspace switch) just reveals it;
// the footer also pre-selects its repo in the pane's own dropdown.
// Clicking a card opens the PR's detail tab. The order is the header's Sort menu (no column headings).
// With a tracker configured for the workspace (core, free) the header adds "Group by ticket / List" — grouped is the
// default, remembered per viewer (store/openPrsView.ts); without it the toggle is absent and the
// page is the list. The header's count is distinct PRs: a PR shown in two ticket stacks is one PR.

export function OpenPrsDetail(): JSX.Element {
  // ALWAYS the workspace-wide key: byte-identical to `useWorkspaceOpenPrs` (the tab chip's count,
  // FeedIsolationBanner, the Timeline board with its picker unset), so it shares their cache entry.
  // Member-AGNOSTIC and repo-picker-agnostic (Timeline-only filters — see
  // workspaceOpenPrsScope.test.ts).
  const { data, isLoading, isError, refetch, isFetching } = useScopedOpenPrs(null);

  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(
    () => new Map((repos ?? []).map((r) => [r.id, r.fullName])),
    [repos],
  );

  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  const prs = useMemo(() => data?.prs ?? [], [data]);
  // null = the default activity order.
  const [sort, setSort] = useState<OpenPrsSort | null>(null);
  const view = useOpenPrsView((s) => s.view);

  // The repo dropdown narrows the loaded rows client-side (null = all). It lives in the store so
  // the per-repo footer can seed it, but is deliberately NOT `filters.repoIds` (the Timeline
  // picker) and not a refetch: the workspace's list is already here. A filter chosen in another
  // workspace is ignored — derived here, so there is no reset effect to race the seed.
  const workspaceId = useFilters((s) => s.workspaceId);
  // The tracker is CORE and free (apiVersion 23): the toggle shows wherever THIS workspace has one.
  const ticketsOn = useTrackerOn(workspaceId);
  const filter = useFilters((s) => s.openPrsRepoFilter);
  const setRepoSel = useFilters((s) => s.setOpenPrsRepoFilter);
  const repoSel = filter != null && filter.workspaceId === workspaceId ? filter.repoIds : null;
  const repoOptions = useMemo(() => {
    const byId = new Map<number, string>();
    for (const p of prs) byId.set(p.repoId, repoNameById.get(p.repoId) ?? `repo ${p.repoId}`);
    // Keep a seeded repo listed even if it has no open PR right now, so the dropdown can show
    // (and clear) the selection it is filtering by.
    for (const id of repoSel ?? []) {
      if (!byId.has(id)) byId.set(id, repoNameById.get(id) ?? `repo ${id}`);
    }
    return [...byId.entries()]
      .map(([id, fullName]) => ({ id, fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [prs, repoNameById, repoSel]);
  const rows = repoSel != null ? prs.filter((p) => repoSel.includes(p.repoId)) : prs;

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
    repoSel == null
      ? 'every repo in this Workspace'
      : repoSel.length === 1
        ? repoNameById.get(repoSel[0] as number) ?? `repo ${repoSel[0]}`
        : `${repoSel.length} repos`;
  const draftCount = rows.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);

  // This pane is where the app OPENS, so it owns the two empty-workspace states Activity used to:
  // an account with no repos at all gets first-run onboarding, and a workspace with none of them
  // gets the "move some in" guidance — never a bare "No open PRs here.".
  const { data: workspaces } = useWorkspaces();
  const ws = workspaces?.find((w) => w.id === workspaceId);
  const noReposAtAll = repos != null && repos.length === 0;
  const emptyWorkspace = ws != null && ws.repoIds.length === 0;
  if (noReposAtAll) return <FirstRunOnboarding />;

  return (
    <div data-testid="open-prs-view" className="mx-auto max-w-[100rem] space-y-4">
      {/* The workspace's default branches, above the cards — informational, never a count. */}
      {!emptyWorkspace && <DefaultBranchesSlot />}
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Open PRs</h2>
        <span className="text-[11px] text-gray-400">
          {/* Non-draft headline: the Flow tile and the rail's [N] stat count non-draft opens,
              and this header must reconcile with the number the user just clicked (the
              RepoOpenPrList convention), not contradict it. */}
          {scopeLabel} · {rows.length - draftCount} open
          {draftCount > 0 && ` · ${draftCount} draft${draftCount === 1 ? '' : 's'}`}
        </span>
        {/* Today's auto code reviews against the workspace's daily cap — only while auto review is on. */}
        <AutoReviewUsageLine />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {ticketsOn && <OpenPrsViewToggle />}
          <OpenPrsSortMenu sort={sort} onChange={setSort} />
          <MetricRepoFilter repos={repoOptions} selected={repoSel} onChange={setRepoSel} />
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

      <OpenPrsCards
        prs={rows}
        isLoading={isLoading}
        isError={isError}
        sort={sort}
        grouped={ticketsOn && view === 'grouped'}
        onOpenPr={openTab}
        emptyLabel={
          emptyWorkspace
            ? 'No repos in this workspace yet. Open "Manage repos & workspaces" in the header to move some in.'
            : repoSel != null && prs.length > 0
              ? 'No open PRs for the selected repos — adjust the repo filter.'
              : undefined
        }
      />
    </div>
  );
}
