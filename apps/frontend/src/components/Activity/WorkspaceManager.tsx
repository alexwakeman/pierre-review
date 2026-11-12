import { Select } from '../ui/index.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Repo, Workspace, WorkspaceRepoMode } from '@pierre-review/shared';
import { api, ApiError } from '../../api/client.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { ACTIVITY_QUERY_KEYS } from '../../hooks/useActivity.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useWorkspaces, useWorkspaceMutations } from '../../hooks/useWorkspaces.js';
import { getSyncRoundActions, useFilters } from '../../store/filters.js';
import { RepoSearch } from '../RepoSearch.js';
import { CloseIcon, PencilIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { DeepSyncIcon, EmbeddedSyncPanel } from '../SyncProgressPanel.js';
import { membershipsOf, nextGridState } from './workspaceMembership.js';

// Repo/workspace management: create/rename/delete workspaces, add repos, set how each workspace
// holds each repo, and remove repos. Opened from the WorkspaceSelector's "Manage repos &
// workspaces" entry. Every write invalidates through useWorkspaceMutations (workspaces + repos +
// Activity/Insights + flow-metric caches), so the selector, sidebar and boards follow live.
//
// THE MODEL (docs/DATA-MODEL.md § External repos):
//
//  • A repo is MAINTAINED in at most one workspace (its home: every board, report and automation
//    covers it there) and EXTERNAL in any number of others (listed, cloned by builds and fixes,
//    only its project PRs on the boards). Making a repo Maintained in a workspace turns its old home
//    External. A repo belongs to at least one workspace: taking it out of its last one removes it
//    from Limn, after a confirm.
//  • TWO VIEWS of the same facts. "Workspaces" is one workspace at a time — Maintained and External
//    sections, each repo on one line with its other memberships beside it. "Grid" is every repo ×
//    every workspace; a cell cycles none → External → Maintained → none.
//  • EVERY ROW WRITES ON ITS OWN. A removal or a change is pending PER REPO (faded, spinner), so a
//    slow removal never blocks another row — the old screen shared one mutation's `isPending` and
//    disabled every ✕ until the first delete finished.
//  • THE DEFAULT WORKSPACE IS RENAMEABLE BUT NOT DELETABLE: it is where new repos land and where a
//    deleted workspace's repos and bot rows are re-homed. Its delete control is disabled with the
//    reason on it.

type View = 'workspace' | 'grid';
const VIEW_KEY = 'limn.repoManager.view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'workspace';
  } catch {
    return 'workspace';
  }
}

function Spinner(): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-ui-line border-t-ui-accent"
    />
  );
}

const MODE_OPTIONS = [
  { value: 'watched' as const, label: 'Maintained' },
  { value: 'external' as const, label: 'External' },
];

export function WorkspaceManagerModal({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const { data: workspaces } = useWorkspaces();
  const { data: repos } = useRepos();
  const activeWorkspaceId = useFilters((s) => s.workspaceId);
  const setWorkspace = useFilters((s) => s.setWorkspace);
  const {
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    assignRepoToWorkspace,
    setWorkspaceRepoMode,
    removeRepoFromWorkspace,
  } = useWorkspaceMutations();

  // The shared sync round (driven by SyncStatus) renders as a right-hand column INSIDE this modal
  // while open; `managerOpen` routes it here.
  const syncRound = useFilters((s) => s.syncRound);
  const setManagerOpen = useFilters((s) => s.setManagerOpen);
  useEffect(() => {
    setManagerOpen(true);
    return () => setManagerOpen(false);
  }, [setManagerOpen]);

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

  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View): void => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* a per-viewer convenience only */
    }
  };

  // Quiet inline per-repo hint after a per-repo deep-sync attempt. Never a toast/alert.
  const [syncHint, setSyncHint] = useState<{ repoId: number; kind: 'cooldown' | 'error' } | null>(null);
  const syncHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (syncHintTimerRef.current != null) clearTimeout(syncHintTimerRef.current);
    },
    [],
  );
  const showSyncHint = (repoId: number, kind: 'cooldown' | 'error'): void => {
    if (syncHintTimerRef.current != null) clearTimeout(syncHintTimerRef.current);
    setSyncHint({ repoId, kind });
    syncHintTimerRef.current = setTimeout(() => {
      setSyncHint(null);
      syncHintTimerRef.current = null;
    }, 6000);
  };

  const confirmDeepResyncAll = (): void => {
    if (
      window.confirm(
        'Deep re-sync re-fetches the full backfill window for every repo. ' +
          'Slower, but catches CI/thread changes the incremental sync can lag. Continue?',
      )
    ) {
      getSyncRoundActions()?.syncAllDeep();
    }
  };

  const confirmDeepResyncRepo = (r: Repo): void => {
    if (
      !window.confirm(
        `Deep re-sync ${r.fullName}? Re-fetches its full backfill window — slower, and uses ` +
          'more GitHub quota than the regular sync. Continue?',
      )
    )
      return;
    void (async () => {
      const result = (await getSyncRoundActions()?.syncOneDeep(r.id)) ?? 'error';
      if (result !== 'started') showSyncHint(r.id, result);
    })();
  };

  const [newName, setNewName] = useState('');
  // The workspace the pane shows. `null` = not chosen here yet, RESOLVED for the render only
  // (active → default → first) and never written back.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addMode, setAddMode] = useState<WorkspaceRepoMode>('watched');

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

  const sortedRepos = useMemo(
    () => [...(repos ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [repos],
  );
  const repoById = useMemo(() => new Map(sortedRepos.map((r) => [r.id, r])), [sortedRepos]);
  const noReposYet = repos != null && repos.length === 0;

  const inSelected = useMemo(() => {
    if (selected == null) return { maintained: [] as Repo[], external: [] as Repo[] };
    const ext = new Set(selected.externalRepoIds ?? []);
    const members = selected.repoIds.map((id) => repoById.get(id)).filter((r): r is Repo => r != null);
    return {
      maintained: members.filter((r) => !ext.has(r.id)),
      external: members.filter((r) => ext.has(r.id)),
    };
  }, [selected, repoById]);
  const notInSelected = useMemo(
    () => (selected == null ? [] : sortedRepos.filter((r) => !selected.repoIds.includes(r.id))),
    [sortedRepos, selected],
  );

  // ── PER-ROW WRITES ──────────────────────────────────────────────────────────────────────────
  // `busy` is keyed per repo (and per grid cell), so each row shows its own state and no row's
  // write disables another's.
  const [busy, setBusy] = useState<Map<string, 'removing' | 'saving'>>(new Map());
  const [rowError, setRowError] = useState<{ repoId: number; message: string } | null>(null);
  const mark = (key: string, state: 'removing' | 'saving' | null): void =>
    setBusy((prev) => {
      const next = new Map(prev);
      if (state == null) next.delete(key);
      else next.set(key, state);
      return next;
    });
  const run = async (key: string, repoId: number, state: 'removing' | 'saving', work: () => Promise<unknown>) => {
    if (busy.has(key)) return;
    mark(key, state);
    setRowError(null);
    try {
      await work();
    } catch (e) {
      setRowError({ repoId, message: e instanceof ApiError ? e.message : 'That didn’t work. Try again.' });
    } finally {
      mark(key, null);
    }
  };

  // Remove a repo from Limn entirely. Invalidates the same cascade useWorkspaceMutations does.
  const deleteRepo = useMutation({
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
        'period-reports',
        'period-report',
        ...ACTIVITY_QUERY_KEYS,
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const setMembership = (repoId: number, workspaceId: number, mode: WorkspaceRepoMode) =>
    setWorkspaceRepoMode.mutateAsync({ workspaceId, repoId, mode });

  // Take a repo out of one workspace. Its last workspace: remove it from Limn, after a confirm.
  const removeFrom = (r: Repo, workspaceId: number, key: string = String(r.id)): void => {
    const count = membershipsOf(r.id, list).length;
    if (count <= 1) {
      if (!window.confirm(`Remove ${r.fullName} from Limn? It is in no other workspace, so this deletes its synced data.`)) return;
      void run(key, r.id, 'removing', () => deleteRepo.mutateAsync(r.id));
      return;
    }
    void run(key, r.id, 'removing', () => removeRepoFromWorkspace.mutateAsync({ workspaceId, repoId: r.id }));
  };

  // MOVE one membership to another workspace, keeping its mode. The target takes it first (so the
  // repo is never in no workspace), then this workspace lets it go.
  const moveMembership = (r: Repo, from: number, to: number, mode: WorkspaceRepoMode): void => {
    if (from === to) return;
    void run(String(r.id), r.id, 'saving', async () => {
      await setMembership(r.id, to, mode);
      await removeRepoFromWorkspace.mutateAsync({ workspaceId: from, repoId: r.id });
    });
  };

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

  const confirmDeleteWorkspace = (w: Workspace): void => {
    const home = defaultWorkspace?.name ?? 'Default';
    if (
      window.confirm(
        `Delete workspace “${w.name}”? Its Maintained repos move to “${home}”, along with its bot settings — ` +
          `any verdict or price already set in “${home}” is kept. Repos that are only External here leave it.`,
      )
    ) {
      deleteWorkspace.mutate(w.id);
      if (selectedId === w.id) setSelectedId(null);
    }
  };

  // A brand-new repo lands in Default server-side, Maintained. Put it where the reader asked, then
  // follow it: filing it into a workspace the reader isn't viewing would land the data out of sight.
  const onRepoAdded = (repo: Repo): void => {
    if (selected == null) return;
    const targetId = selected.id;
    const mode = addMode;
    void run(String(repo.id), repo.id, 'saving', async () => {
      if (targetId !== defaultWorkspace?.id) await assignRepoToWorkspace.mutateAsync({ workspaceId: targetId, repoId: repo.id });
      if (mode === 'external') await setMembership(repo.id, targetId, 'external');
      if (useFilters.getState().workspaceId !== targetId) setWorkspace(targetId, null);
      else useFilters.getState().showRepo(repo.id);
    });
  };

  // ── ONE ROW (workspace view) ─────────────────────────────────────────────────────────────────
  // A render function, not a component: a component defined in this body would remount every row
  // (and close its open picker) on each render.
  const workspaceRow = (r: Repo, mode: WorkspaceRepoMode): JSX.Element => {
    const state = busy.get(String(r.id));
    const others = membershipsOf(r.id, list).filter((m) => m.workspaceId !== selected?.id);
    const hint = syncHint?.repoId === r.id ? syncHint : null;
    const err = rowError?.repoId === r.id ? rowError.message : null;
    return (
      <li
        key={r.id}
        className={`group rounded-ui px-2 py-1 hover:bg-ui-hover ${state === 'removing' ? 'opacity-50' : ''}`}
        data-testid="manager-repo-row"
        aria-busy={state != null || undefined}
      >
        <div className="flex min-h-9 items-center gap-2 text-meta">
          {state != null && <Spinner />}
          <span className="min-w-0 flex-1 truncate" title={r.fullName}>
            <span className="text-ui-faint">{r.owner}/</span>
            <span className="font-medium text-ui-ink">{r.name}</span>
          </span>
          {state === 'removing' ? (
            <span className="shrink-0 text-ui-mute">Removing…</span>
          ) : (
            <>
              {others.length > 0 && (
                <span
                  className="hidden max-w-[16rem] shrink-0 truncate rounded-full border border-ui-line px-2 py-0.5 text-ui-mute sm:inline"
                  title={others.map((m) => `${m.state === 'watched' ? 'Maintained' : 'External'} in ${m.name}`).join('\n')}
                  data-testid="manager-repo-also"
                >
                  {others.length === 1
                    ? `${others[0]!.state === 'watched' ? 'Maintained' : 'External'} in ${others[0]!.name}`
                    : `Also in ${others.length} workspaces`}
                </span>
              )}
              <Select<string>
                size="sm"
                value={selected != null ? String(selected.id) : null}
                disabled={selected == null || state != null}
                label={`Workspace for ${r.fullName}`}
                className="w-36 shrink-0"
                onChange={(v) => {
                  const to = Number(v);
                  if (selected != null && Number.isFinite(to)) moveMembership(r, selected.id, to, mode);
                }}
                options={list.map((w) => ({ value: String(w.id), label: w.name }))}
              />
              <Select<WorkspaceRepoMode>
                size="sm"
                value={mode}
                disabled={selected == null || state != null}
                label={`Maintained or external: ${r.fullName}`}
                className="w-32 shrink-0"
                onChange={(next) => {
                  if (selected != null && next !== mode) void run(String(r.id), r.id, 'saving', () => setMembership(r.id, selected.id, next));
                }}
                options={MODE_OPTIONS}
              />
              <button
                type="button"
                onClick={() => confirmDeepResyncRepo(r)}
                title={`Deep re-sync ${r.fullName} — re-fetches its full backfill window`}
                aria-label={`Deep re-sync ${r.fullName}`}
                className="hit shrink-0 px-1 text-ui-faint opacity-0 hover:text-ui-ink focus:opacity-100 group-hover:opacity-100"
              >
                <DeepSyncIcon size={12} />
              </button>
              <button
                type="button"
                onClick={() => selected != null && removeFrom(r, selected.id)}
                title={others.length > 0 ? `Remove ${r.fullName} from this workspace` : `Remove ${r.fullName} from Limn`}
                aria-label={others.length > 0 ? `Remove ${r.fullName} from this workspace` : `Remove ${r.fullName} from Limn`}
                className="hit shrink-0 px-1 text-ui-faint hover:text-ui-danger"
              >
                <CloseIcon />
              </button>
            </>
          )}
        </div>
        {hint && (
          <div className="pl-1 pt-0.5 text-meta text-ui-warn">
            {hint.kind === 'cooldown'
              ? 'recently synced — try again in a moment'
              : 'couldn’t start the sync — check Sync at the bottom of the sidebar for details'}
          </div>
        )}
        {err && <div className="pl-1 pt-0.5 text-meta text-ui-danger">{err}</div>}
      </li>
    );
  };

  const section = (title: string, rows: Repo[], mode: WorkspaceRepoMode, empty: string): JSX.Element => (
    <section className="pb-3" data-testid={`manager-section-${mode}`}>
      <h3 className="px-2 pb-1 pt-1 text-meta font-semibold text-ui-faint">
        {title} · {rows.length}
      </h3>
      {rows.length === 0 ? (
        <p className="px-2 text-meta text-ui-mute">{empty}</p>
      ) : (
        <ul
          className={`space-y-px rounded-ui border p-1 ${mode === 'external' ? 'border-dashed border-ui-line' : 'border-ui-line'}`}
        >
          {rows.map((r) => workspaceRow(r, mode))}
        </ul>
      )}
    </section>
  );

  // ── THE GRID ─────────────────────────────────────────────────────────────────────────────────
  const gridCell = (r: Repo, w: Workspace, mships: ReturnType<typeof membershipsOf>): JSX.Element => {
    const here = mships.find((m) => m.workspaceId === w.id)?.state ?? null;
    const key = `${r.id}:${w.id}`;
    const state = busy.get(key);
    const next = nextGridState(here, mships.length);
    const label = `${r.fullName} in ${w.name}: ${here === 'watched' ? 'Maintained' : here === 'external' ? 'External' : 'not a member'}. Change to ${
      next === 'watched' ? 'Maintained' : next === 'external' ? 'External' : 'not a member'
    }.`;
    const onClick = (): void => {
      if (next == null) removeFrom(r, w.id, key);
      else void run(key, r.id, 'saving', () => setMembership(r.id, w.id, next));
    };
    return (
      <td key={w.id} className="border-l border-t border-ui-line px-1 py-1 text-center">
        <button
          type="button"
          onClick={onClick}
          disabled={state != null}
          aria-label={label}
          title={label}
          data-testid="manager-grid-cell"
          data-state={here ?? 'none'}
          className={`hit inline-flex h-7 min-w-[6.5rem] items-center justify-center gap-1.5 rounded-full px-2 text-meta ${
            here === 'watched'
              ? 'bg-ui-accent-fill font-medium text-ui-on-accent'
              : here === 'external'
                ? 'border border-dashed border-ui-line font-medium text-ui-ink'
                : 'text-ui-faint hover:bg-ui-hover hover:text-ui-ink'
          }`}
        >
          {state != null ? <Spinner /> : null}
          {here === 'watched' ? 'Maintained' : here === 'external' ? 'External' : '+'}
        </button>
      </td>
    );
  };

  const grid = (
    <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="manager-grid">
      {sortedRepos.length === 0 ? (
        <p className="px-1 py-3 text-meta text-ui-mute">No repos yet — search to add one above.</p>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-meta">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 bg-ui-surface px-2 py-1.5 text-left font-semibold text-ui-faint">Repository</th>
              {list.map((w) => {
                const ext = (w.externalRepoIds ?? []).length;
                return (
                  <th key={w.id} className="sticky top-0 z-10 border-l border-ui-line bg-ui-surface px-2 py-1.5 font-semibold text-ui-ink">
                    <span className="block truncate">{w.name}</span>
                    <span className="block font-normal text-ui-mute">
                      {w.repoIds.length - ext} · {ext}
                    </span>
                  </th>
                );
              })}
              <th className="sticky top-0 z-10 bg-ui-surface" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {sortedRepos.map((r) => {
              const mships = membershipsOf(r.id, list);
              const removing = busy.get(String(r.id)) === 'removing';
              const err = rowError?.repoId === r.id ? rowError.message : null;
              return (
                <tr key={r.id} className={`group ${removing ? 'opacity-50' : ''}`} data-testid="manager-grid-row">
                  <td className="max-w-[18rem] border-t border-ui-line px-2 py-1">
                    <span className="flex items-center gap-2">
                      {removing && <Spinner />}
                      <span className="min-w-0 truncate" title={r.fullName}>
                        <span className="text-ui-faint">{r.owner}/</span>
                        <span className="font-medium text-ui-ink">{r.name}</span>
                      </span>
                      {removing && <span className="shrink-0 text-ui-mute">Removing…</span>}
                    </span>
                    {err && <span className="block text-ui-danger">{err}</span>}
                  </td>
                  {list.map((w) => gridCell(r, w, mships))}
                  <td className="border-t border-ui-line px-1 text-right">
                    <button
                      type="button"
                      disabled={removing}
                      onClick={() => {
                        if (!window.confirm(`Remove ${r.fullName} from Limn? This deletes its synced data from every workspace.`)) return;
                        void run(String(r.id), r.id, 'removing', () => deleteRepo.mutateAsync(r.id));
                      }}
                      title={`Remove ${r.fullName} from Limn`}
                      aria-label={`Remove ${r.fullName} from Limn`}
                      className="hit px-1 text-ui-faint hover:text-ui-danger"
                    >
                      <CloseIcon />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );

  // ── THE WORKSPACE LIST (workspace view, left) ───────────────────────────────────────────────
  const workspaceList = (
    <div className="flex min-h-0 flex-col border-b border-ui-line md:border-b-0 md:border-r">
      <div className="border-b border-ui-line px-3 py-2">
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
            aria-label="New workspace name"
            className="min-w-0 flex-1 rounded-ui border border-ui-line bg-transparent px-2 py-1 text-meta focus:border-ui-accent/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={submitCreate}
            disabled={!newName.trim() || createWorkspace.isPending}
            className="hit shrink-0 rounded-ui bg-ui-accent-fill px-2 py-1 text-meta font-medium text-ui-on-accent disabled:bg-ui-raise disabled:text-ui-ink disabled:opacity-50"
          >
            Create
          </button>
        </div>
        {createWorkspace.error && (
          <div className="mt-1 text-meta text-ui-danger">
            {createWorkspace.error instanceof ApiError ? createWorkspace.error.message : 'Failed to create workspace'}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {workspaces == null && <div className="px-1 py-3 text-meta text-ui-mute">Loading workspaces…</div>}
        {list.map((w) => {
          const isSelected = selected?.id === w.id;
          const ext = (w.externalRepoIds ?? []).length;
          return (
            <div
              key={w.id}
              className={`group flex items-center gap-1.5 rounded-ui px-2 py-1 text-meta ${isSelected ? 'bg-ui-sel' : 'hover:bg-ui-hover'}`}
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
                  aria-label={`Rename ${w.name}`}
                  className="min-w-0 flex-1 rounded-ui border border-ui-line bg-transparent px-1.5 py-0.5 text-meta focus:border-ui-accent/50 focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectedId(w.id)}
                  aria-pressed={isSelected}
                  className="hit flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span className={`truncate ${isSelected ? 'font-semibold text-ui-accent' : 'text-ui-ink'}`}>{w.name}</span>
                  {w.isDefault && (
                    <span
                      className="shrink-0 rounded-ui bg-ui-raise px-1 text-meta text-ui-mute"
                      title="New repos land here, and a deleted workspace's repos come back here."
                    >
                      default
                    </span>
                  )}
                  <span
                    className="ml-auto shrink-0 tabular-nums text-meta text-ui-faint"
                    title={`${w.repoIds.length - ext} maintained, ${ext} external`}
                  >
                    {ext > 0 ? `${w.repoIds.length - ext} + ${ext}` : w.repoIds.length}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setEditingId(w.id);
                  setEditValue(w.name);
                }}
                title="Rename"
                aria-label={`Rename ${w.name}`}
                className="hit shrink-0 rounded-ui px-1 text-ui-faint opacity-0 hover:text-ui-ink focus:opacity-100 group-hover:opacity-100"
              >
                <PencilIcon />
              </button>
              {w.isDefault ? (
                <button
                  type="button"
                  disabled
                  title="The default workspace can’t be deleted — new repos land here, and a deleted workspace’s repos and bot settings come back here. You can rename it."
                  aria-label={`${w.name} is the default workspace and can’t be deleted`}
                  className="hit shrink-0 cursor-not-allowed rounded-ui px-1 decorative-mark text-ui-faint opacity-0 focus:opacity-100 group-hover:opacity-100"
                >
                  <CloseIcon />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => confirmDeleteWorkspace(w)}
                  title="Delete workspace"
                  aria-label={`Delete ${w.name}`}
                  className="hit shrink-0 rounded-ui px-1 text-ui-faint opacity-0 hover:text-ui-danger focus:opacity-100 group-hover:opacity-100"
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const infoButton = (
    <InfoButton title="Maintained and external repos" overModal>
      <p>
        <strong>Maintained</strong>: your team owns the repo. Limn follows all of its pull requests, it counts in
        Reports, and automatic reviews and fixes run as you set them. A repo is Maintained in one workspace at most.
      </p>
      <p className="mt-2">
        <strong>External</strong>: a repo your team changes but does not maintain, such as a shared infrastructure
        repo. It is listed under Repositories, Implement and AI Fix can change it, and its pull requests link to your
        tickets. Open PRs and Pending show only its pull requests that name one of your project keys or that people who
        maintain your repos opened. Reports leave it out, and nothing runs on it automatically. A repo can be External
        in any number of workspaces.
      </p>
    </InfoButton>
  );

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-12">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage repos and workspaces"
        className={`flex max-h-[85vh] w-full ${syncRound.open ? 'max-w-[90rem]' : 'max-w-6xl'} flex-col rounded-ui bg-ui-surface shadow-xl`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ui-line px-4 py-2.5">
          <span className="flex items-center gap-1 text-body font-semibold text-ui-ink">
            Repos &amp; workspaces
            {infoButton}
          </span>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="View" className="flex rounded-ui border border-ui-line p-0.5">
              {(
                [
                  ['workspace', 'Workspaces'],
                  ['grid', 'Grid'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  data-testid={`manager-view-${v}`}
                  className={`hit rounded-ui px-2 py-0.5 text-meta ${view === v ? 'bg-ui-sel font-medium text-ui-ink' : 'text-ui-mute hover:text-ui-ink'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={confirmDeepResyncAll}
              disabled={syncRound.syncing}
              title="Force a full backfill for all repos"
              className="hit flex items-center gap-1.5 rounded-ui bg-ui-raise px-2 py-1 text-meta text-ui-mute hover:bg-ui-hover disabled:opacity-50"
            >
              <DeepSyncIcon size={12} />
              Deep re-sync all
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="hit rounded-ui p-1 text-ui-faint hover:bg-ui-hover hover:text-ui-ink"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>

        {noReposYet && (
          <div className="border-b border-ui-line bg-ui-sel px-4 py-3">
            <div className="text-body font-semibold text-ui-ink">Add a repo to get started</div>
            <p className="mt-0.5 text-meta text-ui-mute">
              Search GitHub for a repo by name, or pick one of the suggested public repos to try Limn out.
            </p>
          </div>
        )}

        <div
          className={`grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-b-ui ${
            view === 'workspace'
              ? syncRound.open
                ? 'md:grid-cols-[15rem_1fr_20rem]'
                : 'md:grid-cols-[15rem_1fr]'
              : syncRound.open
                ? 'md:grid-cols-[1fr_20rem]'
                : ''
          }`}
        >
          {view === 'workspace' && workspaceList}

          {view === 'workspace' ? (
            <div className="flex min-h-0 flex-col">
              {/* The add row sits OUTSIDE the scrolling list so RepoSearch's dropdown isn't clipped. */}
              <div className="relative z-20 border-b border-ui-line px-3 py-2">
                <div className="flex items-center justify-between gap-2 pb-2">
                  <h2 className="truncate text-body font-semibold text-ui-ink">{selected?.name ?? ''}</h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-[16rem] flex-1">
                    <RepoSearch
                      fullWidth
                      autoFocus={noReposYet}
                      placeholder={selected ? `Type to find a repo on GitHub for ${selected.name}…` : 'Type to find a repo on GitHub…'}
                      onAdded={onRepoAdded}
                    />
                  </div>
                  <span className="text-meta text-ui-mute">Add as</span>
                  <Select<WorkspaceRepoMode>
                    size="sm"
                    value={addMode}
                    label="Add new repos as"
                    className="w-32"
                    onChange={setAddMode}
                    options={MODE_OPTIONS}
                  />
                  {notInSelected.length > 0 && selected != null && (
                    <Select<string>
                      size="sm"
                      value={null}
                      label={`Add one of your repos to ${selected.name}`}
                      placeholder="Add one of your repos…"
                      className="w-56"
                      onChange={(v) => {
                        const r = repoById.get(Number(v));
                        if (r != null) void run(String(r.id), r.id, 'saving', () => setMembership(r.id, selected.id, addMode));
                      }}
                      options={notInSelected.map((r) => ({ value: String(r.id), label: r.fullName }))}
                    />
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {selected == null ? null : (
                  <>
                    {section('Maintained', inSelected.maintained, 'watched', 'No maintained repos here yet.')}
                    {section('External', inSelected.external, 'external', 'No external repos here.')}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-col">
              <div className="relative z-20 flex flex-wrap items-center gap-2 border-b border-ui-line px-3 py-2">
                <div className="min-w-[16rem] flex-1">
                  <RepoSearch
                    fullWidth
                    autoFocus={noReposYet}
                    placeholder="Type to find a repo on GitHub…"
                    onAdded={(repo) => useFilters.getState().showRepo(repo.id)}
                  />
                </div>
                <span className="text-meta text-ui-mute">
                  New repos join {defaultWorkspace?.name ?? 'Default'}. Click a cell to change it.
                </span>
              </div>
              {grid}
            </div>
          )}

          {syncRound.open && (
            <div className="flex min-h-0 flex-col border-t border-ui-line md:border-l md:border-t-0">
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <EmbeddedSyncPanel />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
