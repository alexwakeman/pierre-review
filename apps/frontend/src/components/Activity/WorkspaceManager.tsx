import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Repo, Workspace } from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { ACTIVITY_QUERY_KEYS } from '../../hooks/useActivity.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useWorkspaces, useWorkspaceMutations } from '../../hooks/useWorkspaces.js';
import { useFilters } from '../../store/filters.js';
import { RepoSearch } from '../RepoSearch.js';

// Repo/workspace management for the Activity console: create/rename/delete workspaces, MOVE the
// account's repos between them, add brand-new repos, and remove repos entirely. Opened from the
// header WorkspaceSelector's "Manage repos & workspaces" entry. All mutations flow through
// useWorkspaceMutations (which invalidates the workspaces + repos + Activity/Insights + flow-metric
// caches), so the selector/rail/feed track changes live.
//
// TWO RULES SHAPE THIS WHOLE SCREEN, and neither is cosmetic:
//
//  • A REPO BELONGS TO EXACTLY ONE WORKSPACE — a database fact (`workspace_repos`, UNIQUE
//    (account_id, repo_id)). So assignment is a MOVE, not a membership toggle, and the control is a
//    per-repo workspace PICKER rather than a checkbox: a checkbox says "also in", which is not a
//    state that exists. There is no "unassign", no "No workspace" row and no unassigned roster —
//    taking a repo out of a workspace is spelled "move it to Default".
//  • THE DEFAULT WORKSPACE IS RENAMEABLE BUT NOT DELETABLE. It is where new repos land and where a
//    deleted workspace's repos AND its bot rows (verdicts, vendor names, prices) are re-homed. The
//    delete control is rendered DISABLED with the reason on it rather than left live to 409 —
//    "click it and read the error" is not an explanation.
export function WorkspaceManagerModal({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const { data: workspaces } = useWorkspaces();
  const { data: repos } = useRepos();
  const activeWorkspaceId = useFilters((s) => s.workspaceId);
  const { createWorkspace, renameWorkspace, deleteWorkspace, assignRepoToWorkspace } =
    useWorkspaceMutations();

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
  // The workspace the add-repo box targets and the right pane leads with. `null` means "not chosen
  // in this modal yet" and is RESOLVED for the render only (active workspace → default → first) —
  // never written back, so opening the modal, deleting the workspace you were on, and having the
  // pane fall back cannot silently overwrite a choice the user did make.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  const list: Workspace[] = useMemo(() => workspaces ?? [], [workspaces]);
  const defaultWorkspace = useMemo(() => list.find((w) => w.isDefault) ?? null, [list]);
  const selected = useMemo(
    () =>
      list.find((w) => w.id === selectedId) ??
      list.find((w) => w.id === activeWorkspaceId) ??
      defaultWorkspace ??
      list[0] ??
      null,
    [list, selectedId, activeWorkspaceId, defaultWorkspace],
  );

  // A repo's CURRENT workspace comes off the repo row itself (`Repo.workspaceId`) — the wire fact,
  // one source. A membership the roster hasn't caught up with (a repo whose workspace was just
  // deleted, mid-invalidation) falls back to Default so the picker never renders blank.
  const homeOf = useMemo(() => {
    const known = new Set(list.map((w) => w.id));
    const fallback = defaultWorkspace?.id ?? null;
    return (r: Repo): number | null => (known.has(r.workspaceId) ? r.workspaceId : fallback);
  }, [list, defaultWorkspace]);

  const sortedRepos = useMemo(
    () => [...(repos ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [repos],
  );
  const inSelected = useMemo(
    () => (selected ? sortedRepos.filter((r) => homeOf(r) === selected.id) : []),
    [sortedRepos, selected, homeOf],
  );
  const elsewhere = useMemo(
    () => (selected ? sortedRepos.filter((r) => homeOf(r) !== selected.id) : sortedRepos),
    [sortedRepos, selected, homeOf],
  );

  // Remove (delete) a repo entirely. Invalidates the same cache cascade as the old FilterBar path.
  // ⚠ 'workspaces' (NOT the long-dead 'teams') plus the three flow-metric keys: deleting a repo
  // changes a workspace's membership without changing its ID, so ['workspace-metrics', id] and
  // ['workspace-metrics-detail', id] would not refetch on their own, and ['workspace-comparison']
  // carries no id at all. Same set useWorkspaceMutations invalidates — spelled out here because
  // that list is module-private to useWorkspaces.ts.
  const removeRepo = useMutation({
    mutationFn: (id: number) => api.deleteRepo(id),
    onSettled: () => {
      for (const key of [
        'repos',
        'timeline',
        'open-prs',
        'users',
        'my-turn',
        'me',
        'workspaces',
        'workspace-metrics',
        'workspace-metrics-detail',
        'workspace-comparison',
        ...ACTIVITY_QUERY_KEYS,
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const submitCreate = (): void => {
    const name = newName.trim();
    if (!name) return;
    createWorkspace.mutate(name, {
      onSuccess: (res) => {
        setNewName('');
        setSelectedId(res.workspace.id);
      },
    });
  };

  const submitRename = (id: number): void => {
    const name = editValue.trim();
    if (name) renameWorkspace.mutate({ id, name });
    setEditingId(null);
  };

  const moveRepo = (repoId: number, workspaceId: number): void => {
    assignRepoToWorkspace.mutate({ workspaceId, repoId });
  };

  const confirmRemoveRepo = (r: Repo): void => {
    if (window.confirm(`Remove ${r.fullName}? This deletes all of its locally-synced data.`)) {
      removeRepo.mutate(r.id);
    }
  };

  const confirmDeleteWorkspace = (w: Workspace): void => {
    const home = defaultWorkspace?.name ?? 'Default';
    if (
      window.confirm(
        `Delete workspace “${w.name}”? Its repos move to “${home}”, along with its bot settings — ` +
          `any verdict or price already set in “${home}” is kept.`,
      )
    ) {
      deleteWorkspace.mutate(w.id);
      if (selectedId === w.id) setSelectedId(null);
    }
  };

  // One repo row: its name, the workspace PICKER (changing it moves the repo), and the destructive
  // remove-from-the-account action.
  const RepoRow = (r: Repo): JSX.Element => {
    const current = homeOf(r);
    return (
      <li
        key={r.id}
        className="group flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <span className="min-w-0 flex-1 truncate" title={r.fullName}>
          <span className="text-gray-400">{r.owner}/</span>
          <span className="font-medium text-gray-800 dark:text-gray-100">{r.name}</span>
        </span>
        <select
          value={current ?? ''}
          disabled={current == null || assignRepoToWorkspace.isPending}
          aria-label={`Workspace for ${r.fullName}`}
          title={`Move ${r.fullName} to another workspace (it leaves the one it's in now)`}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next) && next !== current) moveRepo(r.id, next);
          }}
          className="max-w-[9rem] shrink-0 truncate rounded border border-gray-300 bg-transparent px-1 py-0.5 text-[11px] focus:border-blue-500 focus:outline-none disabled:opacity-40 dark:border-gray-700"
        >
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
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
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-16">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage repos and workspaces"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5 dark:border-gray-800">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Repos &amp; workspaces
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

        {/* Add-repo toolbar. Sits OUTSIDE the scrolling grid so RepoSearch's absolute dropdown
            isn't clipped. A newly-added repo lands in Default server-side; `onAdded` immediately
            moves it into the workspace on screen. */}
        <div className="relative z-20 flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          {selected ? (
            <RepoSearch
              placeholder={`Add a repo to ${selected.name}…`}
              onAdded={(repo) => moveRepo(repo.id, selected.id)}
            />
          ) : (
            <RepoSearch />
          )}
          <span className="min-w-0 truncate text-[11px] text-gray-400">
            {selected ? `New repos join “${selected.name}”` : ''}
          </span>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden rounded-b-lg md:grid-cols-2">
          {/* LEFT: workspaces list + create */}
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
                  placeholder="New workspace name…"
                  className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
                />
                <button
                  type="button"
                  onClick={submitCreate}
                  disabled={!newName.trim() || createWorkspace.isPending}
                  className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  Create
                </button>
              </div>
              {createWorkspace.error && (
                <div className="mt-1 text-[11px] text-red-500">
                  {createWorkspace.error instanceof ApiError
                    ? createWorkspace.error.message
                    : 'Failed to create workspace'}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {/* No "no workspaces yet" empty state exists: `GET /api/workspaces` ensures the
                  account's Default row before it answers, so the list is only ever empty while the
                  query is in flight. */}
              {workspaces == null && (
                <div className="px-1 py-3 text-xs text-gray-500">Loading workspaces…</div>
              )}
              {list.map((w) => {
                const isSelected = selected?.id === w.id;
                return (
                  <div
                    key={w.id}
                    className={`group flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                      isSelected
                        ? 'bg-sky-50 dark:bg-sky-950/30'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    {editingId === w.id ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            submitRename(w.id);
                          } else if (e.key === 'Escape') {
                            e.stopPropagation();
                            setEditingId(null);
                          }
                        }}
                        onBlur={() => submitRename(w.id)}
                        className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-1.5 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSelectedId(w.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <span
                          className={`truncate ${isSelected ? 'font-semibold text-sky-700 dark:text-sky-300' : 'text-gray-700 dark:text-gray-200'}`}
                        >
                          {w.name}
                        </span>
                        {w.isDefault && (
                          <span
                            className="shrink-0 rounded bg-gray-100 px-1 text-[9px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                            title="New repos land here, and a deleted workspace's repos come back here."
                          >
                            default
                          </span>
                        )}
                        <span className="shrink-0 tabular-nums text-[10px] text-gray-400">
                          {w.repoCount}
                        </span>
                      </button>
                    )}
                    {/* Rename is allowed on EVERY workspace, the default included — naming it is a
                        different thing entirely from deleting it. */}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(w.id);
                        setEditValue(w.name);
                      }}
                      title="Rename"
                      aria-label={`Rename ${w.name}`}
                      className="shrink-0 rounded px-1 text-gray-400 opacity-0 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100 dark:hover:text-gray-200"
                    >
                      ✎
                    </button>
                    {w.isDefault ? (
                      /* Disabled, with the reason ON the control. The route 409s on this row, but
                         a button that only explains itself after you press it is not an
                         explanation — and this one can never succeed. */
                      <button
                        type="button"
                        disabled
                        title="The default workspace can’t be deleted — new repos land here, and a deleted workspace’s repos and bot settings come back here. You can rename it."
                        aria-label={`${w.name} is the default workspace and can’t be deleted`}
                        className="shrink-0 cursor-not-allowed rounded px-1 text-gray-300 opacity-0 focus:opacity-100 group-hover:opacity-100 dark:text-gray-600"
                      >
                        ✕
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => confirmDeleteWorkspace(w)}
                        title="Delete workspace"
                        aria-label={`Delete ${w.name}`}
                        className="shrink-0 rounded px-1 text-gray-400 opacity-0 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT: the account's repos, each showing the ONE workspace it lives in */}
          <div className="flex min-h-0 flex-col">
            <div className="border-b border-gray-100 px-3 py-2 dark:border-gray-800">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Repos
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400">
                Every repo lives in exactly one workspace. Changing a repo’s workspace MOVES it — it
                leaves the one it’s in now.
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {sortedRepos.length === 0 ? (
                <div className="px-1 py-3 text-xs text-gray-500">
                  No repos yet — search to add one above.
                </div>
              ) : (
                <>
                  {selected && (
                    <>
                      <div className="px-1 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        In “{selected.name}” · {inSelected.length}
                      </div>
                      {inSelected.length === 0 ? (
                        <div className="px-1 pb-2 text-xs text-gray-500">
                          No repos in this workspace yet — move one in below, or add one above.
                        </div>
                      ) : (
                        <ul className="space-y-0.5 pb-2">{inSelected.map(RepoRow)}</ul>
                      )}
                    </>
                  )}
                  {elsewhere.length > 0 && (
                    <>
                      <div className="border-t border-gray-100 px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800">
                        In other workspaces · {elsewhere.length}
                      </div>
                      <ul className="space-y-0.5">{elsewhere.map(RepoRow)}</ul>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
