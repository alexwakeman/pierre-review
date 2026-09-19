import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useMergeRefs,
  useRole,
} from '@floating-ui/react';
import { claimActivePopover } from '../../lib/activePopover.js';

// A CHART'S FIGURES, ON DEMAND. The chart stays on the page; the numbers behind it open in a small
// popover pointing at the mark they describe.
//
// ⚠ EVERY INPUT REACHES IT. Hover opens it (mouse only), keyboard focus opens it, a click or a tap
// PINS it and a second one unpins; Escape or a press anywhere else closes it. A `title=` tooltip
// reaches none of touch, keyboard or a screen reader, and these figures are the only place a
// clipped bar's true value appears.
//
// ⚠ ONE OPEN AT A TIME, across every chart on the page AND the Pending board's "i" popovers
// (lib/activePopover.ts) — a pinned popover left behind while the reader hovers the next row would
// put two sets of figures on screen pointing at two bars.
//
// ⚠ FIGURES AND SERVER PROSE ONLY in `content`. The popover is a view of numbers the page already
// holds, never a sentence composed out of them.

export interface ChartPopoverProps {
  /** Accessible name of the trigger: the figures in words (also what a screen reader hears). */
  label: string;
  /** The popover body, rendered only while open. Figures and server prose only — never a
   *  sentence the client composes out of the numbers. */
  content: ReactNode;
  /** The chart the trigger wraps. Rendered INSIDE the <button>; mark any svg aria-hidden. */
  children: ReactNode;
  /** Where the popover points, in px from the trigger's left edge. Default: the trigger's centre. */
  anchorX?: number;
  testId?: string;
}

export function ChartPopover({ label, content, children, anchorX, testId }: ChartPopoverProps): JSX.Element {
  const [pinned, setPinned] = useState(false);
  const [transient, setTransient] = useState(false);
  const open = pinned || transient;

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next, _event, reason) => {
      // Hover and focus drive the TRANSIENT half only, so leaving a pinned popover's bar does not
      // close it. Everything else that closes (an outside press) closes both.
      if (reason === 'hover' || reason === 'focus' || reason === 'focus-out' || reason === 'safe-polygon') {
        setTransient(next);
        return;
      }
      if (!next) {
        setPinned(false);
        setTransient(false);
      }
    },
    strategy: 'fixed',
    placement: 'top',
    middleware: [offset(8), flip({ fallbackPlacements: ['bottom'] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { mouseOnly: true, delay: { open: 60, close: 80 } });
  const focus = useFocus(context, { visibleOnly: true });
  const dismiss = useDismiss(context, { escapeKey: false });
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const setButton = useMergeRefs([buttonRef, refs.setReference]);
  // Read at measure time, so a resize moves the arrow's target without re-registering anything.
  const anchorRef = useRef(anchorX);
  anchorRef.current = anchorX;

  // The popover points at a spot ON the chart (the end of the bar), not at the middle of the
  // whole row: a virtual reference one pixel wide at `anchorX`, as tall as the trigger.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (button == null) return;
    refs.setPositionReference({
      getBoundingClientRect() {
        const r = button.getBoundingClientRect();
        const x = r.left + (anchorRef.current ?? r.width / 2);
        return { x, y: r.top, left: x, right: x, top: r.top, bottom: r.bottom, width: 0, height: r.height };
      },
      contextElement: button,
    });
  }, [refs]);

  // One at a time: opening this one closes whichever was open, and a closed one gives up the slot.
  useEffect(() => {
    if (!open) return;
    return claimActivePopover(() => {
      setPinned(false);
      setTransient(false);
    });
  }, [open]);

  // Escape closes it, captured so the global keyboard hook does not ALSO leave for the Timeline.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setPinned(false);
      setTransient(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <>
      <button
        ref={setButton}
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-expanded={open}
        className="block w-full cursor-pointer rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        {...getReferenceProps({
          // A click pins; a second one unpins AND closes, even with the pointer still over it.
          onClick: () => {
            if (pinned) setTransient(false);
            setPinned(!pinned);
          },
        })}
      >
        {children}
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[60] w-64 max-w-[92vw] rounded-md border border-gray-200 bg-white px-3 py-2 text-xs leading-snug text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
