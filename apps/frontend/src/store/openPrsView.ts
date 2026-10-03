import { create } from 'zustand';
import { DEFAULT_OPEN_PRS_VIEW, OPEN_PRS_VIEWS, type OpenPrsView } from '../lib/openPrsStacks.js';

// The Open PRs tab's two per-viewer conveniences: "Group by ticket" vs "List", and which ticket
// stacks are collapsed. localStorage ONLY — never the URL and never `FilterDefaults`: a view
// preference is not something a shared link should impose, and "Clear filters" must not regroup
// the page. Every read/write is try/catch (private mode, blocked storage): the page renders the
// defaults (grouped, nothing collapsed) without it.

const VIEW_KEY = 'pierre:openPrsView';
const COLLAPSED_KEY = 'pierre:openPrsCollapsedStacks';
/** A long-lived viewer collapses many tickets over months; keep the newest few hundred. */
const MAX_COLLAPSED = 300;

function loadView(): OpenPrsView {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return OPEN_PRS_VIEWS.includes(raw as OpenPrsView) ? (raw as OpenPrsView) : DEFAULT_OPEN_PRS_VIEW;
  } catch {
    return DEFAULT_OPEN_PRS_VIEW;
  }
}

function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / private mode — non-fatal, the choice just won't persist */
  }
}

interface OpenPrsViewState {
  view: OpenPrsView;
  /** Stack ids (`ticket:<KEY>` / `none`), oldest first. */
  collapsed: readonly string[];
  setView: (v: OpenPrsView) => void;
  toggleCollapsed: (stackId: string) => void;
  expand: (stackId: string) => void;
}

export const useOpenPrsView = create<OpenPrsViewState>((set, get) => ({
  view: loadView(),
  collapsed: loadCollapsed(),
  setView: (view) => {
    save(VIEW_KEY, view);
    set({ view });
  },
  toggleCollapsed: (id) => {
    const cur = get().collapsed;
    const next = cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id].slice(-MAX_COLLAPSED);
    save(COLLAPSED_KEY, JSON.stringify(next));
    set({ collapsed: next });
  },
  expand: (id) => {
    const cur = get().collapsed;
    if (!cur.includes(id)) return;
    const next = cur.filter((c) => c !== id);
    save(COLLAPSED_KEY, JSON.stringify(next));
    set({ collapsed: next });
  },
}));
