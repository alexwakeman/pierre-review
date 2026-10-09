import { useMemo, useState } from 'react';
import type { TimelinePr } from '@pierre-review/shared';
import { useMergedPrs } from '../../hooks/useWorkspaceInsights.js';
import { useRepos, useUsers } from '../../hooks/useTimeline.js';
import { useTrackerOn } from '../../hooks/useWorkspaceTracker.js';
import { useOpenPrsView } from '../../store/openPrsView.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { indexUsers } from '../../lib/ui.js';
import { MetricRepoFilter } from './MetricRepoFilter.js';
import { OpenPrsCards, OpenPrsViewToggle } from './OpenPrsCards.js';
import { reportingWindowCaption, reportingWindowPhrase, windowDates } from './reportingWindowText.js';

// Reports → "Merged so far" — the Open PRs page over the work that LANDED: every PR merged in the
// workspace's REPORTING WINDOW (this sprint so far, else the trailing 14 days), from
// GET /api/merged-prs. The SAME cards and ticket stacks (`OpenPrsCards variant="merged"`), so a
// lead can see what got done per ticket — plus a "No ticket" stack — in this sprint.
//
// ⚠ THE WINDOW IS THE SERVER'S, never re-derived here: the response echoes it and the header names
// it through the shared reporting-window spelling, so this tab and the flow tiles say the same thing.
// ⚠ Pro with the rest of Reports: `InsightsView` is the one gate and `useMergedPrs` ANDs
// `periodReports` into its own `enabled`.
// The repo dropdown narrows client-side and is this tab's OWN state (not Open PRs' store filter,
// not the Timeline picker). The Group by ticket / List choice is shared with Open PRs (one
// per-viewer preference).

export function MergedPrsView(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, isLoading, isError } = useMergedPrs(workspaceId);
  const ticketsOn = useTrackerOn(workspaceId);
  const view = useOpenPrsView((s) => s.view);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  const { data: users } = useUsers();
  const { data: repos } = useRepos();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const repoNameById = useMemo(() => new Map((repos ?? []).map((r) => [r.id, r.fullName])), [repos]);

  const prs = useMemo(() => data?.prs ?? [], [data]);
  // Keyed by workspace, so a choice made in another workspace is ignored rather than reset.
  const [filter, setFilter] = useState<{ workspaceId: number | null; repoIds: number[] } | null>(null);
  const repoSel = filter != null && filter.workspaceId === workspaceId ? filter.repoIds : null;
  const repoOptions = useMemo(() => {
    const byId = new Map<number, string>();
    for (const p of prs) byId.set(p.repoId, repoNameById.get(p.repoId) ?? `repo ${p.repoId}`);
    for (const id of repoSel ?? []) if (!byId.has(id)) byId.set(id, repoNameById.get(id) ?? `repo ${id}`);
    return [...byId.entries()]
      .map(([id, fullName]) => ({ id, fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [prs, repoNameById, repoSel]);
  const rows = repoSel != null ? prs.filter((p) => repoSel.includes(p.repoId)) : prs;

  const openTab = (pr: TimelinePr): void => {
    const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
    openPrDetailTab(
      {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        repoFullName: repoNameById.get(pr.repoId) ?? '',
        authorLogin: u?.githubLogin ?? null,
        authorDisplayName: u?.displayName ?? null,
        authorAvatarUrl: u?.avatarUrl ?? null,
      },
      { fromActivity: true },
    );
  };

  const w = data?.window ?? null;
  const n = rows.length;

  return (
    <div data-testid="merged-prs-view" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {w != null ? reportingWindowCaption(w) : 'Merged so far'}
        </h3>
        {w != null && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {windowDates(w)} · {n} pull request{n === 1 ? '' : 's'} merged
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {ticketsOn && <OpenPrsViewToggle />}
          <MetricRepoFilter
            repos={repoOptions}
            selected={repoSel}
            onChange={(sel) => setFilter(sel == null ? null : { workspaceId, repoIds: sel })}
          />
        </div>
      </div>
      {data?.truncated === true && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          Showing the latest {prs.length} merges in this window; earlier ones are not listed.
        </p>
      )}
      <OpenPrsCards
        prs={rows}
        isLoading={isLoading}
        isError={isError}
        sort={null}
        variant="merged"
        grouped={ticketsOn && view === 'grouped'}
        onOpenPr={openTab}
        emptyLabel={
          repoSel != null && prs.length > 0
            ? 'No merged PRs for the selected repos — adjust the repo filter.'
            : w != null
              ? `No pull requests merged ${reportingWindowPhrase(w)}.`
              : 'No pull requests merged in this window.'
        }
      />
    </div>
  );
}
