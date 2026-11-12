import { useSyncExternalStore } from 'react';

/**
 * How the Changes tab shows a Markdown file: `rendered` (the default) or `plain` (the diff).
 * ONE value for every file, remembered in localStorage.
 *
 * A module-level store for the same reason as `useDiffWrap`: every Markdown block reads it, and a
 * per-instance `useLocalStorage` would let one file's press disagree with the next file's until a
 * reload. Browser-local, never the filter store (a filter reset must not move the furniture).
 */
export type MarkdownView = 'rendered' | 'plain';

const KEY = 'pierre:markdownView';

function read(): MarkdownView {
  try {
    return localStorage.getItem(KEY) === 'plain' ? 'plain' : 'rendered';
  } catch {
    return 'rendered';
  }
}

let current: MarkdownView | null = null;
const listeners = new Set<() => void>();

function snapshot(): MarkdownView {
  if (current == null) current = read();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMarkdownView(next: MarkdownView): void {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* quota / private mode — non-fatal, the choice just won't persist */
  }
  for (const l of listeners) l();
}

export function useMarkdownView(): [MarkdownView, (next: MarkdownView) => void] {
  const view = useSyncExternalStore(subscribe, snapshot, (): MarkdownView => 'rendered');
  return [view, setMarkdownView];
}
