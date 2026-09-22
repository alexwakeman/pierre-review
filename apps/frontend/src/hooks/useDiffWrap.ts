import { useSyncExternalStore } from 'react';

/**
 * Whether the diff viewer wraps long lines. ON by default, remembered in localStorage.
 *
 * ⚠ ONE MODULE-LEVEL VALUE, NOT `useLocalStorage`. That hook is per-INSTANCE state: the toggle
 * sits in the Changes tab's header while every `FileDiffView` block reads the value, and the AI
 * Fix tab mounts the viewer twice — separate `useState`s would each read the stored value once
 * and then disagree until a reload. A `useSyncExternalStore` over one variable repaints every
 * mount on the same press.
 *
 * Browser-local, never the filter store: persistence and "Clear filters" share one list there,
 * and a reset must not move the furniture (the rail width's rule).
 */
const KEY = 'pierre:diffWrap';

function read(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    return raw == null ? true : raw !== 'false';
  } catch {
    return true;
  }
}

let current: boolean | null = null;
const listeners = new Set<() => void>();

function snapshot(): boolean {
  if (current == null) current = read();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDiffWrap(next: boolean): void {
  current = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* quota / private mode — non-fatal, the choice just won't persist */
  }
  for (const l of listeners) l();
}

export function useDiffWrap(): [boolean, (next: boolean) => void] {
  const wrap = useSyncExternalStore(subscribe, snapshot, () => true);
  return [wrap, setDiffWrap];
}
