import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '@pierre-review/shared';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useMyTurnByWorkspace } from '../hooks/useMyTurnByWorkspace.js';
import { consumeRestoredWorkspaceScope, markUrlCorrection } from '../hooks/useUrlState.js';
import { useWorkspaces } from '../hooks/useWorkspaces.js';
import { useFilters } from '../store/filters.js';
import { WorkspaceManagerModal } from './Activity/WorkspaceManager.js';
import { CaretIcon, DotIcon, GearIcon, WorkspaceIcon } from './Icons.js';

/**
 * The My-Turn count badge, shared by the collapsed trigger and every menu row so the two can
 * never drift apart.
 *
 * OUTLINE, NOT FILL. A solid amber pill read as an alert blob next to the workspace name and
 * fought the rail's quiet grey-on-dark for attention — this control is a SCOPE PICKER that also
 * happens to carry a count, not a notification. A hairline ring with a transparent centre keeps
 * the number legible and lets the amber mean "there is work here" without shouting it.
 * `min-w` + `text-center` keep a 1-digit and a 3-digit badge the same optical shape so a column
 * of rows does not ripple; `tabular-nums` stops the digits themselves jittering.
 */
const MY_TURN_BADGE_CLASS =
  'shrink-0 rounded-full border border-amber-500/60 px-1 text-center text-[9px] font-medium leading-[15px] tabular-nums text-amber-600 dark:border-amber-400/50 dark:text-amber-400';

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
 *  2. The workspace CHANGED — and the change is a SWITCH, not a URL restore (below) ⇒ show all of
 *     the new one.
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
 *
 * ⚠ …and a Back is the SAME SHAPE OF EVENT as that deep link, arriving mid-session. See case (2)
 * in the body: a workspace id the URL restored ALONGSIDE its own `?repos=` is a restore, not a
 * switch, and takes the prune path too.
 */
export function useWorkspaceSync(): void {
  const workspaceId = useFilters((s) => s.workspaceId);
  const setWorkspace = useFilters((s) => s.setWorkspace);
  const setRepoIds = useFilters((s) => s.setRepoIds);
  const { data: workspaces } = useWorkspaces();

  // null = "no workspace observed yet" — see the note above. It is NOT a workspace id.
  const prevWorkspaceRef = useRef<number | null>(null);

  useEffect(() => {
    syncWorkspaceScope({ workspaces, workspaceId, prevWorkspaceRef, setWorkspace, setRepoIds });
  }, [workspaceId, workspaces, setWorkspace, setRepoIds]);
}

/**
 * The effect body above, as a plain function over an explicit ref — the three branches, unchanged.
 *
 * It is a function rather than an inline effect for ONE reason: it is testable that way. The whole
 * contract lives in which of the three branches a given (ref, workspace, stored repoIds) lands in,
 * and that decision has silently regressed before; the frontend's unit tests are plain `.ts`
 * modules with no React renderer, so an inline body could only ever be re-implemented by a test,
 * never exercised by one. See test/urlHistory.test.ts.
 */
export function syncWorkspaceScope(args: {
  workspaces: Workspace[] | undefined;
  workspaceId: number | null;
  prevWorkspaceRef: { current: number | null };
  setWorkspace: (workspaceId: number, repoIds: number[] | null) => void;
  setRepoIds: (ids: number[] | null) => void;
}): void {
  const { workspaces, workspaceId, prevWorkspaceRef, setWorkspace, setRepoIds } = args;
  // The server ENSURES a Default before answering, so a loaded list is never empty; an empty one
  // means something is wrong upstream and writing a scope from it would be a guess.
  if (workspaces == null || workspaces.length === 0) return;

  const live = workspaceId == null ? undefined : workspaces.find((w) => w.id === workspaceId);

  // (1) Unresolved, or an id that names no live workspace → the account's Default, showing all
  // of it. This is the only path that may replace the array without the user having asked.
  //
  // ⚠ AND IT IS THE ONLY PATH THAT RESOLVES THE WORKSPACE AT ALL, so it owns the whole
  // "the first resolution is not a navigation" rule — `writeToUrl` no longer tries to infer it
  // from the URL's shape. `workspace` is a NAV key, so an unmarked write here PUSHES a new entry
  // one tick after a load or a pop, for a change the user did not make. Both shapes bite:
  //
  //   • a cold load from a stale bookmark / a cross-account link naming a dead id (the mount's own
  //     correction marker has already been consumed by the hydrate's write), and
  //   • a Back onto any entry naming a workspace that has since been deleted — the popped entry
  //     still names the dead id, so the push lands on top of the entry the reader just reached,
  //     the next Back pops into this branch again, and Back is a PERMANENT no-op: the reader can
  //     neither reach an earlier view nor leave the app.
  //
  // A corrective write that reconciles state the user did not ask for is always a REPLACE.
  if (live == null) {
    const fallback = workspaces.find((w) => w.isDefault) ?? workspaces[0];
    if (fallback == null) return;
    prevWorkspaceRef.current = fallback.id;
    markUrlCorrection();
    setWorkspace(fallback.id, null);
    return;
  }

  const changed = prevWorkspaceRef.current != null && prevWorkspaceRef.current !== live.id;
  prevWorkspaceRef.current = live.id;

  // (2) The workspace CHANGED — but A CHANGE IS NOT ALWAYS A SWITCH, and the difference is the
  // whole of this branch. Two things move this id:
  //
  //   • The user picked a different workspace ⇒ SWITCH. Show every repo in the new one (`null`):
  //     a stored subset belongs to the workspace they left, and carrying it across would hide
  //     repos they never hid.
  //   • Back/Forward applied a URL that named a workspace AND carried its own `?repos=` ⇒ RESTORE.
  //     The narrowing IS the view the reader is returning to. Re-deriving here would widen the
  //     board a tick after the pop restored it — `repoIds` was the one key in the whole history
  //     bundle that did not survive a Back across a workspace switch, and this is why.
  //
  // ⚠ `consumeRestoredWorkspaceScope` is that signal, and it is read SYNCHRONOUSLY here — it is
  // armed inside `applyUrlToStores`'s own call, so by the time this effect runs the flag is the
  // only surviving evidence of how the id arrived. It is keyed on the id and one-shot, so it can
  // never suppress a later genuine switch to a different workspace (or a second switch back).
  if (changed && !consumeRestoredWorkspaceScope(live.id)) {
    // The picker below already wrote `null` when it switched; re-writing it would only churn a
    // render. Only write when there is actually a subset to clear.
    if (useFilters.getState().repoIds != null) setWorkspace(live.id, null);
    return;
  }

  // (3) Same workspace — or a restored one — → PRUNE ONLY. `null` means "every repo in this
  // workspace" and is always correct, so it is never touched. A restored narrowing goes through
  // the same prune, so a `?repos=` naming repos that have since left the workspace is corrected
  // rather than trusted.
  const stored = useFilters.getState().repoIds;
  if (stored == null) return;
  // Sticky-[] repair: a persisted EMPTY narrowing can never recover on its own — the prune
  // below early-returns on 0 === 0, so the empty→null fallback further down is unreachable
  // and every query keeps sending `repoIds=` (an empty board) forever. An empty array that
  // SURVIVED into a new session is a trap, not a choice; fall back to the whole workspace.
  // Still the prune path only — a non-empty user subset is never touched.
  if (stored.length === 0) {
    setRepoIds(null);
    return;
  }
  const member = new Set(live.repoIds);
  const pruned = stored.filter((id) => member.has(id));
  if (pruned.length === stored.length) return;
  // Every stored id left the workspace: fall back to the whole workspace rather than to `[]`,
  // which is the real narrowing "show nothing" and would strand the user on an empty board with
  // no hint that a repo moved.
  setRepoIds(pruned.length > 0 ? pruned : null);
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

  // Per-workspace "My Turn" counts (see the hook). The rows are the ONE place in the app that
  // lists every workspace at once, which makes them the right place to say where your work is —
  // the amber badge is "N things are on your plate in THAT workspace". Same fold, same number and
  // same cap phrasing as the Welcome-back banner.
  //
  // ⚠ IT COUNTS THE PERSONAL SUBSET (`myTurnPersonal`), like every other surface that NOTIFIES —
  // a badge that lit up because a stranger opened a PR in a repo you only read is a summons to
  // nothing. The **Pending** board and the daily-brief strip keep the broad count: that
  // work is real, it is just not yours. (See useMyTurnByWorkspace.)
  //
  // ⚠ INFORMATIONAL ONLY, on purpose. A row's click means "switch scope" and nothing more: this
  // control is mounted on EVERY board, so making a badged row additionally hijack the rail would
  // teleport someone who only wanted to re-scope the Timeline. Reaching the list from a count is
  // the banner's job (`openMyTurnInWorkspace`).
  //
  // ⚠ ABSENCE IS NOT ZERO. The cross-workspace roll-up is capped server-side, so a workspace can
  // have NO number rather than a zero one — those rows render a dim "—" and the footer names how
  // many, because a badge that exists to say "you have unseen work" must not omit a workspace
  // silently. Nothing renders at all until the brief lands (`workspaceId === null` ⇒ idle).
  const { byWorkspace, elsewhereCount, elsewhereCapped, uncounted } = useMyTurnByWorkspace();

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
        <WorkspaceIcon className="shrink-0 text-sky-500" />
        <span className="truncate">{activeLabel}</span>
        {/* The collapsed trigger carries the OTHER workspaces' total only — the active one's
            count is already visible on the board behind this control, whereas this figure is
            work the reader cannot see from where they are standing. Without it the yellow only
            exists inside a menu nobody has a reason to open. */}
        {elsewhereCount > 0 && (
          <span
            title={
              elsewhereCount === 1 && !elsewhereCapped
                ? '1 item needs you in another Workspace — open this menu to see where'
                : `${elsewhereCount}${
                    elsewhereCapped ? ' or more' : ''
                  } items need you in other Workspaces — open this menu to see where`
            }
            className={`${MY_TURN_BADGE_CLASS} min-w-[1.1rem]`}
          >
            {elsewhereCount}
            {elsewhereCapped ? '+' : ''}
          </span>
        )}
        <CaretIcon dir="down" className="shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspace"
          className="absolute left-0 top-full z-[60] mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {rows.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">Loading workspaces…</div>
          ) : (
            rows.map((w) => {
              const selected = w.id === workspaceId;
              const myTurn = byWorkspace.get(w.id) ?? null;
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
                      {selected && <DotIcon size={5} />}
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
                  <span className="flex shrink-0 items-center gap-1.5">
                    {myTurn != null && myTurn.count > 0 && (
                      // The figure is the CARD count — the list that opens — never the uncapped
                      // total; the cap gets the ONE shared "+" phrasing and the exact pair in the
                      // title. A `fresh: false` line came from the roll-up's ≤5-min server cache,
                      // which is fine precisely because it describes a workspace you are NOT in:
                      // switching there re-derives it before any list renders. The ACTIVE row is
                      // always the fresh one, so this badge can never disagree with the board on
                      // screen.
                      <span
                        // ⚠ THE BADGE STILL SUMS BOTH HALVES — the notification population is
                        // unchanged, and a badge is one glyph wide. The direct/maintained SPLIT
                        // rides the tooltip only, where it costs no layout: "3 tied to you, 2 in
                        // repos you maintain" is the difference between a summons and an FYI, and
                        // a reader hovering a badge is asking exactly that. The cap sentence still
                        // wins the title when there is one — it is the only place the exact
                        // shown/total pair is written down.
                        title={
                          myTurn.cap?.title ??
                          (myTurn.split != null
                            ? `${myTurn.split.direct} tied to you, ${myTurn.split.maintained} in repos you maintain — in ${w.name}`
                            : myTurn.count === 1
                              ? `1 item needs you in ${w.name}`
                              : `${myTurn.count} items need you in ${w.name}`)
                        }
                        className={`${MY_TURN_BADGE_CLASS} min-w-[1.35rem]`}
                      >
                        {myTurn.count}
                        {myTurn.cap != null && (
                          <>
                            <span aria-hidden>+</span>
                            <span className="sr-only"> of {myTurn.cap.total}</span>
                          </>
                        )}
                      </span>
                    )}
                    {myTurn == null && uncounted.length > 0 && (
                      // Not counted, NOT zero — see the note above the hook call.
                      <span
                        title="Not counted here — the cross-workspace roll-up covers only the first few Workspaces. Switch to it to see its own count."
                        className="text-[10px] decorative-mark text-gray-300 dark:text-gray-600"
                      >
                        —
                      </span>
                    )}
                    <span
                      title="Repos in this Workspace"
                      className="tabular-nums text-[10px] text-gray-400"
                    >
                      {w.repoCount}
                    </span>
                  </span>
                </button>
              );
            })
          )}
          {uncounted.length > 0 && (
            <div className="px-2 pb-0.5 pt-1 text-[10px] leading-tight text-gray-400">
              {uncounted.length} Workspace{uncounted.length === 1 ? '' : 's'} beyond the
              cross-workspace roll-up{uncounted.length === 1 ? ' is' : ' are'} not counted here.
            </div>
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
            <GearIcon className="shrink-0" />
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
