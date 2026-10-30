import { forwardRef, useLayoutEffect, type HTMLAttributes, type RefObject } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { useAnchoredFloat } from './floating.js';

// A HAND-ROLLED DROPDOWN PANEL, FLOATED (docs/redesign/DESIGN.md § 7). For the panels that are not a
// `Menu` or `Select` (a filter panel with checkboxes, a sort menu with radio items): render the panel
// through this instead of `absolute top-full`. It is portalled to <body> and placed `fixed` against
// `anchorRef` — it never widens or scrolls the box around it, flips and shifts to stay on screen,
// and caps its width/height to the room it has. It carries `data-floating-layer`, so the owner's
// `useClickOutside` still counts a press inside it as inside.
//
// Give it a z-index in `className` (the panels use z-[60]+; a Menu/Select list is z-[90]).

export const FloatingLayer = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    anchorRef: RefObject<HTMLElement | null>;
    side?: 'bottom' | 'top';
    align?: 'start' | 'end';
    maxHeight?: number;
  }
>(function FloatingLayer({ anchorRef, side = 'bottom', align = 'start', maxHeight = 560, style, ...rest }, ref) {
  const float = useAnchoredFloat({ open: true, side, align, maxHeight });
  const { setReference } = float.refs;
  useLayoutEffect(() => {
    setReference(anchorRef.current);
  }, [anchorRef, setReference]);
  return (
    <FloatingPortal>
      <div
        {...rest}
        data-floating-layer=""
        ref={(el) => {
          float.refs.setFloating(el);
          if (typeof ref === 'function') ref(el);
          else if (ref != null) ref.current = el;
        }}
        style={{ ...float.floatingStyles, ...style }}
      />
    </FloatingPortal>
  );
});
