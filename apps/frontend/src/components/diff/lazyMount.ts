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

// ⚠ THE PANE CAN CHANGE UNDER US. The observer's root is the scroll pane of the first block it sees,
// but that pane can be replaced while the diff lives on (a resize across a layout breakpoint, the PR
// moving between the drawer and its tab, a hot reload). An observer rooted on a detached pane never
// fires again and the code stays blank. So each observe re-checks the pane and rebuilds the observer
// when it moved, and a WATCHDOG (scroll anywhere, resize, and a slow interval) mounts any pending block
// that is on or near the screen by its own measured position, whatever the observer thinks.

/** How far beyond the window the watchdog mounts, in window heights (matches NEAR_MARGIN). */
const WATCHDOG_REACH = 1.5;
const WATCHDOG_INTERVAL_MS = 1000;

export function createLazyMounter(): LazyMounter {
  const callbacks = new Map<Element, () => void>();
  let io: IntersectionObserver | null = null;
  let root: HTMLElement | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const fire = (el: Element): void => {
    const cb = callbacks.get(el);
    callbacks.delete(el);
    io?.unobserve(el);
    cb?.();
    if (callbacks.size === 0) stopWatchdog();
  };
  const build = (paneRoot: HTMLElement | null): IntersectionObserver | null => {
    io?.disconnect();
    io = null;
    root = paneRoot;
    if (typeof IntersectionObserver !== 'function') return null;
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) fire(e.target);
      },
      { root: paneRoot, rootMargin: NEAR_MARGIN },
    );
    for (const el of callbacks.keys()) io.observe(el);
    return io;
  };
  const ensure = (el: Element): IntersectionObserver | null => {
    const pane = scrollParentOf(el);
    const stale = root != null && (!root.isConnected || (pane != null && pane !== root));
    if (io == null || stale) return build(pane);
    return io;
  };
  // Mount every pending block that is on or near the screen, measured directly.
  const sweep = (): void => {
    frame = 0;
    if (typeof window === 'undefined') return;
    const reach = window.innerHeight * WATCHDOG_REACH;
    for (const el of [...callbacks.keys()]) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // display:none (Threads only): not now
      if (r.bottom >= -reach && r.top <= window.innerHeight + reach) fire(el);
    }
  };
  const schedule = (): void => {
    if (frame === 0 && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(sweep);
  };
  const startWatchdog = (): void => {
    if (timer != null || typeof window === 'undefined') return;
    // Scroll events do not bubble, so listen in the capture phase to hear every pane.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    timer = setInterval(schedule, WATCHDOG_INTERVAL_MS);
  };
  function stopWatchdog(): void {
    if (timer == null) return;
    document.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    clearInterval(timer);
    timer = null;
    if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
  }

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
      startWatchdog();
      schedule();
      return () => {
        callbacks.delete(el);
        io?.unobserve(el);
        if (callbacks.size === 0) stopWatchdog();
      };
    },
    disconnect() {
      io?.disconnect();
      io = null;
      root = null;
      callbacks.clear();
      stopWatchdog();
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
