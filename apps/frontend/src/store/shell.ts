import { create } from 'zustand';

// THE SHELL'S OWN UI STATE (docs/redesign/DESIGN.md § Layout): the mobile drawer, Help, the key
// sheet, the Repositories group and the "Needs you" dismissal. None of it is a view, so none of it
// is in the URL; only the Repositories group's open/closed choice outlives a reload (localStorage).
// Navigation itself stays in the two real stores (`filters.activityRepoId`, `pinnedTabs.activeTab`)
// — the shell only ever calls their actions (components/shell/nav.ts).

const REPOS_OPEN_KEY = 'limn:sidebarReposOpen';

function readReposOpen(): boolean {
  try {
    return (globalThis.localStorage?.getItem(REPOS_OPEN_KEY) ?? '1') !== '0';
  } catch {
    return true;
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
  /** The sidebar's Repositories group. Remembered across reloads. */
  reposOpen: boolean;
  setReposOpen: (open: boolean) => void;
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
  needsYouDismissed: false,
  dismissNeedsYou: () => set({ needsYouDismissed: true }),
}));
