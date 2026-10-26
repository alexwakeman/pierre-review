import { create } from 'zustand';
import { NO_CARD_FILTER, type SprintCardFilter } from '../lib/laneBoard.js';

// This Sprint's board filters — "Has PRs" and "Needs code" (lib/laneBoard.ts `sprintCardFilter`), shared
// by all three boards. A per-viewer convenience like the Open PRs "Group by ticket / List" choice
// (store/openPrsView.ts): localStorage ONLY — never the URL and never `FilterDefaults`, so no
// FILTER_STORAGE_VERSION bump and "Clear filters" leaves it alone. Every read/write is try/catch
// (private mode, blocked storage): the board shows every ticket without it.

const KEY = 'pierre:sprintBoardFilter';

function load(): SprintCardFilter {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return NO_CARD_FILTER;
    const v = JSON.parse(raw) as Partial<SprintCardFilter> | null;
    return { hasPrs: v?.hasPrs === true, needsCode: v?.needsCode === true };
  } catch {
    return NO_CARD_FILTER;
  }
}

function save(v: SprintCardFilter): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* quota / private mode — non-fatal, the choice just won't persist */
  }
}

interface SprintBoardFilterState {
  filter: SprintCardFilter;
  toggle: (which: keyof SprintCardFilter) => void;
}

export const useSprintBoardFilter = create<SprintBoardFilterState>((set, get) => ({
  filter: load(),
  toggle: (which) => {
    const filter = { ...get().filter, [which]: !get().filter[which] };
    save(filter);
    set({ filter });
  },
}));
