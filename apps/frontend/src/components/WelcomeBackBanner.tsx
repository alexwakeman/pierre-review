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
import { useShell } from '../store/shell.js';
import { CloseIcon } from './Icons.js';

// "NEEDS YOU" — the sidebar group that replaced the "Welcome back" strip (the redesign's shell).
//
// ── WHERE THE STRIP WENT ─────────────────────────────────────────────────────────────────────
// The strip was a 28px amber band above every screen. Its information is unchanged and now sits
// in the sidebar, under the destinations: a "Needs you · N" heading (the same one figure, "N+"
// when capped), one quiet row per workspace with work waiting (filled dot = the active one), the
// "+N more" popover with the rest and the "Not counted here" disclosure, and the × that hides it
// for the session. The ACTIVE workspace's own figure also rides the Pending item itself. A click on
// a row is the same `openMyTurnInWorkspace` gesture. It is still one population and one number.
//
// It shows only when it says something the Pending item does not: work in ANOTHER workspace, or a
// workspace the roll-up could not count. A lone active-workspace line is the Pending badge again.
// (⌘K also lists "Show what needs you in <workspace>" for every line.)
//
// ── WHY THE STRIP WAS ONE LINE (history) ─────────────────────────────────────────────────────
// It sat ABOVE the board in App's flex column, so every row it grew stole height from the thing
// the reader came for; the workspaces were inline chips capped at four with a "+N more" popover.
// The sidebar keeps that cap for the same reason: a long workspace list must not push the
// Library and Insights groups off a short screen.
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
/** How many workspace rows show before the rest collapse into "+N more". */
const MAX_INLINE_WORKSPACES = 4;

export function NeedsYou({ onNavigate }: { onNavigate?: () => void }): JSX.Element | null {
  const { data: me } = useMe();
  const openMyTurnInWorkspace = useFilters((s) => s.openMyTurnInWorkspace);
  const { lines, total, anyCapped, uncounted } = useMyTurnByWorkspace();
  const dismissed = useShell((s) => s.needsYouDismissed);
  const dismiss = useShell((s) => s.dismissNeedsYou);

  if (dismissed || !me?.user) return null;
  // Empty while the workspace is unresolved (the hook holds itself idle) — nothing to say.
  if (lines.length === 0) return null;
  // Only the active workspace has work and every workspace was counted: the Pending item already
  // says it, with the same number.
  if (uncounted.length === 0 && lines.every((l) => l.isActive)) return null;

  // A capped figure is a floor, so it is never grammatically singular.
  const singular = total === 1 && !anyCapped;

  const open = (workspaceId: number): void => {
    openMyTurnInWorkspace(workspaceId);
    onNavigate?.();
  };

  const shown = lines.slice(0, MAX_INLINE_WORKSPACES);
  const overflow = lines.slice(MAX_INLINE_WORKSPACES);
  const restCount = overflow.length + uncounted.length;

  return (
    <div className="mt-3" data-testid="needs-you">
      <div className="flex h-7 items-center gap-1 pl-2 pr-1">
        <span className="min-w-0 flex-1 truncate text-meta text-ui-faint">
          Needs you · {total}
          {anyCapped ? '+' : ''}
          <span className="sr-only">{singular ? ' item' : ' items'}</span>
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide Needs you for this session"
          title="Hide for this session"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-ui text-ui-faint hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 touch:w-10"
        >
          <CloseIcon size={11} />
        </button>
      </div>
      <ul className="m-0 list-none p-0">
        {shown.map((l) => (
          <li key={l.workspaceId}>
            <button
              type="button"
              onClick={() => open(l.workspaceId)}
              // The cap sentence rides the WHOLE row — a disclosure nobody can hover is a silent
              // cap with extra steps.
              title={
                l.cap?.title ??
                (l.isActive ? `Show these in ${l.name}` : `Switch to ${l.name} and show these`)
              }
              className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-ui px-2 text-left text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-11"
            >
              <span className="flex w-4 shrink-0 justify-center">
                <span
                  aria-hidden
                  // Filled = the workspace you are in; hollow = one you cannot see from here.
                  className={`inline-block h-1.5 w-1.5 rounded-full border ${
                    l.isActive ? 'border-ui-mute bg-ui-mute' : 'border-ui-faint'
                  }`}
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              <span className="shrink-0 text-meta tabular-nums text-ui-ink">
                {l.count}
                {l.cap != null && (
                  <>
                    <span aria-hidden>+</span>
                    <span className="sr-only"> of {l.cap.total}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {restCount > 0 && (
        <MoreWorkspaces restCount={restCount} overflow={overflow} uncounted={uncounted} onOpen={open} />
      )}
    </div>
  );
}

/**
 * "+N more" as a control: a click opens the remaining workspaces in a popover (dismissed by a click
 * outside or Escape), each a button like the rows above.
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
    placement: 'right-start',
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
        className="flex h-7 w-full items-center rounded-ui pl-8 pr-2 text-left text-meta text-ui-faint hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10"
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
            className="z-[60] max-h-[60vh] w-64 overflow-y-auto overscroll-contain rounded-ui bg-ui-raise p-1 text-body text-ui-ink shadow-xl shadow-black/30"
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
                      className="flex h-8 w-full items-center gap-2 rounded-ui px-2 text-left hover:bg-ui-hover touch:h-11"
                    >
                      <span className="shrink-0 font-medium tabular-nums">
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
              <p className={`px-2 py-1.5 text-meta text-ui-mute ${overflow.length > 0 ? 'mt-1' : ''}`}>
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
