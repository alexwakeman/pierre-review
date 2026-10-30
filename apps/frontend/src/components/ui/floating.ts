import { autoUpdate, flip, offset, shift, size, useFloating, type Placement } from '@floating-ui/react';

// ONE PLACEMENT FOR EVERY DESKTOP MENU AND LIST (docs/redesign/DESIGN.md § 7). A menu, a select's
// list or a popover FLOATS: it is portalled to <body> and positioned `fixed` against its trigger, so
// it never takes room in the page, never widens a scroll box (a long option used to push the whole
// pane sideways) and is never clipped by an `overflow` ancestor. It flips to the other side when
// there is no room, shifts to stay inside the viewport, and caps its own width and height to the
// space it has. On a phone the callers render a bottom sheet instead and do not use this.

const GAP = 4;
const EDGE = 8;

export function useAnchoredFloat({
  open,
  side = 'bottom',
  align = 'start',
  maxHeight,
  matchWidth = false,
}: {
  open: boolean;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
  /** The list's own ceiling in px; the space below/above the trigger may cap it further. */
  maxHeight: number;
  /** At least as wide as the trigger (a select's list). */
  matchWidth?: boolean;
}) {
  const placement: Placement = `${side}-${align}`;
  return useFloating({
    open,
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(GAP),
      flip({ padding: EDGE }),
      shift({ padding: EDGE }),
      size({
        padding: EDGE,
        apply({ availableWidth, availableHeight, rects, elements }) {
          const s = elements.floating.style;
          s.maxWidth = `${Math.max(160, Math.min(availableWidth, 480))}px`;
          s.maxHeight = `${Math.max(120, Math.min(availableHeight, maxHeight))}px`;
          if (matchWidth) s.minWidth = `${rects.reference.width}px`;
        },
      }),
    ],
  });
}
