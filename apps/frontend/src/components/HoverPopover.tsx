// A HOVER-ONLY POPOVER, ANCHORED (docs/FRONTEND.md § Activity → This Sprint). It opens while the pointer
// is over its trigger (or the trigger has keyboard focus) and closes when the pointer leaves or focus
// moves on — no click, no pin. It sits beside its trigger and never follows the mouse.
//
//   POINTER   the panel is `pointer-events-none`: the pointer cannot rest on it, so it cannot hold
//             itself open over the cards beneath.
//   PLACEMENT `avoidRects` (lib/avoidRects.ts) tries right, left, below and above the trigger and keeps the side that
//             covers the least of the given boxes (the board's cards), inside the viewport. Where every
//             side covers something, the least covered wins.
//
// The lane board's arrow numbers (components/LaneBoard.tsx `ArrowMarker`) use the same placement.
import { useId, useState, type ReactNode } from 'react';
import {
  autoUpdate,
  FloatingPortal,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { avoidRects } from '../lib/avoidRects.js';

const NO_OBSTACLES = (): DOMRect[] => [];

export const HOVER_PANEL_CLASS =
  'pointer-events-none z-[60] max-w-[min(20rem,90vw)] rounded-ui border border-gray-200 bg-white px-2.5 py-2 text-meta leading-snug text-gray-800 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

/**
 * The trigger (`children`, wrapped in a focusable span) and its panel (`content`). `label` is the
 * trigger's accessible name; the panel is its description while shown.
 */
export function HoverPopover({
  label,
  content,
  children,
  obstacles = NO_OBSTACLES,
  className,
  testId,
}: {
  label: string;
  content: ReactNode;
  children: ReactNode;
  obstacles?: () => readonly DOMRect[];
  className?: string;
  testId?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const popId = useId();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    strategy: 'fixed',
    middleware: [avoidRects(obstacles, { order: ['bottom', 'right', 'top', 'left'] })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { delay: { open: 60, close: 60 } });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  return (
    <>
      <span
        ref={refs.setReference}
        tabIndex={0}
        data-testid={testId}
        // A generic span cannot carry a name; role="img" can, so the focus stop is announced.
        role="img"
        aria-label={label}
        aria-describedby={open ? popId : undefined}
        {...getReferenceProps()}
        className={`rounded-ui focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${className ?? ''}`}
      >
        {children}
      </span>
      {open && (
        <FloatingPortal>
          <div ref={refs.setFloating} id={popId} style={floatingStyles} {...getFloatingProps()} className={HOVER_PANEL_CLASS}>
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
