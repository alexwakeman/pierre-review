import { useEffect, useState } from 'react';

// A STICKY BOX THAT FILLS TO ITS PANE'S BOTTOM (the Open PRs docked detail panel). A fixed
// `calc(100dvh - Nrem)` is wrong twice: the box starts lower than N before the page scrolls (its
// footer fell below the window), and N changes with the header's wrapping. So measure: the box's
// height is the room from where it sits now (its own top, or the pane's top once it sticks) to the
// scroll pane's bottom, less `gap`. Re-read on scroll and resize, once per frame.

function scrollPaneOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node != null; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === 'auto' || oy === 'scroll') return node;
  }
  return null;
}

/** The height for `el` (null until measured, or when off). */
export function useFillToPaneBottom(el: HTMLElement | null, on: boolean, gap = 16): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!on || el == null) {
      setHeight(null);
      return;
    }
    const pane = scrollPaneOf(el);
    let raf = 0;
    const read = (): void => {
      raf = 0;
      const paneRect = pane?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const top = Math.max(el.getBoundingClientRect().top, paneRect.top);
      const bottom = Math.min(paneRect.bottom, window.innerHeight);
      const h = Math.max(240, Math.floor(bottom - top - gap));
      setHeight((prev) => (prev === h ? prev : h));
    };
    const schedule = (): void => {
      if (raf === 0) raf = requestAnimationFrame(read);
    };
    read();
    const target: HTMLElement | Window = pane ?? window;
    target.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (pane != null) ro?.observe(pane);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      target.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [el, on, gap]);
  return height;
}
