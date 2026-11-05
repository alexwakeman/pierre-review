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

/** What to watch for one bar: the bar and the panel that holds it. A docked panel's footer moves
 *  when its PANEL is resized (the Open PRs panel re-fills to the pane's bottom on scroll, a frame
 *  later and in its own commit), and the bar's own size never changes then. */
function watched(el: HTMLElement): HTMLElement[] {
  return el.parentElement != null ? [el, el.parentElement] : [el];
}

function measure(): number {
  if (obstacles.size === 0) return 0;
  const rects = [...obstacles].map((el) => el.getBoundingClientRect());
  return toastLift(rects, window.innerWidth, window.innerHeight);
}

/**
 * A read on the next frame AND once more on the frame after (coalesced: a burst of events between
 * frames is one pair). The second read sees what the first frame's own work committed — a panel that
 * re-sized itself in its rAF after the same scroll.
 */
export function settlingReads(
  read: () => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): { schedule: () => void; cancel: () => void } {
  let frame = 0;
  let settle = 0;
  const schedule = (): void => {
    if (frame !== 0) return;
    if (settle !== 0) {
      caf(settle);
      settle = 0;
    }
    frame = raf(() => {
      frame = 0;
      read();
      settle = raf(() => {
        settle = 0;
        read();
      });
    });
  };
  const cancel = (): void => {
    if (frame !== 0) caf(frame);
    if (settle !== 0) caf(settle);
    frame = 0;
    settle = 0;
  };
  return { schedule, cancel };
}

/** The px the cluster must rise above its resting place (0 when nothing is in its corner). */
export function useToastLift(): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    // ⚠ MEASURE AFTER LAYOUT SETTLES. A scroll moves a docked panel, and the panel then resizes in
    // a later frame (its own rAF sets React state, which commits after this one's read). A single
    // read on the scroll took the bar's in-between position and kept it — the cluster sat ~40px too
    // high until the next event. So: read on the next frame AND once more on the frame after, and
    // watch the bar's panel as well as the bar, so its resize re-reads too.
    const { schedule, cancel } = settlingReads(() => setLift(measure()));
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const observed = new Map<HTMLElement, HTMLElement[]>();
    const sync = (): void => {
      for (const el of obstacles) {
        if (observed.has(el)) continue;
        const targets = watched(el);
        observed.set(el, targets);
        for (const t of targets) ro?.observe(t);
      }
      for (const [el, targets] of observed) {
        if (obstacles.has(el)) continue;
        observed.delete(el);
        for (const t of targets) ro?.unobserve(t);
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
      cancel();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('animationend', schedule, true);
    };
  }, []);
  return lift;
}
