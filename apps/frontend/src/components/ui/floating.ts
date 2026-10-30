import { autoUpdate, flip, offset, shift, size, useFloating, type Placement, type UseFloatingOptions } from '@floating-ui/react';

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
  const float = useFloating({
    open,
    placement,
    strategy: 'fixed',
    // ⚠ PLACED BY top/left, NEVER `transform`: the entry animations (animate-ui-pop …) animate
    // `transform`, and while one runs it REPLACES floating-ui's translate — the list sat at the
    // top-left of its container until the animation ended, then jumped into place.
    transform: false,
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
  return hideUntilPlaced(float);
}

/** `useFloating`, hidden until placed — EVERY popover goes through this or `useAnchoredFloat`. */
export function usePlacedFloating(options: Partial<UseFloatingOptions>) {
  return hideUntilPlaced(useFloating({ transform: false, ...options }));
}

// ⚠ HIDDEN UNTIL PLACED. The first paint has no measurement yet, so a popover would draw at the
// top-left of its container for a frame and then jump into place. `isPositioned` turns true once the
// first computation lands (and back to false when it closes).
function hideUntilPlaced<T extends ReturnType<typeof useFloating>>(float: T): T {
  if (float.isPositioned) return float;
  return { ...float, floatingStyles: { ...float.floatingStyles, visibility: 'hidden' as const } };
}
