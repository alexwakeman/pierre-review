import { create } from 'zustand';

// Per-repo collapse state for the Pro digest cards (the Feed collection + the single-repo
// console). Persisted to localStorage so a repo whose digest you collapsed (because its summary
// is redundant to you) stays collapsed across reloads. Mirrors the timeline's collapsed-rows.
const KEY = 'pierre:collapsedDigests';

function load(): Set<number> {
  try {
    const raw = localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : []);
  } catch {
    return new Set();
  }
}

function save(s: Set<number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

interface DigestCollapseState {
  collapsed: Set<number>;
  toggle: (repoId: number) => void;
}

export const useDigestCollapse = create<DigestCollapseState>((set, get) => ({
  collapsed: load(),
  toggle: (repoId) => {
    const next = new Set(get().collapsed);
    if (next.has(repoId)) next.delete(repoId);
    else next.add(repoId);
    save(next);
    set({ collapsed: next });
  },
}));

// Insights-panel variant: the branch/repo summaries there are COLLAPSED BY DEFAULT (they
// sit under the sprint report as reference), so this store tracks the EXPANDED ids instead
// — absent = collapsed. Separate key so it doesn't fight the Feed/console collapse store.
const INSIGHTS_KEY = 'pierre:insightsDigestsExpanded';

function loadExpanded(): Set<number> {
  try {
    const raw = localStorage.getItem(INSIGHTS_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : []);
  } catch {
    return new Set();
  }
}

interface InsightsDigestExpandState {
  expanded: Set<number>;
  toggle: (repoId: number) => void;
}

export const useInsightsDigestExpand = create<InsightsDigestExpandState>((set, get) => ({
  expanded: loadExpanded(),
  toggle: (repoId) => {
    const next = new Set(get().expanded);
    if (next.has(repoId)) next.delete(repoId);
    else next.add(repoId);
    try {
      localStorage.setItem(INSIGHTS_KEY, JSON.stringify([...next]));
    } catch {
      /* non-fatal */
    }
    set({ expanded: next });
  },
}));

// (`useSprintReportUi` — the Sprint report card's persisted collapse chrome, localStorage key
// 'pierre:sprintReportUi' — was REMOVED with `SprintReportCard` on the C7 cut list.)

// The Feed's "Open PRs" panel (the workspace's open PRs, grouped PER REPO, above the feed). COLLAPSED
// BY DEFAULT — it's a filter affordance, not primary content — and its open/closed choice is
// persisted so it survives navigating away from the Feed and back, and across reloads.
const FEED_OPEN_PRS_KEY = 'pierre:feedOpenPrsPanel';

function loadFeedOpenPrsCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(FEED_OPEN_PRS_KEY);
    if (raw == null) return true; // default: collapsed
    return JSON.parse(raw) === true;
  } catch {
    return true;
  }
}

interface FeedOpenPrsPanelState {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
}

export const useFeedOpenPrsPanel = create<FeedOpenPrsPanelState>((set, get) => {
  const save = (collapsed: boolean): void => {
    try {
      localStorage.setItem(FEED_OPEN_PRS_KEY, JSON.stringify(collapsed));
    } catch {
      /* quota / private mode — non-fatal */
    }
  };
  return {
    collapsed: loadFeedOpenPrsCollapsed(),
    setCollapsed: (v) => {
      set({ collapsed: v });
      save(v);
    },
    toggle: () => {
      const next = !get().collapsed;
      set({ collapsed: next });
      save(next);
    },
  };
});

// The single-repo console's "Open PRs" list (above that repo's activity feed). COLLAPSED
// BY DEFAULT — same treatment as the cross-repo Feed panel above — so the repo view opens
// on its feed, with the open-PR list one click away. Its own persisted key, so collapsing
// the repo list doesn't move the Feed panel and vice versa.
const REPO_OPEN_PRS_KEY = 'pierre:repoOpenPrsPanel';

function loadRepoOpenPrsCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(REPO_OPEN_PRS_KEY);
    if (raw == null) return true; // default: collapsed
    return JSON.parse(raw) === true;
  } catch {
    return true;
  }
}

export const useRepoOpenPrsPanel = create<FeedOpenPrsPanelState>((set, get) => {
  const save = (collapsed: boolean): void => {
    try {
      localStorage.setItem(REPO_OPEN_PRS_KEY, JSON.stringify(collapsed));
    } catch {
      /* quota / private mode — non-fatal */
    }
  };
  return {
    collapsed: loadRepoOpenPrsCollapsed(),
    setCollapsed: (v) => {
      set({ collapsed: v });
      save(v);
    },
    toggle: () => {
      const next = !get().collapsed;
      set({ collapsed: next });
      save(next);
    },
  };
});
