import { useSyncExternalStore } from 'react';
import {
  applyScheme,
  currentScheme,
  readSchemeState,
  toggledMode,
  withScheme,
  writeSchemeState,
  type ColorScheme,
  type SchemeId,
  type SchemeState,
} from '../lib/colorSchemes.js';

// THE COLOUR SCHEME, ONE STORE FOR THE WHOLE APP. The sidebar's sun/moon, ⌘K and Settings →
// Appearance all read and write it here, so a pick in one shows at once in the others. Stored per
// browser in localStorage (lib/colorSchemes.ts); public/theme-boot.js already applied it before
// first paint, and the first read below re-applies it so <html> always matches the store.

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

let state: SchemeState = readSchemeState(safeGet);
applyScheme(document.documentElement, currentScheme(state));
const listeners = new Set<() => void>();

function commit(next: SchemeState): void {
  state = next;
  writeSchemeState(safeSet, state);
  applyScheme(document.documentElement, currentScheme(state));
  for (const l of listeners) l();
}

export function setColorScheme(id: SchemeId): void {
  commit(withScheme(state, id));
}

export function toggleColorMode(): void {
  commit(toggledMode(state));
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, () => currentScheme(state));
}
