import { useCallback, useState } from 'react';
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
