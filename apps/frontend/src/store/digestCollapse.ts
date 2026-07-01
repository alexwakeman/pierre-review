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
