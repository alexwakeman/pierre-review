import { create } from 'zustand';
import { DEFAULT_OPEN_PRS_VIEW, OPEN_PRS_VIEWS, type OpenPrsView } from '../lib/openPrsStacks.js';

// The Open PRs tab's per-viewer convenience: "Group by ticket" vs "List". localStorage ONLY — never
// the URL and never `FilterDefaults`: a view preference is not something a shared link should impose,
// and "Clear filters" must not regroup the page. Every read/write is try/catch (private mode, blocked
// storage): the page renders the default (grouped) without it.
//
// Ticket stacks no longer collapse, so the old `pierre:openPrsCollapsedStacks` key is never read or
// written (a leftover value in a browser is inert).

const VIEW_KEY = 'pierre:openPrsView';

function loadView(): OpenPrsView {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return OPEN_PRS_VIEWS.includes(raw as OpenPrsView) ? (raw as OpenPrsView) : DEFAULT_OPEN_PRS_VIEW;
  } catch {
    return DEFAULT_OPEN_PRS_VIEW;
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
  setView: (v: OpenPrsView) => void;
}

export const useOpenPrsView = create<OpenPrsViewState>((set) => ({
  view: loadView(),
  setView: (view) => {
    save(VIEW_KEY, view);
    set({ view });
  },
}));
