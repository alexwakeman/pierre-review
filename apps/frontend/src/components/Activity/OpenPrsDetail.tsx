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
import { ArrowIcon, PullRequestIcon, RefreshIcon, RepoIcon, TicketIcon } from '../Icons.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { PageHeader, useRegisterCommands, type Command } from '../ui/index.js';
import { effectiveSort, pickSort, reverseSort, sortOptionsFor } from '../../lib/openPrsSort.js';
import { MetricRepoFilter } from './MetricRepoFilter.js';
import { FirstRunOnboarding } from './FirstRunOnboarding.js';
import { DefaultBranchesSlot } from './DefaultBranchesSlot.js';
import { AutoReviewUsageLine, OpenPrsCards, OpenPrsSortMenu, OpenPrsViewToggle, RunAutoReviewsButton } from './OpenPrsCards.js';
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
// The cards are DRAWN ten at a time (the next ten when the reader nears the bottom); the data, the
// counts, the sort and the repo filter are always the whole list.

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
  const windowScope = useMemo(() => ({ workspaceId, repoIds: repoSel }), [workspaceId, repoSel]);
  const draftCount = rows.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);

  // ⌘K: the toolbar's every choice, while Open PRs is on screen.
  const claudeOn = useAiCapabilities().enabled;
  const setView = useOpenPrsView((s) => s.setView);
  const commands = useMemo<Command[]>(() => {
    const shown = effectiveSort(sort, claudeOn);
    const list: Command[] = [
      { id: 'sort:default', group: 'Actions', title: 'Sort open PRs by recent activity', keywords: ['order'], icon: <ArrowIcon dir="down" size={14} />, run: () => setSort(null) },
      ...sortOptionsFor(claudeOn).map((o) => ({
        id: `sort:${o.key}`,
        group: 'Actions' as const,
        title: `Sort open PRs by ${o.name.toLowerCase()}`,
        keywords: ['order'],
        icon: <ArrowIcon dir="down" size={14} />,
        run: () => setSort(pickSort(o.key)),
      })),
      { id: 'refresh', group: 'Actions', title: 'Refresh the open PRs', icon: <RefreshIcon size={14} />, run: () => void refetch() },
    ];
    if (shown != null) {
      list.push({ id: 'reverse', group: 'Actions', title: 'Reverse the order of the open PRs', icon: <ArrowIcon dir={shown.dir === 'asc' ? 'down' : 'up'} size={14} />, run: () => setSort(reverseSort(shown)) });
    }
    if (ticketsOn) {
      list.push(
        { id: 'grouped', group: 'Actions', title: 'Group the open PRs by ticket', icon: <TicketIcon size={14} />, run: () => setView('grouped') },
        { id: 'list', group: 'Actions', title: 'Show the open PRs as a list', icon: <PullRequestIcon size={14} />, run: () => setView('list') },
      );
    }
    if (repoSel != null) {
      list.push({ id: 'all-repos', group: 'Actions', title: 'Show open PRs from every repo', icon: <RepoIcon size={14} />, run: () => setRepoSel(null) });
    }
    for (const r of repoOptions) {
      list.push({ id: `only:${r.id}`, group: 'Actions', title: `Show only ${r.fullName} open PRs`, keywords: ['filter', 'repo'], icon: <RepoIcon size={14} />, run: () => setRepoSel([r.id]) });
    }
    return list;
  }, [sort, claudeOn, ticketsOn, repoSel, repoOptions, refetch, setView, setRepoSel]);
  useRegisterCommands('open-prs', commands);

  // This pane is where the app OPENS, so it owns the two empty-workspace states Activity used to:
  // an account with no repos at all gets first-run onboarding, and a workspace with none of them
  // gets the "move some in" guidance — never a bare "No open PRs here.".
  const { data: workspaces } = useWorkspaces();
  const ws = workspaces?.find((w) => w.id === workspaceId);
  const noReposAtAll = repos != null && repos.length === 0;
  const emptyWorkspace = ws != null && ws.repoIds.length === 0;
  if (noReposAtAll) return <FirstRunOnboarding />;

  return (
    <div data-testid="open-prs-view" className="max-w-[100rem]">
      {/* THE ONE SLIM HEADER (docs/redesign/DESIGN.md): the title and its counts, one quiet line
          (the default branches + today's auto reviews), then the toolbar. The Activity pane pads
          by the page gutter, so the header adds none (`inset={false}`). */}
      <PageHeader
        inset={false}
        title="Open pull requests"
        info={
          <>
            <span className="text-body tabular-nums text-ui-mute">
              {/* Non-draft headline: the Flow tile and the sidebar's count are non-draft opens, and
                  this header must reconcile with the number the reader just clicked. */}
              {rows.length - draftCount} open
              {draftCount > 0 && ` · ${draftCount} draft${draftCount === 1 ? '' : 's'}`}
              <span className="text-ui-faint"> · {scopeLabel}</span>
            </span>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="Refresh"
              title="Refresh the open PRs"
              className="ml-auto inline-flex h-7 items-center gap-1.5 self-center rounded-ui px-2 text-meta text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-60 touch:h-10 touch:min-w-10 touch:justify-center"
            >
              <RefreshIcon size={12} className={isFetching ? 'motion-safe:animate-spin' : ''} />
              <span className="max-sm:sr-only">Refresh</span>
            </button>
          </>
        }
      >
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {/* The workspace's default branches — informational, never a count. */}
          <div className="min-w-0 flex-1 basis-64">{!emptyWorkspace && <DefaultBranchesSlot />}</div>
          {/* Today's auto reviews against the cap, and one sweep now — only while auto review is on. */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1">
            <AutoReviewUsageLine />
            <RunAutoReviewsButton />
          </div>
        </div>
        <div role="toolbar" aria-label="Open PRs view" className="mt-2 flex flex-wrap items-center gap-1.5">
          {ticketsOn && <OpenPrsViewToggle />}
          <OpenPrsSortMenu sort={sort} onChange={setSort} />
          <MetricRepoFilter repos={repoOptions} selected={repoSel} onChange={setRepoSel} />
        </div>
      </PageHeader>

      <OpenPrsCards
        layout="rows"
        prs={rows}
        isLoading={isLoading}
        answered={data != null}
        isError={isError}
        sort={sort}
        grouped={view === 'grouped'}
        onOpenPr={openTab}
        // The workspace and the repo filter are this list's identity: either changing starts the
        // drawn window (and the selection) again.
        windowScope={windowScope}
        emptyLabel={
          emptyWorkspace
            ? 'No repos in this workspace yet. Open "Manage repos & workspaces" from the workspace menu in the sidebar to move some in.'
            : repoSel != null && prs.length > 0
              ? 'No open PRs for the selected repos — adjust the repo filter.'
              : undefined
        }
      />
    </div>
  );
}
