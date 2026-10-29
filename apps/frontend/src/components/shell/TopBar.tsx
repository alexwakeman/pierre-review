import { useRepos } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useShell } from '../../store/shell.js';
import { MenuIcon } from '../Icons.js';
import { PinnedTabsBar } from '../PinnedTabsBar.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { currentLocation, destination } from './nav.js';
import { tabWords } from './Sidebar.js';
import type { ReactNode } from 'react';

// THE SLIM TOP BAR — the one strip above the content (docs/redesign/DESIGN.md § 1).
//
//   [≡ below lg] [where you are] [open tabs, md+] [the ONE header toast strip]
//
// ⚠ A FIXED HEIGHT (`h-11`): the toast strip and its cards fit inside it, so a card appearing or
// disappearing never moves the page by a pixel (docs/FRONTEND.md § There is ONE header toast strip).
// The right-hand controls the old header carried — Sync, the bell, Help, the theme, AI usage, the
// account — moved to the sidebar's foot; the wordmark heads the sidebar.
export function TopBar({ toasts }: { toasts: ReactNode }): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  const setDrawerOpen = useShell((s) => s.setDrawerOpen);
  const { data: repos } = useRepos();
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
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 bg-ui-bg pl-2 pr-3 lg:pl-4">
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open menu"
        title="Menu"
        className={cx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10 lg:hidden',
          FOCUS_RING,
        )}
      >
        <MenuIcon />
      </button>
      {/* Where you are — for when the sidebar is not on screen (below lg). At lg+ the sidebar's
          highlight says it; on md+ a dynamic tab says it through its highlighted chip. */}
      <p
        className={cx(
          'min-w-0 shrink truncate text-body font-medium text-ui-ink',
          loc == null ? 'md:hidden' : 'max-w-[40%] md:max-w-[14rem] lg:hidden',
        )}
        data-testid="topbar-location"
      >
        {label}
      </p>
      <div className="hidden min-w-0 flex-1 md:flex">
        <PinnedTabsBar />
      </div>
      <div className="flex min-w-0 flex-1 md:max-w-[min(34rem,45%)] md:flex-none md:basis-[34rem]">{toasts}</div>
    </header>
  );
}
