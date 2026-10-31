import { useLayoutEffect, type ReactNode } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift } from '@floating-ui/react';
import { usePlacedFloating } from '../ui/floating.js';

// A CHART'S HOVER BOX, FLOATED. The box points at the mark under the pointer (an SVG <rect> or any
// element) and is portalled to <body>, placed `fixed`: a chart inside a sideways scroller, or a card
// with `overflow` set, can no longer clip it, and it never widens or scrolls the box around it. It
// flips below the mark when there is no room above and shifts to stay on screen.
//
// Hover only and decorative (`pointer-events: none`): every figure in it is also in the chart's
// screen-reader table. A box the reader must CLICK INTO is a popover, not this.

export function AnchoredTip({
  anchor,
  children,
  testId,
}: {
  /** The element the box points at; null renders nothing. */
  anchor: Element | null;
  children: ReactNode;
  testId?: string;
}): JSX.Element | null {
  const open = anchor != null;
  const { refs, floatingStyles } = usePlacedFloating({
    open,
    strategy: 'fixed',
    placement: 'top',
    middleware: [offset(6), flip({ fallbackPlacements: ['bottom'], padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  useLayoutEffect(() => {
    refs.setReference(anchor);
  }, [anchor, refs]);
  if (!open) return null;
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        role="tooltip"
        data-testid={testId}
        className="pointer-events-none z-[70] max-w-[min(320px,92vw)] rounded-ui bg-ui-raise px-2 py-1 text-meta leading-snug text-ui-ink shadow-lg ring-1 ring-ui-line"
      >
        {children}
      </div>
    </FloatingPortal>
  );
}
