import { useEffect, useState } from 'react';
import { coveredInRow, pageScroller } from './trayBoard.js';
import { ChevronIcon } from '../Icons.js';
import { cx, FOCUS_RING } from '../ui/cx.js';

// "+2 under the panel": the open card's row has cards the story tray covers. A small marker on the
// row's visible edge (just left of the tray, in the gap above the open card's row); a click shows the
// nearest covered card's story, which scrolls it out from under the tray. Wide screens only (the
// caller mounts it while the tray lies on top of the board). Re-measured on every scroll and resize.

export function TrayRowMarker({
  board,
  ident,
  trayPx,
  onPick,
}: {
  board: HTMLElement | null;
  ident: string;
  trayPx: number;
  onPick: (ident: string) => void;
}): JSX.Element | null {
  const [at, setAt] = useState<{ idents: string[]; top: number; right: number } | null>(null);

  useEffect(() => {
    if (board == null) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const row = coveredInRow(board, ident, trayPx);
      const page = pageScroller(board)?.getBoundingClientRect();
      // Shown only while the row's top is on screen (below the overlay's sticky header).
      if (row == null || row.idents.length === 0 || page == null || row.rowTop < page.top + 40 || row.rowTop > page.bottom - 8) {
        setAt((prev) => (prev == null ? prev : null));
        return;
      }
      const next = { idents: row.idents, top: Math.round(row.rowTop), right: Math.round(window.innerWidth - row.edge + 4) };
      setAt((prev) =>
        prev != null && prev.top === next.top && prev.right === next.right && prev.idents.join() === next.idents.join() ? prev : next,
      );
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(board);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
    };
  }, [board, ident, trayPx]);

  if (at == null) return null;
  const n = at.idents.length;
  const first = at.idents[0]!;
  return (
    <button
      type="button"
      data-testid="tray-row-marker"
      data-noactivate
      onClick={() => onPick(first)}
      aria-label={`${n} more ${n === 1 ? 'ticket' : 'tickets'} in this row under the story panel; show the next one`}
      style={{ top: at.top, right: at.right }}
      // Its bottom sits on the open card's top edge, in the row gap above it.
      className={cx(
        'fixed z-30 inline-flex h-4 -translate-y-full items-center gap-0.5 rounded-ui bg-ui-raise px-1.5 text-meta leading-none text-ui-ink shadow-sm hover:bg-ui-hover',
        FOCUS_RING,
      )}
    >
      +{n} under the panel
      <ChevronIcon dir="right" size={9} />
    </button>
  );
}
