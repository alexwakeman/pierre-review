import { create } from 'zustand';

// Per-repo collapse state for the Pro digest cards (the Feed collection + the single-repo
// console). Persisted to localStorage so a repo whose digest you collapsed (redundant even
// though watched) stays collapsed across reloads. Mirrors the timeline's collapsed-rows.
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

// The Sprint report card's own collapse chrome — the top-level card body AND its nested
// "Repo summaries" container. Both were ephemeral React state, so navigating away from the
// Insights tab and back reset them (the container snapped shut every time, which also hid
// the per-repo expand state from view). Persisted here so the reader's layout choices
// survive a tab switch / reload. Defaults preserve the prior behaviour: card expanded, the
// (length-heavy) repo-summaries section collapsed.
const SPRINT_UI_KEY = 'pierre:sprintReportUi';

interface SprintUiPersisted {
  collapsed: boolean;
  reposOpen: boolean;
}

function loadSprintUi(): SprintUiPersisted {
  const fallback: SprintUiPersisted = { collapsed: false, reposOpen: false };
  try {
    const raw = localStorage.getItem(SPRINT_UI_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object') return fallback;
    const p = parsed as Record<string, unknown>;
    return {
      collapsed: typeof p.collapsed === 'boolean' ? p.collapsed : false,
      reposOpen: typeof p.reposOpen === 'boolean' ? p.reposOpen : false,
    };
  } catch {
    return fallback;
  }
}

interface SprintReportUiState extends SprintUiPersisted {
  setCollapsed: (v: boolean) => void;
  setReposOpen: (v: boolean) => void;
}

export const useSprintReportUi = create<SprintReportUiState>((set, get) => {
  const save = (): void => {
    try {
      const { collapsed, reposOpen } = get();
      localStorage.setItem(SPRINT_UI_KEY, JSON.stringify({ collapsed, reposOpen }));
    } catch {
      /* quota / private mode — non-fatal */
    }
  };
  return {
    ...loadSprintUi(),
    setCollapsed: (v) => {
      set({ collapsed: v });
      save();
    },
    setReposOpen: (v) => {
      set({ reposOpen: v });
      save();
    },
  };
});
