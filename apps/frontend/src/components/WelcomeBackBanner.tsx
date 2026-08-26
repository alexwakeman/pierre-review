import { useState } from 'react';
import { useMe } from '../hooks/useTriage.js';
import { useMyTurnByWorkspace } from '../hooks/useMyTurnByWorkspace.js';
import { usePinnedTabs } from '../store/pinnedTabs.js';
import { useFilters } from '../store/filters.js';

// The "Welcome back" banner — ONE LINE PER WORKSPACE that has something on your plate.
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
// board are one population and one number. There is consequently NO per-workspace "seen" state
// and no schema change: a line disappears when you deal with the work, not when you glance at it.
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
export function WelcomeBackBanner(): JSX.Element | null {
  const { data: me } = useMe();
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const openMyTurnInWorkspace = useFilters((s) => s.openMyTurnInWorkspace);
  const { lines, total, anyCapped, uncounted } = useMyTurnByWorkspace();
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

  return (
    // `shrink-0`: this is now MULTI-LINE (one row per workspace) inside App's flex column, where
    // the single-line original could get away without it.
    <div className="flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 font-medium">Welcome back</span>
          <span className="min-w-0 truncate text-amber-700/80 dark:text-amber-300/80">
            {/* The headline sums CAPPED card counts, so it says "N+" the moment any line is
                capped — the summed figure is a floor, and saying so is cheaper than a wrong
                total. The per-line tooltips carry the exact pairs. */}
            · {total}
            {anyCapped ? '+' : ''} item{singular ? '' : 's'} need{singular ? 's' : ''} you
            {lines.length > 1 ? ` across ${lines.length} Workspaces` : ''}
          </span>
        </div>
        <ul className="flex flex-col gap-0.5">
          {lines.map((l) => (
            <li key={l.workspaceId}>
              <button
                type="button"
                onClick={() => open(l.workspaceId)}
                // The cap sentence rides the WHOLE line, not the 6px superscript — a disclosure
                // nobody can hover is a silent cap with extra steps.
                title={
                  l.cap?.title ??
                  (l.isActive
                    ? `Show these in ${l.name}`
                    : `Switch to ${l.name} and show these`)
                }
                className="group flex w-full items-baseline gap-2 rounded px-1 py-px text-left hover:bg-amber-100/70 dark:hover:bg-amber-900/40"
              >
                <span
                  aria-hidden
                  // The ACTIVE workspace is the one the user can already see; the hollow dots
                  // are the ones they cannot reach from here, which is the whole reason this
                  // banner is per-workspace.
                  className={`mt-px inline-block h-1.5 w-1.5 shrink-0 rounded-full border ${
                    l.isActive
                      ? 'border-amber-500 bg-amber-500'
                      : 'border-amber-400 dark:border-amber-600'
                  }`}
                />
                <span className="w-6 shrink-0 text-right font-semibold tabular-nums">
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
                {l.isActive && (
                  <span className="shrink-0 rounded bg-amber-200/70 px-1 text-[9px] uppercase tracking-wide text-amber-800 dark:bg-amber-800/50 dark:text-amber-200">
                    this Workspace
                  </span>
                )}
              </button>
            </li>
          ))}
          {uncounted.length > 0 && (
            // The roll-up's own cap. A banner whose purpose is "work you cannot see from here"
            // does not get to omit workspaces quietly.
            <li
              className="px-1 text-[10px] text-amber-700/70 dark:text-amber-300/70"
              title={`Not counted here: ${uncounted.map((w) => w.name).join(', ')}. Switch to one to see its own count.`}
            >
              {uncounted.length} other Workspace{uncounted.length === 1 ? '' : 's'} not counted
            </li>
          )}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss for this session"
        className="shrink-0 rounded px-1 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
      >
        ✕
      </button>
    </div>
  );
}
