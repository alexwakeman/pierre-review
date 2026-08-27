import { useState } from 'react';
import { useMe } from '../hooks/useTriage.js';
import { useMyTurnByWorkspace } from '../hooks/useMyTurnByWorkspace.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { useFilters } from '../store/filters.js';
import { CloseIcon } from './Icons.js';

// The "Welcome back" banner — ALWAYS EXACTLY ONE LINE TALL, whatever the workspace count.
//
// ── WHY ONE LINE IS A RULE, NOT A PREFERENCE ─────────────────────────────────────────────────
// This sits ABOVE the board in App's flex column, so every row it grows steals height from the
// thing the reader actually came for. It used to render a <ul> with a row per workspace, which
// on an eight-workspace account pushed the timeline most of the way down the viewport. So the
// workspaces are now inline CHIPS on the headline row, capped at MAX_INLINE_WORKSPACES with a
// "+N more" summary carrying the rest in its title. The cap is what makes "one line" a
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
// through `useMyTurnByWorkspace`, which is the same fold the "Needs attention" board paints and
// the daily brief's my-turn line counts. Banner line, dropdown badge, brief line and destination
// board are one population and one number.
//
// ── AND THE POPULATION IS THE PERSONAL ONE ───────────────────────────────────────────────────
// This banner NOTIFIES, so it counts `myTurnPersonal`: reviews requested of you, your PRs,
// threads awaiting your reply, and new PRs only in repos you MAINTAIN or were @-mentioned on.
// Adding a repo you have never touched used to put every open PR in it here (425 of 459 items on
// the reporter's account). The "Needs attention" BOARD still holds all of them — they do need a
// review — which is why the click below goes through `openMyTurnInWorkspace`, the one gesture
// that also seats the board's matching 'mine' lens. A line that says 4 must not open a list
// of 50. There is consequently NO per-workspace "seen" state
// and no schema change: a line disappears when you deal with the work, not when you glance at it.
//
// ⚠ THE HEADLINE SPLITS THAT POPULATION IN TWO, the chips do not. "2 yours · 3 in your repos"
// (`totalSplit`, off `MyTurnCard.relevance`) says which half is which without changing WHAT is
// counted — the chips, the dropdown badges and the OS notification all still count the sum, and
// the click still opens the whole 'mine' board. Splitting the chips as well would cost a second
// number per workspace on a row whose one-line guarantee is the reason this component exists.
//
// ── THE CLICK ────────────────────────────────────────────────────────────────────────────────
// Each line goes through `openMyTurnInWorkspace`, the ONE store action that switches scope and
// isolates the board to `my_turn` in the correct order (see its declaration — two independent
// ordering traps live in there). So the line that says "Platform · 4" lands you in Platform,
// looking at those four cards.
//
// Dismissal is component-local and therefore lasts the session (this is mounted once, in App).
// That is the only mute there is now: the population is standing work, so nothing "marks it seen".
// Hidden while you are already on the Activity console, where the daily-brief strip says it
// better. My Turn is CORE / free, so this shows on every tier.
/**
 * How many workspace chips ride the headline before the rest collapse into "+N more".
 * Four fits comfortably beside the headline at a narrow window; beyond that the row would
 * start truncating names into uselessness, and a summary is more honest than three letters.
 */
const MAX_INLINE_WORKSPACES = 4;

export function WelcomeBackBanner(): JSX.Element | null {
  const { data: me } = useMe();
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const openMyTurnInWorkspace = useFilters((s) => s.openMyTurnInWorkspace);
  const { lines, total, totalSplit, anyCapped, uncounted } = useMyTurnByWorkspace();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !me?.user) return null;
  // Already in the Activity console → no nag; the brief strip covers it there.
  if (activeTab === 'activity') return null;
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
  const restTitle = [
    overflow.length > 0
      ? `Also needing you: ${overflow.map((l) => `${l.name} (${l.count}${l.cap != null ? '+' : ''})`).join(', ')}.`
      : null,
    uncounted.length > 0
      ? `Not counted here: ${uncounted.map((w) => w.name).join(', ')}. Switch to one to see its own count.`
      : null,
  ]
    .filter((s): s is string => s != null)
    .join(' ');
  const restCount = overflow.length + uncounted.length;

  return (
    // ONE ROW. `flex-nowrap` + `overflow-hidden` are load-bearing: they are what stops a long
    // workspace name from wrapping this into a two-line banner. `shrink-0` keeps App's flex
    // column from squeezing it instead.
    <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-amber-200 bg-amber-50 px-4 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
      <span className="shrink-0 font-medium">Welcome back</span>
      <span className="shrink-0 text-amber-700/80 dark:text-amber-300/80">
        {/* The headline sums CAPPED card counts, so it says "N+" the moment any line is
            capped — the summed figure is a floor, and saying so is cheaper than a wrong
            total. The per-chip tooltips carry the exact pairs.

            ⚠ AND IT SHOWS THE SPLIT WHEN IT HAS ONE. A bare "5 items need you" is the conflation
            this batch exists to undo: two of those may be PRs you wrote and three may be other
            people's PRs in repos you happen to maintain, which is orbit rather than ownership.
            The POPULATION is unchanged — the chips, the badges and the OS notification still
            count the sum — this only says which half is which. Absent split ⇒ the old single
            figure, never a half rendered as if it were the whole. */}
        {totalSplit != null ? (
          <>
            · {totalSplit.direct}
            {anyCapped ? '+' : ''} yours · {totalSplit.maintained}
            {anyCapped ? '+' : ''} in your repos
          </>
        ) : (
          <>
            · {total}
            {anyCapped ? '+' : ''} item{singular ? '' : 's'} need{singular ? 's' : ''} you
          </>
        )}
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
                  <sup className="ml-px text-[8px] font-normal opacity-70" aria-hidden>
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
          // workspaces quietly — even when the reason is only that the row ran out of room.
          <span
            className="shrink-0 px-1 text-[10px] text-amber-700/70 dark:text-amber-300/70"
            title={restTitle}
          >
            +{restCount} more
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss for this session"
        className="flex shrink-0 items-center rounded px-1 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
