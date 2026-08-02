import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '@pierre-review/shared';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useWorkspaces } from '../hooks/useWorkspaces.js';
import { useFilters } from '../store/filters.js';
import { WorkspaceManagerModal } from './Activity/WorkspaceManager.js';

/**
 * Keep `workspaceId` resolved and `repoIds` HONEST — and note what it deliberately does NOT do.
 *
 * This replaced `useTeamScopeSync`, which kept `repoIds` "in lockstep" with the scope's membership:
 * it re-derived the ids from the scope on EVERY run and overwrote whenever the stored array
 * differed. That was survivable only because the old `'all'` scope early-returned before that line.
 * There is no `'all'` scope any more — a workspace is always a concrete repo set — so re-deriving
 * on every run would REVERT the per-repo show/hide the user just made, on the next background
 * refetch of a React Query result whose identity changes even when its data does not.
 *
 * The contract is therefore three cases, and only two of them may REPLACE the array:
 *
 *  1. `workspaceId` is null (never resolved) or names no live workspace (deleted, or another
 *     account's id restored from localStorage / a stale link) ⇒ adopt the account's Default and
 *     show all of it.
 *  2. The workspace CHANGED (the user picked a different one) ⇒ show all of the new one.
 *  3. Otherwise ⇒ PRUNE ONLY. Drop stored ids that are no longer in the workspace (a repo was
 *     moved out from the manager) and leave a user-narrowed subset — and `null` — alone.
 *
 * ⚠ The previous workspace id lives in a REF, and the write-only-if-different guard is necessary
 * but NOT sufficient on its own: without the ref there is no way to tell "the user switched
 * workspace" (case 2, replace) from "the same workspace re-rendered" (case 3, prune), and every
 * refetch would look like a switch.
 *
 * ⚠ The ref starts as "not yet observed", NOT as a workspace id, so the FIRST run over an already
 * live workspace takes the PRUNE path. A `?workspace=5&repos=7,9` deep link must keep its `repos`
 * narrowing (minus any id that is not in workspace 5) rather than being widened back to the whole
 * workspace on mount.
 */
export function useWorkspaceSync(): void {
  const workspaceId = useFilters((s) => s.workspaceId);
  const setWorkspace = useFilters((s) => s.setWorkspace);
  const setRepoIds = useFilters((s) => s.setRepoIds);
  const { data: workspaces } = useWorkspaces();

  // null = "no workspace observed yet" — see the note above. It is NOT a workspace id.
  const prevWorkspaceRef = useRef<number | null>(null);

  useEffect(() => {
    // The server ENSURES a Default before answering, so a loaded list is never empty; an empty one
    // means something is wrong upstream and writing a scope from it would be a guess.
    if (workspaces == null || workspaces.length === 0) return;

    const live = workspaceId == null ? undefined : workspaces.find((w) => w.id === workspaceId);

    // (1) Unresolved, or an id that names no live workspace → the account's Default, showing all
    // of it. This is the only path that may replace the array without the user having asked.
    if (live == null) {
      const fallback = workspaces.find((w) => w.isDefault) ?? workspaces[0];
      if (fallback == null) return;
      prevWorkspaceRef.current = fallback.id;
      setWorkspace(fallback.id, null);
      return;
    }

    // (2) The user switched workspace → show every repo in the new one (`null`). A stored subset
    // belongs to the workspace they left; carrying it across would hide repos they never hid.
    if (prevWorkspaceRef.current != null && prevWorkspaceRef.current !== live.id) {
      prevWorkspaceRef.current = live.id;
      // The picker below already wrote `null` when it switched; re-writing it would only churn a
      // render. Only write when there is actually a subset to clear.
      if (useFilters.getState().repoIds != null) setWorkspace(live.id, null);
      return;
    }
    prevWorkspaceRef.current = live.id;

    // (3) Same workspace → PRUNE ONLY. `null` means "every repo in this workspace" and is always
    // correct, so it is never touched.
    const stored = useFilters.getState().repoIds;
    if (stored == null) return;
    const member = new Set(live.repoIds);
    const pruned = stored.filter((id) => member.has(id));
    if (pruned.length === stored.length) return;
    // Every stored id left the workspace: fall back to the whole workspace rather than to `[]`,
    // which is the real narrowing "show nothing" and would strand the user on an empty board with
    // no hint that a repo moved.
    setRepoIds(pruned.length > 0 ? pruned : null);
  }, [workspaceId, workspaces, setWorkspace, setRepoIds]);
}

/** Default first (it is where new repos land), then the rest by name. */
function orderWorkspaces(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The active-Workspace picker — SINGLE-SELECT, because a workspace is the only scope this app has.
 *
 * There is no "All repos", no "All Workspaces" union and no "no workspace" bucket: every repo
 * belongs to exactly one workspace (a database fact), so those three rows described states that
 * can no longer exist. The rows are radios, not checkboxes; narrowing WITHIN the selected
 * workspace is the neighbouring Repos panel's job.
 *
 * Mounted once, in the FilterBar, on every view — it is the single scope control, so the Activity
 * rail carries none of its own.
 */
export function WorkspaceSelector(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const setWorkspace = useFilters((s) => s.setWorkspace);
  const { data: workspaces } = useWorkspaces();
  const [open, setOpen] = useState(false);
  // Repo/workspace management lives INSIDE this dropdown (no separate rail button) — an entry at
  // the bottom opens the full management modal.
  const [manageOpen, setManageOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Resolve the active workspace and keep repoIds honest (see the hook above).
  useWorkspaceSync();

  useClickOutside(rootRef, () => setOpen(false), open);

  const rows = useMemo(() => orderWorkspaces(workspaces ?? []), [workspaces]);
  const active = workspaceId == null ? undefined : rows.find((w) => w.id === workspaceId);

  // Switching workspace shows all of it — a subset the user picked in the workspace they are
  // leaving is not a narrowing of the one they are entering.
  const select = (id: number): void => {
    setWorkspace(id, null);
    setOpen(false);
  };

  // Never "All repos" / "N workspaces" — the label is simply the active workspace's name. While
  // the id is still unresolved (the workspaces query has not landed) the trigger reads a neutral
  // placeholder rather than guessing at a name.
  const activeLabel = active?.name ?? 'Workspace';

  const rowCls = (selected: boolean): string =>
    `flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs ${
      selected
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
        title="The active Workspace — the one scope every view is read through"
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
          aria-label="Workspace"
          className="absolute left-0 top-full z-[60] mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {rows.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-gray-500">Loading workspaces…</div>
          ) : (
            rows.map((w) => {
              const selected = w.id === workspaceId;
              return (
                <button
                  key={w.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => select(w.id)}
                  className={rowCls(selected)}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      aria-hidden
                      className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] leading-none ${
                        selected
                          ? 'border-sky-500 bg-sky-500 text-white'
                          : 'border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      {selected ? '•' : ''}
                    </span>
                    <span className="truncate">{w.name}</span>
                    {/* The Default is renameable, so its name alone doesn't identify it — but it
                        IS where new repos land and where a deleted workspace's repos come back
                        to, which is worth saying on the row that cannot be deleted. */}
                    {w.isDefault && (
                      <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        Default
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-gray-400">
                    {w.repoCount}
                  </span>
                </button>
              );
            })
          )}
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          {/* Repo/workspace management — add or remove repos, create workspaces, move repos
              between them. A repo belongs to exactly one workspace, so assigning it elsewhere
              MOVES it; there is no "unassign". */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setManageOpen(true);
            }}
            title="Add or remove repos, create Workspaces, and move repos between them"
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <span aria-hidden>⚙</span>
            <span className="truncate">Manage repos &amp; workspaces</span>
            {rows.length > 0 && (
              <span className="ml-auto shrink-0 tabular-nums text-[10px] text-gray-400">
                {rows.length}
              </span>
            )}
          </button>
        </div>
      )}
      {manageOpen && <WorkspaceManagerModal onClose={() => setManageOpen(false)} />}
    </div>
  );
}
