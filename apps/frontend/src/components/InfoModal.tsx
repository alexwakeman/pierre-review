import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import { claimActivePopover, closeActivePopover } from '../lib/activePopover.js';
import { CloseIcon, InfoIcon } from './Icons.js';

// A PANEL'S EXPLANATION, BEHIND AN "i". The page keeps figures, charts and the one-line disclosures;
// how a panel is read — what it counts, which rule decides a verdict, what it leaves out — moves in
// here. The "i" (`InfoButton`, below) opens a POPOVER anchored to it, never a modal; `InfoModal` is
// kept for content that is not an "i" explanation (the Open PRs ticket story).
//
// ⚠ InfoModal IS A REAL DIALOG. Focus is trapped inside while it is open (Tab cycles between the close button
// and the body, and nothing else on the page), and closing hands focus back to the button that
// opened it.
//
// ⚠ THE BODY TAKES FOCUS, AND OPENS WITH IT. It is the only thing that scrolls, and the arrow keys,
// Page Down and End scroll only the element that has focus — so a dialog focused anywhere else
// leaves a keyboard reader unable to reach anything below the fold.
//
// ⚠ ESCAPE IS CAPTURED. The global keyboard hook turns Escape into "leave this overlay for the
// Timeline"; a capture-phase listener that stops the event is the house pattern (HelpModal) for
// letting a modal close without taking the reader somewhere else as well.

const WIDTH: Record<'md' | 'lg', string> = {
  md: 'w-[34rem]',
  lg: 'w-[44rem]',
};

export interface InfoModalProps {
  /** The dialog's heading; also its accessible name (aria-labelledby). */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 'md' = w-[34rem] (default), 'lg' = w-[44rem]; both max-w-[94vw]. */
  width?: 'md' | 'lg';
}

export function InfoModal({ title, onClose, children, width = 'md' }: InfoModalProps): JSX.Element {
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { refs, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  // A board popover opened from the keyboard would otherwise stay open over this dialog, and take
  // its first Escape (lib/activePopover.ts).
  useEffect(() => {
    closeActivePopover();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <FloatingPortal>
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
        role="presentation"
        onClick={(e) => {
          // The backdrop only: a click that started on the dialog and bubbled here is not one.
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <FloatingFocusManager context={context} modal initialFocus={bodyRef} returnFocus>
          <div
            ref={refs.setFloating}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={`flex max-h-[85vh] max-w-[94vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl focus:outline-none dark:border-gray-700 dark:bg-gray-900 ${WIDTH[width]}`}
          >
            <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3 dark:border-gray-800">
              <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-gray-50">
                {title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close (Esc)"
                className="rounded p-0.5 text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-gray-400 dark:hover:text-gray-100"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div
              ref={bodyRef}
              tabIndex={0}
              className="min-h-0 flex-1 space-y-3 overflow-auto rounded-b-lg px-5 py-4 text-sm leading-relaxed text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 dark:text-gray-200"
            >
              {children}
            </div>
          </div>
        </FloatingFocusManager>
      </div>
    </FloatingPortal>
  );
}

export interface InfoButtonProps {
  /** The popover's heading. The button's accessible name is `About “${title}”`. */
  title: string;
  /** The popover body, rendered only while open. */
  children: ReactNode;
  /** 'md' = 22rem (default), 'lg' = 26rem; both capped at 92vw. */
  width?: 'md' | 'lg';
  /** Colour override for the icon (the AI surface passes 'text-ai-ink'). */
  className?: string;
}

const POPOVER_WIDTH: Record<'md' | 'lg', string> = {
  md: 'w-[22rem]',
  lg: 'w-[26rem]',
};

/**
 * The "i" beside a panel's title, and the POPOVER it opens — anchored to the button, never a modal.
 *
 * ⚠ A CLICK, NEVER A HOVER (touch and keyboard must reach it). Escape (captured, so the global
 * keyboard hook does not also leave the overlay), an outside press, Tab moving focus out, or the
 * button again closes it; focus returns to the button.
 *
 * ⚠ THE BODY TAKES FOCUS ON OPEN. It is the part that scrolls, and the arrow keys and Page Down
 * scroll only the focused element — a long explanation must stay readable from the keyboard.
 *
 * ⚠ ONE OPEN POPOVER AT A TIME, shared with the Pending "i"s and the chart popovers
 * (lib/activePopover.ts), and a modal opening over the page closes it.
 *
 * ⚠ `data-noactivate` + stopPropagation ON THE PANEL. It renders through a portal and React bubbles
 * portal events through the COMPONENT tree, so a click on its text would otherwise reach a card's
 * or a collapsible header's own onClick.
 */
export function InfoButton({ title, children, width = 'md', className }: InfoButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['bottom-end', 'top-start', 'top-end'] }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(160, Math.min(availableHeight, 448))}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context, { escapeKey: false });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    if (!open) return;
    return claimActivePopover(() => setOpen(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const colour =
    className ??
    (open
      ? 'text-gray-800 dark:text-gray-100'
      : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100');
  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`About “${title}”`}
        className={`inline-flex shrink-0 items-center justify-center rounded-full p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${colour}`}
      >
        <InfoIcon size={13} />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={bodyRef} returnFocus>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps({ onClick: (e) => e.stopPropagation() })}
              role="dialog"
              aria-labelledby={titleId}
              data-noactivate
              className={`z-[60] flex ${POPOVER_WIDTH[width]} max-w-[92vw] cursor-default flex-col rounded-lg border border-gray-200 bg-white text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200`}
            >
              <p
                id={titleId}
                className="px-3 pt-2.5 text-[12px] font-semibold text-gray-900 dark:text-gray-50"
              >
                {title}
              </p>
              <div
                ref={bodyRef}
                tabIndex={0}
                className="min-h-0 flex-1 space-y-2 overflow-auto rounded-b-lg px-3 pb-3 pt-1 text-[12px] leading-relaxed focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
              >
                {children}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
