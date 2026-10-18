import { useLayoutEffect, useRef } from 'react';

// REMEMBER WHERE THE READER WAS. Activity's content pane is ONE scroll box shared by every rail entry,
// and the boards unmount when another tab or rail shows — so coming back (Back, or re-opening
// Activity) used to land at the top, or at whatever the last screen left. This keeps one position
// per KEY for the session (module memory: not persisted, not in the URL) and puts it back on mount.
//
// The content often arrives AFTER mount (a board drawn from a query), so the restore waits, watching
// the box's size, until the box is tall enough to hold the position — and gives up the moment the
// reader scrolls, or after RESTORE_WINDOW_MS, so it never fights them.

const positions = new Map<string, number>();
const RESTORE_WINDOW_MS = 4000;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n != null; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === 'auto' || oy === 'scroll') return n;
  }
  return null;
}

/** Attach the returned ref to an element INSIDE the scroll box; `key` names the screen. */
export function useRememberedScroll<T extends HTMLElement>(key: string): React.RefObject<T> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const box = scrollParent(ref.current);
    if (box == null) return;
    const target = positions.get(key) ?? 0;
    let restoring = true;
    let expected: number | null = null;
    const apply = (): void => {
      if (!restoring) return;
      const max = box.scrollHeight - box.clientHeight;
      expected = Math.min(target, Math.max(0, max));
      box.scrollTop = expected;
      if (max >= target) restoring = false;
    };
    apply();
    const ro = new ResizeObserver(apply);
    for (const child of Array.from(box.children)) ro.observe(child);
    ro.observe(box);
    const stop = window.setTimeout(() => {
      restoring = false;
      ro.disconnect();
    }, RESTORE_WINDOW_MS);
    const onScroll = (): void => {
      // Our own write lands where we put it; anything else is the reader (a scrollbar drag too).
      if (expected == null || Math.abs(box.scrollTop - expected) > 2) restoring = false;
      positions.set(key, box.scrollTop);
    };
    // A wheel / touch / key is the reader, even if it lands on the same frame as a restore.
    const onUser = (): void => {
      restoring = false;
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    box.addEventListener('wheel', onUser, { passive: true });
    box.addEventListener('touchstart', onUser, { passive: true });
    box.addEventListener('keydown', onUser);
    return () => {
      window.clearTimeout(stop);
      ro.disconnect();
      box.removeEventListener('scroll', onScroll);
      box.removeEventListener('wheel', onUser);
      box.removeEventListener('touchstart', onUser);
      box.removeEventListener('keydown', onUser);
    };
  }, [key]);
  return ref;
}
