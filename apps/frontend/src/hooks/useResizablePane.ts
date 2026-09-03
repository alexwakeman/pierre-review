import { useCallback, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useLocalStorage } from './useLocalStorage.js';

/**
 * The one place a width is bounded. `max` below `min` is a real state — a very narrow
 * container, or a stored width restored on a smaller screen — and the FLOOR wins there, so the
 * pane overflows rather than the bounds inverting and collapsing it to the wrong edge. A
 * non-finite stored value (a hand-edited or half-written localStorage entry) falls back to
 * `fallback` rather than poisoning the layout with NaN.
 */
export function clampPaneWidth(
  n: number,
  min: number,
  max: number,
  fallback: number,
): number {
  const hi = Math.max(min, max);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(Math.max(Math.round(v), min), hi);
}

export interface ResizablePaneSeparatorProps {
  role: 'separator';
  'aria-orientation': 'vertical';
  'aria-label': string;
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  tabIndex: 0;
  title: string;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

/**
 * A horizontal split: one pane whose WIDTH the user drags, remembered across reloads.
 *
 * Mirrors App.tsx's vertical detail-pane splitter — during a drag the width is written
 * straight onto the DOM node (no per-frame React render over a diff that can be thousands
 * of rows) and only committed to state, and therefore localStorage, on release.
 *
 * The persisted value lives in localStorage, NOT the Zustand filter store: persistence and
 * "Clear filters" share one list there (store/filters.ts), so a pane width parked in it
 * would be wiped by a filter reset.
 *
 * A11y is part of the contract, not a nicety: the handle is a focusable
 * `role="separator"` with arrow-key/Home/End steps and a live `aria-valuenow`, so the
 * split is reachable without a pointer. Double-click restores `defaultWidth`.
 */

export function useResizablePane(opts: {
  /** localStorage key. Namespaced `pierre:` like every other persisted UI pref. */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  /**
   * Upper bound, normally derived from the container so the OTHER pane can never be dragged
   * to nothing. Recomputed by the caller on resize; a stored width above it is clamped for
   * this render WITHOUT being written back, so shrinking the window doesn't quietly destroy
   * the user's chosen width.
   */
  maxWidth: number;
  /** Announced by screen readers on the handle. */
  label: string;
  /** Arrow-key step in px (Shift multiplies by 4). */
  keyStep?: number;
}): {
  width: number;
  paneRef: RefObject<HTMLDivElement>;
  separatorProps: ResizablePaneSeparatorProps;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, label, keyStep = 16 } = opts;
  const [stored, setStored] = useLocalStorage<number>(storageKey, defaultWidth);
  const paneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const hi = Math.max(minWidth, maxWidth);
  const clamp = useCallback(
    (n: number): number => clampPaneWidth(n, minWidth, maxWidth, defaultWidth),
    [minWidth, maxWidth, defaultWidth],
  );
  // A stored value out of today's bounds is honoured up to the bound, not reset: shrinking the
  // window must not quietly destroy a width the user chose on a bigger one.
  const width = clamp(stored);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (paneRef.current == null) return;
    // Stops the drag from starting a text selection across the diff.
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: paneRef.current.offsetWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const d = dragRef.current;
      const el = paneRef.current;
      if (d == null || el == null) return;
      el.style.width = `${clamp(d.startW + (e.clientX - d.startX))}px`;
    },
    [clamp],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const el = paneRef.current;
      if (dragRef.current == null || el == null) return;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setStored(clamp(el.offsetWidth)); // commit + persist
    },
    [clamp, setStored],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const step = e.shiftKey ? keyStep * 4 : keyStep;
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = width - step;
      else if (e.key === 'ArrowRight') next = width + step;
      else if (e.key === 'Home') next = minWidth;
      else if (e.key === 'End') next = hi;
      else if (e.key === 'Enter' || e.key === ' ') next = defaultWidth; // same reset as dblclick
      if (next == null) return;
      e.preventDefault();
      setStored(clamp(next));
    },
    [width, keyStep, minWidth, hi, defaultWidth, clamp, setStored],
  );

  const onDoubleClick = useCallback((): void => {
    setStored(clamp(defaultWidth));
  }, [clamp, defaultWidth, setStored]);

  return {
    width,
    paneRef,
    separatorProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': label,
      'aria-valuenow': width,
      'aria-valuemin': minWidth,
      'aria-valuemax': hi,
      tabIndex: 0,
      title: 'Drag to resize — double-click to reset',
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
      onDoubleClick,
    },
  };
}
