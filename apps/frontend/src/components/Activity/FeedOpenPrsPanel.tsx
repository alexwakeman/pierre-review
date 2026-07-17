import { useMemo } from 'react';
import type { Team, TeamScope, TimelinePr } from '@pierre-review/shared';
import { useOpenPrs } from '../../hooks/useTriage.js';
import { useTeams } from '../../hooks/useTeams.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { useFeedOpenPrsPanel } from '../../store/digestCollapse.js';
import { indexUsers } from '../../lib/ui.js';
import { OpenPrRow } from './RepoOpenPrList.js';

interface PrGroup {
  teamId: number | null;
  teamName: string;
  prs: TimelinePr[];
}

// Bucket the scope's open PRs by team. `teamScope` decides which teams are in context:
// a single team id → just that team; 'all' / 'teams' / 'none' → every team, plus a "No
// team" bucket for PRs whose repo belongs to no team-in-context. Overlap is allowed — a
// repo in two teams lists its PRs under each. Within a group the server's reason-sort is
// preserved.
function groupOpenPrsByTeam(prs: TimelinePr[], teams: Team[], scope: TeamScope): PrGroup[] {
  const teamsInScope = typeof scope === 'number' ? teams.filter((t) => t.id === scope) : teams;
  const groups: PrGroup[] = [];
  const assigned = new Set<number>();
  for (const t of teamsInScope) {
    const repoSet = new Set(t.repoIds);
    const teamPrs = prs.filter((p) => repoSet.has(p.repoId));
    if (teamPrs.length === 0) continue;
    for (const p of teamPrs) assigned.add(p.id);
    groups.push({ teamId: t.id, teamName: t.name, prs: teamPrs });
  }
  const unassigned = prs.filter((p) => !assigned.has(p.id));
  if (unassigned.length > 0) {
    // With teams configured this is genuinely "no team"; with none it's just the list.
    groups.push({ teamId: null, teamName: teams.length > 0 ? 'No team' : 'Open PRs', prs: unassigned });
  }
  return groups;
}

// A collapsible panel atop the cross-repo Feed listing the scope's open PRs, grouped by team
// (see groupOpenPrsByTeam). Collapsed by default (persisted). Clicking a PR isolates the Feed
// to that PR's items (toggle: click the selected one again to clear); the selected row is
// highlighted, and FeedView shows the active-filter banner + Clear above the stream.
export function FeedOpenPrsPanel(): JSX.Element | null {
  const { data: openPrs } = useOpenPrs();
  const { data: teams } = useTeams();
  const { data: users } = useUsers();
  const teamScope = useFilters((s) => s.teamScope);
  const isolatedPrId = useFilters((s) => s.feedIsolatedPrId);
  const setIsolatedPrId = useFilters((s) => s.setFeedIsolatedPrId);
  const collapsed = useFeedOpenPrsPanel((s) => s.collapsed);
  const toggleCollapsed = useFeedOpenPrsPanel((s) => s.toggle);
  const usersById = useMemo(() => indexUsers(users), [users]);

  const prs = openPrs?.prs ?? [];
  const groups = useMemo(
    () => groupOpenPrsByTeam(prs, teams ?? [], teamScope),
    [prs, teams, teamScope],
  );

  // Nothing to show → no panel (keeps the Feed header clean when there's no open work).
  if (prs.length === 0) return null;

  const draftCount = prs.reduce((n, p) => n + (p.isDraft ? 1 : 0), 0);
  const openCount = prs.length - draftCount;
  // Only label groups when it carries information: a real team, or a "No team" split that
  // sits alongside team groups. A single ungrouped list (no teams) needs no subheader.
  const showGroupHeaders = groups.length > 1 || (groups[0]?.teamId != null);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/40"
      >
        <span aria-hidden="true" className="text-gray-400">
          {collapsed ? '▸' : '▾'}
        </span>
        Open PRs · {openCount}
        {draftCount > 0 && (
          <span className="font-normal normal-case text-gray-400">
            · {draftCount} draft{draftCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto font-normal normal-case text-gray-400">
          click a PR to filter the feed
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-gray-200 dark:border-gray-800">
          {groups.map((g) => (
            <div key={g.teamId ?? 'none'}>
              {showGroupHeaders && (
                <div className="bg-gray-50/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:bg-gray-900/40">
                  {g.teamName}
                  <span className="font-normal"> · {g.prs.length}</span>
                </div>
              )}
              <ul className="divide-y divide-gray-100 dark:divide-gray-800/70">
                {g.prs.map((pr) => (
                  <OpenPrRow
                    key={`${g.teamId ?? 'none'}:${pr.id}`}
                    pr={pr}
                    author={pr.authorId != null ? usersById.get(pr.authorId) : undefined}
                    selected={isolatedPrId === pr.id}
                    onClick={() => setIsolatedPrId(isolatedPrId === pr.id ? null : pr.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
