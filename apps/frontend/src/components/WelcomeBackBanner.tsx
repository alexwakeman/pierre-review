import { useId, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { useMe } from '../hooks/useTriage.js';
import { useMyTurnByWorkspace, type WorkspaceMyTurnLine } from '../hooks/useMyTurnByWorkspace.js';
import { useFilters } from '../store/filters.js';
import { CloseIcon } from './Icons.js';

// The "Welcome back" banner — ALWAYS EXACTLY ONE LINE TALL, whatever the workspace count.
//
// ── WHY ONE LINE IS A RULE, NOT A PREFERENCE ─────────────────────────────────────────────────
// This sits ABOVE the board in App's flex column, so every row it grows steals height from the
// thing the reader actually came for. It used to render a <ul> with a row per workspace, which
// on an eight-workspace account pushed the timeline most of the way down the viewport. So the
// workspaces are now inline CHIPS on the headline row, capped at MAX_INLINE_WORKSPACES with a
// "+N more" button that opens the rest in a popover. The cap is what makes "one line" a
// GUARANTEE rather than a hope: no measurement, no wrapping, no resize observer. `flex-nowrap`
// + `overflow-hidden` + a per-chip `truncate` are the belt to that braces — a pathological
// workspace name shortens itself instead of wrapping the row.
//
// ── WHAT IT COUNTS, AND WHY THAT CHANGED ─────────────────────────────────────────────────────
// It used to render `MeResponse.newFeedItems`: an ACCOUNT-WIDE tally of feed events since one
// account-wide `accounts.feedLastSeenAt` marker. Both halves of that were wrong together. The
// count spanned every workspace while the banner sat inside one, so it announced work you could
// not see from where you were standing and gave you no way to reach it; and the gesture that
// CLEARED it — viewing the Activity Feed — was workspace-scoped, so reading workspace A zeroed a
// number that was mostly workspace B's. On top of that the figure corresponded to no clickable
// list: "12 new items" opened a feed pill, not twelve things.
//
// It now counts the STANDING `my_turn` CARDS per workspace — the things actually on your plate —
// through `useMyTurnByWorkspace`, which is the same fold the **Pending** board paints.
// Banner line, dropdown badge and destination board are one population and one number.
//
// ── AND THE POPULATION IS THE PERSONAL ONE ───────────────────────────────────────────────────
// This banner NOTIFIES, so it counts `myTurnPersonal`: reviews requested of you, your PRs,
// threads awaiting your reply, and new PRs only in repos you MAINTAIN or were @-mentioned on.
// Adding a repo you have never touched used to put every open PR in it here (425 of 459 items on
// the reporter's account). The **Pending** board still holds all of them — they do need a
// review — which is why the click below goes through `openMyTurnInWorkspace`, the one gesture
// that also seats the board's matching 'mine' lens. A line that says 4 must not open a list
// of 50. There is consequently NO per-workspace "seen" state
// and no schema change: a line disappears when you deal with the work, not when you glance at it.
//
// ⚠ AND IT IS THE SAME NUMBER THE WORKSPACE PICKER NOW SHOWS. That control's collapsed badge used
// to carry the sum over the OTHER workspaces while sitting beside the ACTIVE one's name, so the
// two surfaces disagreed by construction about what a number against a workspace meant. It carries
// the active workspace's own figure now (`activeWorkspaceBadge`), which is this banner's chip for
// that same workspace: one fold, one population, three places.
//
// ⚠ THE HEADLINE IS ONE FIGURE — "Welcome back · 5 need you" — the sum the chips, the dropdown
// badges and the OS notification count. It used to split it ("2 yours · 3 in your repos"); that
// split was dropped (2026-10-07) as more words than the line needed.
//
// ── THE CLICK ────────────────────────────────────────────────────────────────────────────────
// Each line goes through `openMyTurnInWorkspace`, the ONE store action that switches scope and
// isolates the board to `my_turn` in the correct order (see its declaration — two independent
// ordering traps live in there). So the line that says "Platform · 4" lands you in Platform,
// looking at those four cards.
//
// Dismissal is component-local and therefore lasts the session (this is mounted once, in App).
// That is the only mute there is now: the population is standing work, so nothing "marks it seen".
// It shows under EVERY tab, Activity included (Pending, Feed, Bots, Reports): it used to hide on
// Activity on the theory that the Pending board is the list, but the chips name OTHER workspaces
// that board cannot show, so hiding it there removed the one cross-workspace summary from the
// landing view. The dismiss button sits at the LEFT edge, before the headline. My Turn is CORE /
// free, so this shows on every tier.
/**
 * How many workspace chips ride the headline before the rest collapse into "+N more".
 * Four fits comfortably beside the headline at a narrow window; beyond that the row would
 * start truncating names into uselessness, and a summary is more honest than three letters.
 */
const MAX_INLINE_WORKSPACES = 4;

export function WelcomeBackBanner(): JSX.Element | null {
  const { data: me } = useMe();
  const openMyTurnInWorkspace = useFilters((s) => s.openMyTurnInWorkspace);
  const { lines, total, anyCapped, uncounted } = useMyTurnByWorkspace();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !me?.user) return null;
  // Empty while the workspace is unresolved (the hook holds itself idle) — nothing to say.
  if (lines.length === 0) return null;

  // A capped figure is a floor, so it is never grammatically singular.
  const singular = total === 1 && !anyCapped;

  const open = (workspaceId: number): void => {
    openMyTurnInWorkspace(workspaceId);
    setDismissed(true);
  };

  const shown = lines.slice(0, MAX_INLINE_WORKSPACES);
  const overflow = lines.slice(MAX_INLINE_WORKSPACES);
  // The two ways a workspace can be absent from the chips collapse into ONE trailing summary,
  // because to the reader they are the same sentence: "there is more, and it is not here".
  // They keep separate wording inside the tooltip — one is a display cap, the other is the
  // roll-up's server-side cap, and only the latter means the number is unknown.
  const restCount = overflow.length + uncounted.length;

  return (
    // ONE ROW. `flex-nowrap` + `overflow-hidden` are load-bearing: they are what stops a long
    // workspace name from wrapping this into a two-line banner. `shrink-0` keeps App's flex
    // column from squeezing it instead.
    <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-amber-200 bg-amber-50 px-4 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss welcome back banner"
        title="Dismiss for this session"
        className="flex shrink-0 items-center rounded -ml-1 px-1 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
      >
        <CloseIcon />
      </button>
      <span className="shrink-0 font-medium">Welcome back</span>
      <span className="shrink-0 text-amber-700/80 dark:text-amber-300/80">
        {/* The headline sums CAPPED card counts, so it says "N+" the moment any line is
            capped — the summed figure is a floor, and saying so is cheaper than a wrong
            total. The per-chip tooltips carry the exact pairs. ONE figure: the "yours · in your
            repos" split it used to print is gone (the server's `totalSplit` is simply unread). */}
        · {total}
        {anyCapped ? '+' : ''} need{singular ? 's' : ''} you
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {shown.map((l) => (
          <button
            key={l.workspaceId}
            type="button"
            onClick={() => open(l.workspaceId)}
            // The cap sentence rides the WHOLE chip, not the 6px superscript — a disclosure
            // nobody can hover is a silent cap with extra steps.
            title={
              l.cap?.title ??
              (l.isActive ? `Show these in ${l.name}` : `Switch to ${l.name} and show these`)
            }
            className="group flex min-w-0 shrink items-center gap-1 rounded px-1 py-0.5 hover:bg-amber-100/70 dark:hover:bg-amber-900/40"
          >
            <span
              aria-hidden
              // The ACTIVE workspace is the one the user can already see; the hollow dots are
              // the ones they cannot reach from here, which is the whole reason this banner is
              // per-workspace. It replaces the old "this Workspace" pill, which cost a chip's
              // width to say what the fill already says.
              className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full border ${
                l.isActive
                  ? 'border-amber-500 bg-amber-500'
                  : 'border-amber-400 dark:border-amber-600'
              }`}
            />
            <span className="shrink-0 font-semibold tabular-nums">
              {l.count}
              {l.cap != null && (
                <>
                  <sup className="ml-px text-[11px] font-normal opacity-70" aria-hidden>
                    +
                  </sup>
                  <span className="sr-only"> of {l.cap.total}</span>
                </>
              )}
            </span>
            <span
              className={`min-w-0 truncate group-hover:underline ${
                l.isActive ? 'font-medium' : 'text-amber-700/90 dark:text-amber-300/90'
              }`}
            >
              {l.name}
            </span>
          </button>
        ))}
        {restCount > 0 && (
          // A banner whose purpose is "work you cannot see from here" does not get to omit
          // workspaces quietly — even when the reason is only that the row ran out of room. The
          // "+N more" opens the rest in a popover, so the banner itself stays one line.
          <MoreWorkspaces
            restCount={restCount}
            overflow={overflow}
            uncounted={uncounted}
            onOpen={open}
          />
        )}
      </span>
    </div>
  );
}

/**
 * "+N more" as a control: a click opens the remaining workspaces in a popover (dismissed by a click
 * outside or Escape), each a button like the inline chips. The banner row itself never grows.
 */
function MoreWorkspaces({
  restCount,
  overflow,
  uncounted,
  onOpen,
}: {
  restCount: number;
  overflow: readonly WorkspaceMyTurnLine[];
  uncounted: readonly { name: string }[];
  onOpen: (workspaceId: number) => void;
}): JSX.Element {
  const [isOpen, setOpen] = useState(false);
  const panelId = useId();
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'dialog' }),
  ]);
  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        {...getReferenceProps()}
        className="shrink-0 rounded px-1 text-[11px] text-amber-700/80 hover:bg-amber-100/70 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300/80 dark:hover:bg-amber-900/40"
      >
        +{restCount} more
      </button>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            id={panelId}
            aria-label="More workspaces needing you"
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[60] max-h-[60vh] w-64 overflow-y-auto rounded-md border border-amber-200 bg-white p-1.5 text-xs text-gray-800 shadow-lg dark:border-amber-900/50 dark:bg-gray-900 dark:text-gray-100"
          >
            {overflow.length > 0 && (
              <ul>
                {overflow.map((l) => (
                  <li key={l.workspaceId}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onOpen(l.workspaceId);
                      }}
                      title={l.cap?.title}
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-amber-50 dark:hover:bg-amber-900/30"
                    >
                      <span className="shrink-0 font-semibold tabular-nums">
                        {l.count}
                        {l.cap != null ? '+' : ''}
                      </span>
                      <span className="min-w-0 truncate">{l.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {uncounted.length > 0 && (
              <p className={`px-1.5 py-1 text-gray-600 dark:text-gray-300 ${overflow.length > 0 ? 'mt-1 border-t border-gray-100 pt-1.5 dark:border-gray-800' : ''}`}>
                Not counted here: {uncounted.map((w) => w.name).join(', ')}. Switch to one to see its own
                count.
              </p>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
