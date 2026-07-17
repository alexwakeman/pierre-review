import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Repo } from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { ACTIVITY_QUERY_KEYS } from '../../hooks/useActivity.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useTeams, useTeamMutations } from '../../hooks/useTeams.js';
import { RepoSearch } from '../RepoSearch.js';

// Repo/team management for the Activity console: create/rename/delete teams, assign & unassign
// the account's repos to the selected team, add brand-new repos (auto-assigned to the selected
// team), remove repos, and see the "No team" (ad-hoc) repos. The modal is opened from the header
// TeamSelector's "Manage repos & teams" entry. All mutations flow through useTeamMutations (which
// invalidates the teams + repos + Activity/Insights caches), so the rail/feed/scope selector
// track changes live.
export function TeamManagerModal({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const { data: teams } = useTeams();
  const { data: repos } = useRepos();
  const {
    createTeam,
    renameTeam,
    deleteTeam,
    assignRepoToTeam,
    unassignRepoFromTeam,
  } = useTeamMutations();

  const panelRef = useRef<HTMLDivElement>(null);
  useClickOutside(panelRef, onClose, true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [newName, setNewName] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  // Default the selection to the first team once loaded (so the assignment panel isn't empty).
  useEffect(() => {
    if (selectedTeamId == null && teams && teams.length > 0) {
      setSelectedTeamId(teams[0]!.id);
    }
  }, [teams, selectedTeamId]);

  const selectedTeam = teams?.find((t) => t.id === selectedTeamId) ?? null;
  const teamRepoIds = useMemo(
    () => new Set(selectedTeam?.repoIds ?? []),
    [selectedTeam],
  );

  // Repos in NO team (ad-hoc) — the union of every team's members subtracted from the roster.
  const orphanRepoIds = useMemo(() => {
    const inSomeTeam = new Set<number>();
    for (const t of teams ?? []) for (const id of t.repoIds) inSomeTeam.add(id);
    return new Set((repos ?? []).filter((r) => !inSomeTeam.has(r.id)).map((r) => r.id));
  }, [teams, repos]);

  // Remove (delete) a repo entirely. Invalidates the same cache cascade as the old FilterBar path.
  const removeRepo = useMutation({
    mutationFn: (id: number) => api.deleteRepo(id),
    onSettled: () => {
      for (const key of ['repos', 'timeline', 'open-prs', 'users', 'my-turn', 'me', 'teams', ...ACTIVITY_QUERY_KEYS]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const submitCreate = (): void => {
    const name = newName.trim();
    if (!name) return;
    createTeam.mutate(name, {
      onSuccess: (res) => {
        setNewName('');
        setSelectedTeamId(res.team.id);
      },
    });
  };

  const submitRename = (id: number): void => {
    const name = editValue.trim();
    if (name) renameTeam.mutate({ id, name });
    setEditingId(null);
  };

  const toggleRepoInTeam = (repoId: number): void => {
    if (selectedTeam == null) return;
    if (teamRepoIds.has(repoId)) {
      unassignRepoFromTeam.mutate({ teamId: selectedTeam.id, repoId });
    } else {
      assignRepoToTeam.mutate({ teamId: selectedTeam.id, repoId });
    }
  };

  const confirmRemoveRepo = (r: Repo): void => {
    if (window.confirm(`Remove ${r.fullName}? This deletes all of its locally-synced data.`)) {
      removeRepo.mutate(r.id);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-16">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage repos and teams"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5 dark:border-gray-800">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Repos &amp; teams
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        {/* Add-repo toolbar. Sits OUTSIDE the scrolling grid so RepoSearch's absolute
            dropdown isn't clipped. Adding while a team is selected auto-assigns to it. */}
        <div className="relative z-20 flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          {selectedTeam ? (
            <RepoSearch
              placeholder={`Add a repo to ${selectedTeam.name}…`}
              onAdded={(repo) =>
                assignRepoToTeam.mutate({ teamId: selectedTeam.id, repoId: repo.id })
              }
            />
          ) : (
            <RepoSearch />
          )}
          <span className="min-w-0 truncate text-[11px] text-gray-400">
            {selectedTeam
              ? `New repos join "${selectedTeam.name}"`
              : 'Select a team to auto-assign new repos'}
          </span>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden rounded-b-lg md:grid-cols-2">
          {/* LEFT: teams list + create */}
          <div className="flex min-h-0 flex-col border-b border-gray-200 md:border-b-0 md:border-r dark:border-gray-800">
            <div className="border-b border-gray-100 px-3 py-2 dark:border-gray-800">
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitCreate();
                    }
                  }}
                  placeholder="New team name…"
                  className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
                />
                <button
                  type="button"
                  onClick={submitCreate}
                  disabled={!newName.trim() || createTeam.isPending}
                  className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  Create
                </button>
              </div>
              {createTeam.error && (
                <div className="mt-1 text-[11px] text-red-500">
                  {createTeam.error instanceof ApiError ? createTeam.error.message : 'Failed to create team'}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {(teams ?? []).length === 0 ? (
                <div className="px-1 py-3 text-xs text-gray-500">
                  No teams yet. Create one above, then assign repos to it.
                </div>
              ) : (
                (teams ?? []).map((t) => {
                  const selected = t.id === selectedTeamId;
                  return (
                    <div
                      key={t.id}
                      className={`group flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                        selected
                          ? 'bg-sky-50 dark:bg-sky-950/30'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                    >
                      {editingId === t.id ? (
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              submitRename(t.id);
                            } else if (e.key === 'Escape') {
                              e.stopPropagation();
                              setEditingId(null);
                            }
                          }}
                          onBlur={() => submitRename(t.id)}
                          className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-1.5 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setSelectedTeamId(t.id)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          <span
                            className={`truncate ${selected ? 'font-semibold text-sky-700 dark:text-sky-300' : 'text-gray-700 dark:text-gray-200'}`}
                          >
                            {t.name}
                          </span>
                          <span className="shrink-0 tabular-nums text-[10px] text-gray-400">
                            {t.repoCount}
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(t.id);
                          setEditValue(t.name);
                        }}
                        title="Rename"
                        aria-label={`Rename ${t.name}`}
                        className="shrink-0 rounded px-1 text-gray-400 opacity-0 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100 dark:hover:text-gray-200"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete team "${t.name}"? Its repos are kept (they just leave the team).`)) {
                            deleteTeam.mutate(t.id);
                            if (selectedTeamId === t.id) setSelectedTeamId(null);
                          }
                        }}
                        title="Delete team"
                        aria-label={`Delete ${t.name}`}
                        className="shrink-0 rounded px-1 text-gray-400 opacity-0 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* RIGHT: repo assignment for the selected team + the roster */}
          <div className="flex min-h-0 flex-col">
            <div className="border-b border-gray-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800">
              {selectedTeam
                ? `Repos in ${selectedTeam.name}`
                : 'All repos — select a team to assign'}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {(repos ?? []).length === 0 ? (
                <div className="px-1 py-3 text-xs text-gray-500">
                  No repos yet — search to add one above.
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {(repos ?? []).map((r) => {
                    const inTeam = teamRepoIds.has(r.id);
                    const orphan = orphanRepoIds.has(r.id);
                    return (
                      <li
                        key={r.id}
                        className="group flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        <label
                          className={`flex min-w-0 flex-1 items-center gap-2 ${selectedTeam ? 'cursor-pointer' : 'cursor-default'}`}
                        >
                          <input
                            type="checkbox"
                            checked={inTeam}
                            disabled={selectedTeam == null}
                            onChange={() => toggleRepoInTeam(r.id)}
                            title={
                              selectedTeam == null
                                ? 'Select a team to assign repos'
                                : inTeam
                                  ? `Remove from ${selectedTeam.name}`
                                  : `Add to ${selectedTeam.name}`
                            }
                          />
                          <span className="min-w-0 truncate" title={r.fullName}>
                            <span className="text-gray-400">{r.owner}/</span>
                            <span className="font-medium text-gray-800 dark:text-gray-100">{r.name}</span>
                          </span>
                          {orphan && (
                            <span
                              className="shrink-0 rounded bg-gray-100 px-1 text-[9px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                              title="Not in any team"
                            >
                              no team
                            </span>
                          )}
                        </label>
                        <button
                          type="button"
                          onClick={() => confirmRemoveRepo(r)}
                          disabled={removeRepo.isPending}
                          title={`Remove ${r.fullName}`}
                          aria-label={`Remove ${r.fullName}`}
                          className="shrink-0 px-1 text-gray-400 opacity-0 hover:text-red-500 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
