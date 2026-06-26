import { useCallback, useEffect, useState } from 'react';
import {
  pickFilterBarState,
  sanitizePersistedFilters,
  savedViewMatchesCurrent,
  useFilters,
} from '../store/filters.js';

// A named snapshot of the filter bar (exactly pickFilterBarState — repos, members,
// range, categories, statuses, review verdicts, thread states, search, strip filter).
// Stored in localStorage so a user can flip between "My reviews", "Team sprint",
// "Stalled", etc. Selection / focus / detail state is deliberately NOT captured — a
// view reshapes the board, it doesn't move your selection. (My Turn Focus Mode is a
// transient mode, not a filter, so it is not captured either.)
export interface SavedView {
  name: string;
  state: ReturnType<typeof pickFilterBarState>;
}

const KEY = 'pierre:savedViews';
// The NAME of the saved view that was active when the app last had focus. Persisted
// so a bare load (no URL params) re-applies that view (see loadActiveSavedView /
// useUrlState). Distinct from the generic 'pierre:filterBarState' blob: this records
// the user's INTENT ("I'm in view X"), so the view stays authoritative even if the
// two ever diverge, and falls back to the filter blob when no view is active.
const ACTIVE_KEY = 'pierre:activeView';

function load(): SavedView[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedView[]) : [];
  } catch {
    return [];
  }
}

// The saved view that was active on last use, resolved against the current saved-view
// list (null if none was active, or it has since been deleted/renamed). Called by
// useUrlState on a bare load to restore the user's last view.
export function loadActiveSavedView(): SavedView | null {
  try {
    const name = localStorage.getItem(ACTIVE_KEY);
    if (!name) return null;
    return load().find((v) => v.name === name) ?? null;
  } catch {
    return null;
  }
}

export function useSavedViews(): {
  views: SavedView[];
  // The saved view whose snapshot equals the current filter bar, or null when the
  // current filters don't match any saved view (incl. after a manual edit).
  activeName: string | null;
  save: (name: string) => void;
  remove: (name: string) => void;
  apply: (view: SavedView) => void;
} {
  const [views, setViews] = useState<SavedView[]>(load);

  // The active view, derived from the live filter store: the saved view whose
  // snapshot matches the current filters. The selector returns a primitive (name or
  // null), so it only re-renders when the active view actually changes — not on
  // every filter tweak. Self-correcting: editing a filter away from a saved view's
  // shape clears the label.
  const activeName = useFilters((s) => {
    const current = pickFilterBarState(s);
    return views.find((v) => savedViewMatchesCurrent(v.state, current))?.name ?? null;
  });

  // Mirror the live active view to localStorage so a bare load restores it (Part 1).
  // Cleared when no view matches (a manual filter edit), so we never resurrect a view
  // the user has since edited away from.
  useEffect(() => {
    try {
      if (activeName != null) localStorage.setItem(ACTIVE_KEY, activeName);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* quota / private-mode — non-fatal */
    }
  }, [activeName]);

  const persist = useCallback((next: SavedView[]): void => {
    const sorted = [...next].sort((a, b) => a.name.localeCompare(b.name));
    setViews(sorted);
    try {
      localStorage.setItem(KEY, JSON.stringify(sorted));
    } catch {
      /* quota / private-mode — non-fatal */
    }
  }, []);

  const save = useCallback(
    (name: string): void => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const state = pickFilterBarState(useFilters.getState());
      persist([...views.filter((v) => v.name !== trimmed), { name: trimmed, state }]);
    },
    [views, persist],
  );

  const remove = useCallback(
    (name: string): void => persist(views.filter((v) => v.name !== name)),
    [views, persist],
  );

  const apply = useCallback((view: SavedView): void => {
    // Replace the whole filter bar, and bump rangeResetSignal so the timeline
    // re-applies the view's window (mirrors resetAllFilters). Sanitize first: a view
    // saved by an older build may carry a stale `myTurnOnly` (now a transient focus
    // mode) — applying it must reshape the board, not silently enter My Turn focus.
    useFilters.getState().hydrate({
      ...sanitizePersistedFilters(view.state),
      rangeResetSignal: useFilters.getState().rangeResetSignal + 1,
    });
  }, []);

  return { views, activeName, save, remove, apply };
}
