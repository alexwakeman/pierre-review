// THE ONE-LINE LIST'S KEYBOARD MODEL, PURE (test/uiPrimitives.test.ts pins it).
//
// j / ↓ next, k / ↑ previous, Home / End (and g / G) first / last, Enter open (Shift+Enter: go
// straight to the item, where the screen offers it), and a screen's own
// single-letter ACTION keys (a approve, m merge, e done …). Arrows and Enter only act when focus is
// inside the list (so they never steal page scrolling or a focused button's Enter); the letters
// act from anywhere on the page that is not a field, a popover or a modal (`shortcutBlocked`).

export type ListMove = 'next' | 'prev' | 'first' | 'last';

/** Where the selection goes. `null` current = nothing selected yet: any move lands on the first. */
export function nextIndex(current: number | null, count: number, move: ListMove): number | null {
  if (count <= 0) return null;
  if (current == null || current < 0 || current >= count) {
    return move === 'last' ? count - 1 : 0;
  }
  switch (move) {
    case 'next':
      return Math.min(count - 1, current + 1);
    case 'prev':
      return Math.max(0, current - 1);
    case 'first':
      return 0;
    case 'last':
      return count - 1;
  }
}

export type ListKeyResult =
  | { kind: 'move'; move: ListMove }
  | { kind: 'open' }
  /** Shift+Enter: go straight to the row's item (past the panel). */
  | { kind: 'go' }
  | { kind: 'action'; key: string }
  | null;

/**
 * Map a key to what the list should do. `focusInside`: focus is within the list (arrows, Enter,
 * Home and End only count then). `actionKeys`: the screen's own letters. Letters are matched
 * lower-case; Shift+G is "last".
 */
export function resolveListKey(
  key: string,
  opts: { focusInside: boolean; actionKeys: readonly string[]; shift?: boolean },
): ListKeyResult {
  if (key === 'j') return { kind: 'move', move: 'next' };
  if (key === 'k') return { kind: 'move', move: 'prev' };
  if (key === 'G' || (key === 'g' && opts.shift)) return { kind: 'move', move: 'last' };
  if (opts.focusInside) {
    if (key === 'ArrowDown') return { kind: 'move', move: 'next' };
    if (key === 'ArrowUp') return { kind: 'move', move: 'prev' };
    if (key === 'Home') return { kind: 'move', move: 'first' };
    if (key === 'End') return { kind: 'move', move: 'last' };
    if (key === 'Enter') return opts.shift ? { kind: 'go' } : { kind: 'open' };
  }
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (opts.actionKeys.includes(lower) && lower !== 'j' && lower !== 'k') return { kind: 'action', key: lower };
  return null;
}

/** The next selection after the selected row is REMOVED (stay on the same slot, else step back). */
export function indexAfterRemoval(removed: number, countBefore: number): number | null {
  const countAfter = countBefore - 1;
  if (countAfter <= 0) return null;
  return Math.min(removed, countAfter - 1);
}
