import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Team, TeamScope, TeamsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_QUERY_KEYS } from './useActivity.js';

// Every query key touched by a team-membership change. Assigning a repo to a team auto-watches
// it server-side, so the repo list + the whole Activity/Insights surface must refresh alongside
// the ['teams'] cache.
const TEAM_INVALIDATE_KEYS = ['teams', 'repos', ...ACTIVITY_QUERY_KEYS] as const;

// The account's teams (CORE). A plain snapshot query; mutations below invalidate ['teams'].
export function useTeams() {
  return useQuery<Team[]>({
    queryKey: ['teams'],
    queryFn: () => api.listTeams().then((r: TeamsResponse) => r.teams),
  });
}

// Bundle of the team-mutation hooks. Each invalidates ['teams'] + the repos/activity keys on
// settle so the rail, feed, repo list and scope selector all track the change live.
export function useTeamMutations() {
  const qc = useQueryClient();
  const invalidate = (): void => {
    for (const key of TEAM_INVALIDATE_KEYS) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const createTeam = useMutation({
    mutationFn: (name: string) => api.createTeam(name),
    onSettled: invalidate,
  });
  const renameTeam = useMutation({
    mutationFn: (v: { id: number; name: string }) => api.renameTeam(v.id, { name: v.name }),
    onSettled: invalidate,
  });
  const deleteTeam = useMutation({
    mutationFn: (id: number) => api.deleteTeam(id),
    onSettled: invalidate,
  });
  const assignRepoToTeam = useMutation({
    mutationFn: (v: { teamId: number; repoId: number }) =>
      api.assignRepoToTeam(v.teamId, v.repoId),
    onSettled: invalidate,
  });
  const unassignRepoFromTeam = useMutation({
    mutationFn: (v: { teamId: number; repoId: number }) =>
      api.unassignRepoFromTeam(v.teamId, v.repoId),
    onSettled: invalidate,
  });
  const setTeamRepos = useMutation({
    mutationFn: (v: { id: number; repoIds: number[] }) => api.setTeamRepos(v.id, v.repoIds),
    onSettled: invalidate,
  });

  return {
    createTeam,
    renameTeam,
    deleteTeam,
    assignRepoToTeam,
    unassignRepoFromTeam,
    setTeamRepos,
  };
}

/**
 * Resolve a TeamScope to the concrete repo-id visibility filter:
 *  • 'all'    → null (no filter — every repo shown)
 *  • 'teams'  → the UNION of every team's repos (cross-team monitoring; differs from 'all',
 *               which is every repo incl. unassigned). Empty array when there are no team repos.
 *  • 'none'   → the account repos in NO team (allRepoIds minus the union of every team's repoIds)
 *  • teamId   → that team's repoIds (empty array if the team is unknown/empty)
 *  • teamId[] → the UNION of just those teams' repoIds (a multi-team selection)
 * Mirrors the backend's resolveScopeRepoIds so the client-side scope and the server-side one agree.
 */
export function resolveScopeRepoIds(
  scope: TeamScope,
  teams: Team[],
  allRepoIds: number[],
): number[] | null {
  if (scope === 'all') return null;
  if (scope === 'teams') {
    const inSomeTeam = new Set<number>();
    for (const t of teams) for (const id of t.repoIds) inSomeTeam.add(id);
    return [...inSomeTeam];
  }
  if (scope === 'none') {
    const inSomeTeam = new Set<number>();
    for (const t of teams) for (const id of t.repoIds) inSomeTeam.add(id);
    return allRepoIds.filter((id) => !inSomeTeam.has(id));
  }
  if (Array.isArray(scope)) {
    const wanted = new Set(scope);
    const ids = new Set<number>();
    for (const t of teams) if (wanted.has(t.id)) for (const id of t.repoIds) ids.add(id);
    return [...ids];
  }
  const team = teams.find((t) => t.id === scope);
  return team ? [...team.repoIds] : [];
}
