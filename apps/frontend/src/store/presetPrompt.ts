import { create } from 'zustand';
import type { PresetPromptKey } from '@pierre-review/shared';

// Which "Ask about this scope" preset answers are currently OPEN on the panel, per team scope.
// Persisted to localStorage so leaving the Insights "Sprint" sub-tab and returning keeps the
// answers you were reading visible (the answer DATA lives in the react-query cache; this store
// just remembers WHICH ones to show). Multiple keys per scope → several answers render at once
// so you can compare them side by side. Keyed by the wire scope string ('all'|'none'|'teams'|id).
const KEY = 'pierre:presetPromptOpen';

type Persisted = Record<string, PresetPromptKey[]>;

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed == null || typeof parsed !== 'object') return {};
    const out: Persisted = {};
    for (const [scope, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(val)) {
        out[scope] = val.filter((k): k is PresetPromptKey => typeof k === 'string');
      }
    }
    return out;
  } catch {
    return {};
  }
}

interface PresetPromptState {
  openByScope: Persisted;
  // Add a preset to the open set for a scope (idempotent — appended once, order preserved).
  open: (scope: string, key: PresetPromptKey) => void;
  // Remove a preset's answer from the panel for a scope.
  close: (scope: string, key: PresetPromptKey) => void;
}

export const usePresetPromptOpen = create<PresetPromptState>((set, get) => {
  const persist = (next: Persisted): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode — non-fatal */
    }
  };
  return {
    openByScope: load(),
    open: (scope, key) => {
      const cur = get().openByScope[scope] ?? [];
      if (cur.includes(key)) return;
      const next = { ...get().openByScope, [scope]: [...cur, key] };
      persist(next);
      set({ openByScope: next });
    },
    close: (scope, key) => {
      const cur = get().openByScope[scope] ?? [];
      if (!cur.includes(key)) return;
      const next = { ...get().openByScope, [scope]: cur.filter((k) => k !== key) };
      persist(next);
      set({ openByScope: next });
    },
  };
});
