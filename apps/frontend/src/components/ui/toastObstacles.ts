import { useEffect, useState } from 'react';
import { toastLift } from '../../lib/toastAnchor.js';

// THE ACTION BARS THE TOAST CLUSTER MUST NOT SIT ON (components/HeaderToasts.tsx). The cluster is
// fixed at the bottom right of the main content; a SidePanel's footer (its pinned action bar —
// docked at lg+, a sheet below) can sit in that same corner. Each footer registers here while it is
// mounted, and the cluster rises above the highest one that reaches its corner (`toastLift`). The
// cluster stays ABOVE a sheet in z-order (z-[51] over the sheet's z-50), so the Undo for an action
// taken in a sheet is always reachable — and the lift keeps it off the sheet's own buttons.

const obstacles = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const notify = (): void => {
  for (const l of listeners) l();
};

/** Register a pinned bottom action bar; returns the unregister. */
export function registerToastObstacle(el: HTMLElement): () => void {
  obstacles.add(el);
  notify();
  return () => {
    obstacles.delete(el);
    notify();
  };
}

function measure(): number {
  if (obstacles.size === 0) return 0;
  const rects = [...obstacles].map((el) => el.getBoundingClientRect());
  return toastLift(rects, window.innerWidth, window.innerHeight);
}

/** The px the cluster must rise above its resting place (0 when nothing is in its corner). */
export function useToastLift(): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setLift(measure());
      });
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const observed = new Set<HTMLElement>();
    const sync = (): void => {
      for (const el of obstacles) {
        if (observed.has(el)) continue;
        observed.add(el);
        ro?.observe(el);
      }
      for (const el of observed) {
        if (obstacles.has(el)) continue;
        observed.delete(el);
        ro?.unobserve(el);
      }
      schedule();
    };
    listeners.add(sync);
    sync();
    window.addEventListener('resize', schedule);
    // A docked panel's footer moves with the page's scroll; a sheet animates in.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('animationend', schedule, true);
    return () => {
      listeners.delete(sync);
      ro?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('animationend', schedule, true);
    };
  }, []);
  return lift;
}
