import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '@pierre-review/shared';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { useMyTurnByWorkspace } from '../hooks/useMyTurnByWorkspace.js';
import { consumeRestoredWorkspaceScope, markUrlCorrection } from '../hooks/useUrlState.js';
import { useRepos } from '../hooks/useTimeline.js';
import { useWorkspaces } from '../hooks/useWorkspaces.js';
import { useFilters } from '../store/filters.js';
import { CaretIcon, DotIcon, GearIcon, WorkspaceIcon } from './Icons.js';

/**
 * Whether this page load has already opened the manager for a zero-repo account. MODULE state, not
 * component state: the selector remounts (StrictMode, a view switch), and a reader who closed the
 * modal must not have it pop back on the next mount. A reload is a new load, so an account that is
 * still empty sees it again — which is the point: signing in with nothing to show opens here.
 */
let firstRunManagerShown = false;

// Each menu row carries ITS OWN workspace's personal My Turn count (the same figure the sidebar's
// Pending item shows for the active one), plain ink and tabular — a scope picker that happens to
// carry a count, not a notification, so it wears no alert colour (docs/redesign/DESIGN.md § 3).

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

/**
 * The parts of the old selector that must run on EVERY screen, whether or not the picker is visible
 * (the sidebar is `display: none` in a closed phone drawer): keep the workspace resolved, open the
 * manager once for a zero-repo account, and mount the manager itself. Called once, from App.
 *
 * The manager's open state is the store's `managerOpen` (it was component state here), so the
 * picker, ⌘K ("Manage repos & workspaces") and first-run all open the same modal.
 */
export function useWorkspaceShell(): { managerOpen: boolean; closeManager: () => void } {
  useWorkspaceSync();
  const { data: repos } = useRepos();
  const { data: workspaces } = useWorkspaces();
  const managerOpen = useFilters((s) => s.managerOpen);
  const setManagerOpen = useFilters((s) => s.setManagerOpen);
  // A FIRST-TIME account (no repos at all) opens straight into the manager, once per page load, so
  // the first thing on screen is the way to add a repo. `repos` is never persisted to IndexedDB, so
  // an empty list here is the server's answer for this load, not a stale one; `undefined` is
  // "still loading" and must not open anything. It waits for the workspaces too, so the add box
  // opens already aimed at a workspace. Never closed for the reader: once a repo is added the
  // modal stays up showing its sync.
  useEffect(() => {
    if (firstRunManagerShown || repos == null || workspaces == null) return;
    if (repos.length > 0) return;
    firstRunManagerShown = true;
    setManagerOpen(true);
  }, [repos, workspaces, setManagerOpen]);
  return { managerOpen, closeManager: () => setManagerOpen(false) };
}

/** Open "Manage repos & workspaces" from anywhere (the picker, ⌘K, an empty-state link). */
export function openWorkspaceManager(): void {
  useFilters.getState().setManagerOpen(true);
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
 * Mounted once, at the top of the sidebar (components/shell/Sidebar.tsx) — it is the single scope control, so the Activity
 * rail carries none of its own.
 */
export function WorkspaceSelector(): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  const switchWorkspaceToOpenPrs = useFilters((s) => s.switchWorkspaceToOpenPrs);
  const { data: workspaces } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Escape closes the menu and hands focus back — in the CAPTURE phase with stopPropagation, so
  // the app's global Esc (useKeyboard → the Timeline) never also fires.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useClickOutside(rootRef, () => setOpen(false), open);

  const rows = useMemo(() => orderWorkspaces(workspaces ?? []), [workspaces]);
  const active = workspaceId == null ? undefined : rows.find((w) => w.id === workspaceId);

  // Per-workspace "My Turn" counts (see the hook). The rows are the ONE place in the app that
  // lists every workspace at once, which makes them the right place to say where your work is —
  // the badge is "N things are on your plate in THAT workspace". Same fold, same number and
  // same cap phrasing as the Welcome-back banner.
  //
  // ⚠ IT COUNTS THE PERSONAL SUBSET (`myTurnPersonal`), like every other surface that NOTIFIES —
  // a badge that lit up because a stranger opened a PR in a repo you only read is a summons to
  // nothing. The **Pending** board keeps the broad count: that
  // work is real, it is just not yours. (See useMyTurnByWorkspace.)
  //
  // ⚠ The BADGE is informational; the ROW is a navigation. Picking a workspace (the current one
  // included) takes you to Activity → Open PRs (`switchWorkspaceToOpenPrs`),
  // clears the Timeline's selected PR and leaves pinned tabs alone. Someone who only wanted the
  // Timeline re-scoped is one Back away. Only this picker navigates: `setWorkspace` itself stays
  // a pure scope write for deep links, Back/Forward and the corrections below.
  //
  // ⚠ ABSENCE IS NOT ZERO. The cross-workspace roll-up is capped server-side, so a workspace can
  // have NO number rather than a zero one — those rows render a dim "—" and the footer names how
  // many, because a badge that exists to say "you have unseen work" must not omit a workspace
  // silently. Nothing renders at all until the brief lands (`workspaceId === null` ⇒ idle).
  const { byWorkspace, elsewhereCount, elsewhereCapped, uncounted } = useMyTurnByWorkspace();
  // (The collapsed trigger's own badge — this workspace's personal My Turn count — moved to the
  // sidebar's Pending item, which is where that list opens: components/shell/Sidebar.tsx. The
  // menu rows below still carry every workspace's figure.)

  // Switching workspace shows all of it — a subset the user picked in the workspace they are
  // leaving is not a narrowing of the one they are entering — and lands on Open PRs (see above).
  const select = (id: number): void => {
    switchWorkspaceToOpenPrs(id);
    setOpen(false);
  };

  // Never "All repos" / "N workspaces" — the label is simply the active workspace's name. While
  // the id is still unresolved (the workspaces query has not landed) the trigger reads a neutral
  // placeholder rather than guessing at a name.
  const activeLabel = active?.name ?? 'Workspace';

  const rowCls = (selected: boolean): string =>
    `flex h-8 w-full items-center justify-between gap-2 rounded-ui px-2 text-left text-body touch:h-11 ${
      selected ? 'bg-ui-sel font-medium text-ui-ink' : 'text-ui-ink hover:bg-ui-hover'
    }`;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        // ⚠ THE "ELSEWHERE" WORK MOVED INTO THIS TITLE, and it moved because it can no longer be
        // a digit here: two workspaces' counts cannot share one badge (see the badge below). It is
        // not lost — the menu rows carry each workspace's own number, and the Welcome-back banner
        // lists them as chips on every screen outside the Activity console — but a reader standing
        // on a quiet workspace still deserves the pointer, and a sentence can name the population
        // a number cannot.
        title={[
          'The active Workspace — the one scope every view is read through',
          elsewhereCount > 0
            ? `${elsewhereCount}${elsewhereCapped ? ' or more' : ''} item${
                elsewhereCount === 1 && !elsewhereCapped ? '' : 's'
              } need you in other Workspaces — open this menu to see where`
            : null,
        ]
          .filter((s): s is string => s != null)
          .join('. ')}
        aria-label={`Workspace: ${activeLabel}`}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-ui px-2 text-left text-title text-ui-ink outline-none hover:bg-ui-hover focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-11"
      >
        <WorkspaceIcon size={15} className="shrink-0 text-ui-mute" />
        <span className="min-w-0 flex-1 truncate">{activeLabel}</span>
        {elsewhereCount > 0 && (
          // Work waiting in OTHER workspaces: a quiet dot (the sentence is in the title, and the
          // menu names each workspace's figure).
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ui-accent" />
        )}
        <CaretIcon dir="down" className="shrink-0 text-ui-faint" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspace"
          className="absolute left-0 top-full z-[60] mt-1 max-h-[min(24rem,70vh)] w-[min(18rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-ui bg-ui-raise p-1 shadow-xl shadow-black/30 motion-safe:animate-ui-pop"
        >
          {rows.length === 0 ? (
            <div className="px-2 py-1.5 text-body text-ui-mute">Loading workspaces…</div>
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
                      className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-meta leading-none ${
                        selected
                          ? 'border-ui-accent-fill bg-ui-accent-fill text-ui-on-accent'
                          : 'border-ui-line'
                      }`}
                    >
                      {selected && <DotIcon size={5} />}
                    </span>
                    <span className="truncate">{w.name}</span>
                    {/* The Default is renameable, so its name alone doesn't identify it — but it
                        IS where new repos land and where a deleted workspace's repos come back
                        to, which is worth saying on the row that cannot be deleted. */}
                    {w.isDefault && (
                      <span className="shrink-0 text-meta text-ui-faint">Default</span>
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
                        className="shrink-0 text-meta font-medium tabular-nums text-ui-ink"
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
                        className="text-meta text-ui-faint"
                      >
                        —
                      </span>
                    )}
                    {/* ⚠ IT CARRIES ITS UNIT, and that is not decoration. This grey figure sits
                        six pixels from the my-turn badge, and on a real account both read
                        `8`: two populations, same digit, distinguished only by a colour a reader
                        has no key for and a title they have to hover to find. Colour alone is not
                        a label — the word is. */}
                    <span className="tabular-nums text-meta text-ui-faint">
                      {w.repoCount} repo{w.repoCount === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              );
            })
          )}
          {uncounted.length > 0 && (
            <div className="px-2 pb-0.5 pt-1 text-meta text-ui-faint">
              {uncounted.length} Workspace{uncounted.length === 1 ? '' : 's'} beyond the
              cross-workspace roll-up{uncounted.length === 1 ? ' is' : ' are'} not counted here.
            </div>
          )}
          <div role="separator" className="my-1 h-px bg-ui-line" />
          {/* Repo/workspace management — add or remove repos, create workspaces, move repos
              between them. A repo belongs to exactly one workspace, so assigning it elsewhere
              MOVES it; there is no "unassign". */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openWorkspaceManager();
            }}
            title="Add or remove repos, create Workspaces, and move repos between them"
            className="flex h-8 w-full items-center gap-2 rounded-ui px-2 text-left text-body text-ui-ink hover:bg-ui-hover touch:h-11"
          >
            <GearIcon className="shrink-0 text-ui-mute" />
            <span className="truncate">Manage repos &amp; workspaces</span>
            {rows.length > 0 && (
              <span className="ml-auto shrink-0 tabular-nums text-meta text-ui-faint">
                {rows.length}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
