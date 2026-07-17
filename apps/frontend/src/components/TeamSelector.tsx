import { useEffect, useRef, useState } from 'react';
import type { TeamScope } from '@pierre-review/shared';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useRepos } from '../hooks/useTimeline.js';
import { resolveScopeRepoIds, useTeams } from '../hooks/useTeams.js';
import { useFilters } from '../store/filters.js';
import { TeamManagerModal } from './Activity/TeamManager.js';

// Order-insensitive nullable-set equality (null = "all", distinct from []).
function sameIds(a: number[] | null, b: number[] | null): boolean {
  if (a == null || b == null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Keep the resolved repoIds in lockstep with a non-'all' teamScope. Runs when the teams list
// loads/changes or the scope changes: a URL-restored `team=<id>` sets teamScope before the
// teams data arrives, so this re-derives repoIds once it does. Guarded so it only writes when
// the derived ids actually differ (no render loop). A dangling team id (deleted team) resets
// the scope to 'all'.
export function useTeamScopeSync(): void {
  const teamScope = useFilters((s) => s.teamScope);
  const setTeamScope = useFilters((s) => s.setTeamScope);
  const { data: teams } = useTeams();
  const { data: repos } = useRepos();

  useEffect(() => {
    if (teamScope === 'all' || teams == null || repos == null) return;
    if (typeof teamScope === 'number' && !teams.some((t) => t.id === teamScope)) {
      // The selected team no longer exists — fall back to the all-repos scope.
      if (useFilters.getState().repoIds != null) setTeamScope('all', null);
      return;
    }
    const derived = resolveScopeRepoIds(
      teamScope,
      teams,
      repos.map((r) => r.id),
    );
    if (!sameIds(useFilters.getState().repoIds, derived)) {
      setTeamScope(teamScope, derived);
    }
  }, [teamScope, teams, repos, setTeamScope]);
}

// A compact dropdown to pick the active TEAM scope: All repos ('all'), All Teams ('teams', the
// union of every team's repos — cross-team monitoring), each team, or No team ('none'). Picking
// one resolves the scope → repoIds and sets both via setTeamScope. Mounted in the FilterBar
// (Timeline) and the Activity rail header.
export function TeamSelector(): JSX.Element {
  const teamScope = useFilters((s) => s.teamScope);
  const setTeamScope = useFilters((s) => s.setTeamScope);
  const { data: teams } = useTeams();
  const { data: repos } = useRepos();
  const [open, setOpen] = useState(false);
  // Repo/team management now lives INSIDE this dropdown (no separate rail button) — an
  // entry at the bottom opens the full management modal.
  const [manageOpen, setManageOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep repoIds resolved as teams load / change (see the hook above).
  useTeamScopeSync();

  useClickOutside(rootRef, () => setOpen(false), open);

  const pick = (scope: TeamScope): void => {
    const derived = resolveScopeRepoIds(scope, teams ?? [], (repos ?? []).map((r) => r.id));
    setTeamScope(scope, derived);
    setOpen(false);
  };

  const activeLabel =
    teamScope === 'all'
      ? 'All repos'
      : teamScope === 'teams'
        ? 'All Teams'
        : teamScope === 'none'
          ? 'No team'
          : (teams?.find((t) => t.id === teamScope)?.name ?? 'Team');

  // The union of every team's repos (the 'teams' scope) — its count for the option row.
  const unionCount = new Set((teams ?? []).flatMap((t) => t.repoIds)).size;

  const rowCls = (active: boolean): string =>
    `flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs ${
      active
        ? 'bg-sky-50 font-medium text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'
    }`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Scope to a team of repos"
        className="inline-flex max-w-[12rem] items-center gap-1 whitespace-nowrap rounded-full border border-gray-300 py-0.5 pl-2.5 pr-2 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
      >
        <span aria-hidden className="text-sky-500">
          ◈
        </span>
        <span className="truncate">{activeLabel}</span>
        <span aria-hidden className="text-[9px]">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Team scope"
          className="absolute left-0 top-full z-[60] mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <button type="button" role="menuitem" onClick={() => pick('all')} className={rowCls(teamScope === 'all')}>
            <span className="truncate">All repos</span>
          </button>
          {(teams ?? []).length > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => pick('teams')}
              className={rowCls(teamScope === 'teams')}
              title="Monitor every team together — the union of all teams' repos, grouped by team"
            >
              <span className="truncate">All Teams</span>
              <span className="shrink-0 tabular-nums text-[10px] text-gray-400">{unionCount}</span>
            </button>
          )}
          {(teams ?? []).length > 0 && (
            <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          )}
          {(teams ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              onClick={() => pick(t.id)}
              className={rowCls(teamScope === t.id)}
            >
              <span className="truncate">{t.name}</span>
              <span className="shrink-0 tabular-nums text-[10px] text-gray-400">
                {t.repoCount}
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => pick('none')}
            className={rowCls(teamScope === 'none')}
            title="Repos that aren't in any team"
          >
            <span className="truncate">No team</span>
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          {/* Repo/team management — add/remove repos, create teams, assign repos to them. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setManageOpen(true);
            }}
            title="Add or remove repos, create teams, and assign repos to them"
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <span aria-hidden>⚙</span>
            <span className="truncate">Manage repos &amp; teams</span>
            {(teams ?? []).length > 0 && (
              <span className="ml-auto shrink-0 tabular-nums text-[10px] text-gray-400">
                {(teams ?? []).length}
              </span>
            )}
          </button>
        </div>
      )}
      {manageOpen && <TeamManagerModal onClose={() => setManageOpen(false)} />}
    </div>
  );
}
