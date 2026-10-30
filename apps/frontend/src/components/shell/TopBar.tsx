import { useRepos } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useShell } from '../../store/shell.js';
import { MenuIcon } from '../Icons.js';
import { PinnedTabsBar } from '../PinnedTabsBar.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { currentLocation, destination } from './nav.js';
import { tabWords } from './Sidebar.js';
import { AlertDot } from './AlertDot.js';
import { useShellSignals } from './shellSignals.js';
import type { ReactNode } from 'react';

// THE SLIM TOP BAR — the one strip above the content (docs/redesign/DESIGN.md § 1).
//
//   [≡ below lg] [where you are] [open tabs, md+] [the ONE header toast strip]
//
// ⚠ A FIXED HEIGHT (`h-11`): the toast strip and its cards fit inside it, so a card appearing or
// disappearing never moves the page by a pixel (docs/FRONTEND.md § There is ONE header toast strip).
// The right-hand controls the old header carried — Sync, the bell, Help, the theme, AI usage, the
// account — moved to the sidebar's foot; the wordmark heads the sidebar.
//
// ⚠ COLLAPSED (`collapsed`, App.tsx) at ≥ lg when no tabs are open: the band would hold only the toast
// strip, so the strip sits at the end of the page header's title row instead (components/ui/
// PageHeader.tsx) and the bar is `lg:hidden`. Below lg it always stays (menu button + location).
export function TopBar({ toasts, collapsed = false }: { toasts: ReactNode; collapsed?: boolean }): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  const setDrawerOpen = useShell((s) => s.setDrawerOpen);
  const { data: repos } = useRepos();
  const signals = useShellSignals();
  const loc = currentLocation(activeTab, tabs, activityRepoId);
  const activeDynamic = loc == null ? tabs.find((t) => t.key === activeTab) : undefined;
  const label =
    typeof loc === 'number'
      ? ((repos ?? []).find((r) => r.id === loc)?.fullName ?? 'Repository')
      : loc != null
        ? destination(loc).label
        : activeDynamic != null
          ? tabWords(activeDynamic)
          : '';
  // Below lg the sidebar is a drawer and, from md to lg, there is no bottom bar either: the menu
  // button carries what the phone's bottom bar shows — the Pending count, and a mark when other
  // workspaces need you (the drawer's "Needs you elsewhere" strip) or a sync / AI alert stands.
  const menuTone = signals.alert ?? (signals.elsewhere > 0 ? 'accent' : null);
  const menuWords = [
    signals.pending != null
      ? `${signals.pending.count}${signals.pending.capped ? ' or more' : ''} need you in Pending`
      : null,
    signals.elsewhere > 0 ? `${signals.elsewhere} need you in other workspaces` : null,
    signals.alertWords,
  ].filter((w): w is string => w != null);
  return (
    <header data-shell-topbar className={cx('flex h-11 shrink-0 items-center gap-2 bg-ui-bg pl-2 pr-3 lg:pl-4', collapsed && 'lg:hidden')}>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label={menuWords.length > 0 ? `Open menu. ${menuWords.join('; ')}` : 'Open menu'}
        title={menuWords.length > 0 ? `Menu — ${menuWords.join('; ')}` : 'Menu'}
        data-alert={signals.alert ?? undefined}
        data-testid="topbar-menu"
        className={cx(
          'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10 lg:hidden',
          FOCUS_RING,
        )}
      >
        <MenuIcon />
        {menuTone != null && <AlertDot tone={menuTone} />}
        {/* md–lg only: below md the bottom bar's Pending tab shows the count. */}
        {signals.pending != null && (
          <span
            aria-hidden
            data-testid="topbar-pending-count"
            className="absolute -bottom-0.5 -right-1 hidden min-w-[18px] rounded-full bg-ui-accent-fill px-1 text-center text-meta leading-[18px] tabular-nums text-ui-on-accent md:block"
          >
            {signals.pending.count}
            {signals.pending.capped ? '+' : ''}
          </span>
        )}
      </button>
      {/* Where you are — for when the sidebar is not on screen (below lg). At lg+ the sidebar's
          highlight says it; on md+ a dynamic tab says it through its highlighted chip. */}
      <p
        className={cx(
          // Below md the location takes what the toasts leave (min-w-0 flex-1), never a fixed cap —
          // a fixed 55% let a toast overrun the bar's clipped edge.
          'min-w-0 flex-1 truncate text-body font-medium text-ui-ink md:flex-none',
          loc == null ? 'md:hidden' : 'md:max-w-[14rem] lg:hidden',
        )}
        data-testid="topbar-location"
        title={signals.workspaceName != null ? `${signals.workspaceName} · ${label}` : label}
      >
        {/* The workspace you are in — on main its pill was visible at every width. */}
        {signals.workspaceName != null && (
          <span className="font-normal text-ui-faint" data-testid="topbar-workspace">
            {signals.workspaceName}
            <span aria-hidden> / </span>
            <span className="sr-only">: </span>
          </span>
        )}
        {label}
      </p>
      <div className="hidden min-w-0 flex-1 md:flex">
        <PinnedTabsBar />
      </div>
      <div className="flex min-w-0 max-w-[62%] shrink-0 justify-end md:max-w-[min(34rem,45%)] md:flex-none md:basis-[34rem] md:justify-start">
        {toasts}
      </div>
    </header>
  );
}
