import { useEffect, useState } from 'react';

/**
 * Persist a small piece of UI state to localStorage. Mirrors the inline
 * `useDarkMode` pattern in App.tsx: lazy initializer reads + JSON-parses once,
 * an effect writes on change. Browser-local UI prefs only (sizes, layout) —
 * shareable filter state lives in the URL via useUrlState.
 */
export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / private-mode — non-fatal, the size just won't persist */
    }
  }, [key, value]);

  return [value, setValue];
}
