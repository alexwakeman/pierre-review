import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { scrollParentOf } from '../../lib/settleScroll.js';

// LAZY MOUNTING for the diff (FileDiffView): a stretch of code mounts the first time it comes within
// `NEAR_MARGIN` of the scroll pane's visible area, and then STAYS mounted. One IntersectionObserver
// per FileDiffView, rooted on the pane the diff scrolls in (PrDetail's `overflow-auto` column), so
// the margin is measured against what the reader can see — an observer on the viewport would clip
// at the pane's edge and never see anything coming.
//
// ⚠ LATCHED, never unmounted again. Unmounting on the way out would drop what lives in the rows: a
// half-typed inline comment, a pill's flash, an expanded gap. Scrolling the whole PR therefore ends
// with everything mounted, exactly as before; what changes is that the first paint, a tab switch and
// a deep link pay only for what is near the screen.
//
// ⚠ A HIDDEN diff (the Threads only view keeps the code mounted under `display: none`) intersects
// nothing, so nothing mounts behind it; switching the view off mounts what comes into sight.

/** How far beyond the pane's visible area a placeholder starts to mount: 1.5 panes each way. */
const NEAR_MARGIN = '150% 0px';

export interface LazyMounter {
  /** Call `onNear` once `el` comes near the visible area. Returns an unsubscribe. */
  observe: (el: Element, onNear: () => void) => () => void;
  disconnect: () => void;
}

export function createLazyMounter(): LazyMounter {
  const callbacks = new Map<Element, () => void>();
  let io: IntersectionObserver | null = null;
  const ensure = (el: Element): IntersectionObserver | null => {
    if (io != null) return io;
    if (typeof IntersectionObserver !== 'function') return null;
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const cb = callbacks.get(e.target);
          callbacks.delete(e.target);
          io?.unobserve(e.target);
          cb?.();
        }
      },
      // Every block shares the one pane, so the first element observed names it.
      { root: scrollParentOf(el), rootMargin: NEAR_MARGIN },
    );
    return io;
  };
  return {
    observe(el, onNear) {
      const obs = ensure(el);
      if (obs == null) {
        // No IntersectionObserver: mount at once, as before.
        onNear();
        return () => undefined;
      }
      callbacks.set(el, onNear);
      obs.observe(el);
      return () => {
        callbacks.delete(el);
        obs.unobserve(el);
      };
    },
    disconnect() {
      io?.disconnect();
      io = null;
      callbacks.clear();
    },
  };
}

export const LazyMountContext = createContext<LazyMounter | null>(null);

/**
 * Whether a lazily-mounted stretch is LIVE, and the ref for its placeholder. `force` mounts it now,
 * whatever its position (a reveal's target, the just-posted thread): a jump must find its rows.
 * With no mounter in context everything is live.
 */
export function useMountWhenNear<T extends Element>(
  force: boolean,
): { live: boolean; ref: RefObject<T> } {
  const mounter = useContext(LazyMountContext);
  const [seen, setSeen] = useState(mounter == null);
  const ref = useRef<T>(null);
  const live = seen || force;
  // A forced mount latches too, so the stretch stays when the reveal moves elsewhere.
  useEffect(() => {
    if (force && !seen) setSeen(true);
  }, [force, seen]);
  useEffect(() => {
    if (live || mounter == null || ref.current == null) return;
    return mounter.observe(ref.current, () => setSeen(true));
  }, [live, mounter]);
  return { live, ref };
}
