import { create } from 'zustand';

// THE SHELL'S OWN UI STATE (docs/redesign/DESIGN.md § Layout): the mobile drawer, Help, the key
// sheet, the Repositories group, the sidebar's width and the "Needs you" dismissal. None of it is a
// view, so none of it is in the URL; only the Repositories group's open/closed choice and the
// sidebar's width outlive a reload (localStorage).
// Navigation itself stays in the two real stores (`filters.activityRepoId`, `pinnedTabs.activeTab`)
// — the shell only ever calls their actions (components/shell/nav.ts).

const REPOS_OPEN_KEY = 'limn:sidebarReposOpen';
const SIDEBAR_WIDTH_KEY = 'limn:sidebarWidth';

/** The docked sidebar's width range (px) and default (15% wider than the old fixed 232). The reader
 *  may drag it wider for long tab and repo names, never so wide it crowds the page. */
export const SIDEBAR_WIDTH_MIN = 232;
export const SIDEBAR_WIDTH_DEFAULT = 268;
export const SIDEBAR_WIDTH_MAX = 420;

export function clampSidebarWidth(w: number): number {
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, w)));
}

function readSidebarWidth(): number {
  try {
    const n = Number(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? clampSidebarWidth(n) : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

// The sidebar's Open tabs list grouped under each PR's author ('1'); off by default.
const TABS_BY_AUTHOR_KEY = 'limn:sidebarTabsByAuthor';
function readTabsByAuthor(): boolean {
  try {
    return globalThis.localStorage?.getItem(TABS_BY_AUTHOR_KEY) === '1';
  } catch {
    return false;
  }
}

// Collapsed by default: only a reader's explicit expand ('1', written on toggle) opens it. The key
// is written only when the reader toggles, so a reader who never touched it starts collapsed.
function readReposOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(REPOS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

interface ShellState {
  /** The sidebar as a drawer (below `lg`). Ignored at desktop width, where it is always shown. */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  /** The Help modal (it had local state in App; the sidebar foot, ⌘K and `?` open it now). */
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  /** The keyboard-shortcut sheet (`?`). */
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  /** The sidebar's Repositories group. Collapsed by default; the reader's choice is remembered. */
  reposOpen: boolean;
  setReposOpen: (open: boolean) => void;
  /** The docked sidebar's width (lg+), dragged by its edge. Remembered across reloads. */
  sidebarWidth: number;
  /** `persist` false while a drag is in flight (one write on release, not one per pointermove). */
  setSidebarWidth: (w: number, persist?: boolean) => void;
  /** The sidebar's Open tabs, grouped under each PR's author. Off by default; remembered. */
  tabsByAuthor: boolean;
  setTabsByAuthor: (on: boolean) => void;
  /** "Needs you" hidden for this session (the Welcome-back strip's ×, kept). */
  needsYouDismissed: boolean;
  dismissNeedsYou: () => void;
}

export const useShell = create<ShellState>((set) => ({
  drawerOpen: false,
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  helpOpen: false,
  setHelpOpen: (open) => set({ helpOpen: open }),
  shortcutsOpen: false,
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  reposOpen: readReposOpen(),
  setReposOpen: (open) => {
    try {
      globalThis.localStorage?.setItem(REPOS_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* private mode: the choice lasts the session */
    }
    set({ reposOpen: open });
  },
  sidebarWidth: readSidebarWidth(),
  setSidebarWidth: (w, persist = true) => {
    const width = clampSidebarWidth(w);
    if (persist) {
      try {
        globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(width));
      } catch {
        /* private mode: the width lasts the session */
      }
    }
    set({ sidebarWidth: width });
  },
  tabsByAuthor: readTabsByAuthor(),
  setTabsByAuthor: (on) => {
    try {
      globalThis.localStorage?.setItem(TABS_BY_AUTHOR_KEY, on ? '1' : '0');
    } catch {
      /* private mode: the choice lasts the session */
    }
    set({ tabsByAuthor: on });
  },
  needsYouDismissed: false,
  dismissNeedsYou: () => set({ needsYouDismissed: true }),
}));
