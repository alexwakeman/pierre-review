import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { FloatingFocusManager, FloatingPortal, useFloating } from '@floating-ui/react';
import { closeActivePopover } from '../lib/activePopover.js';
import { CloseIcon, InfoIcon } from './Icons.js';

// A PANEL'S EXPLANATION, BEHIND AN "i". The page keeps figures, charts and the one-line disclosures;
// how a panel is read — what it counts, which rule decides a verdict, what it leaves out — moves in
// here, in larger type than the page could ever afford it.
//
// ⚠ A REAL DIALOG. Focus is trapped inside while it is open (Tab cycles between the close button
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
  /** The modal's title. The button's accessible name is `About “${title}”`. */
  title: string;
  /** The modal body, rendered only while open. */
  children: ReactNode;
  width?: 'md' | 'lg';
  /** Colour override for the icon (the AI surface passes 'text-ai-ink'). */
  className?: string;
}

/** The "i" beside a panel's title, and the modal it opens. */
export function InfoButton({ title, children, width, className }: InfoButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // Stable, so the modal's Escape listener is registered once per opening rather than per render.
  const close = useCallback(() => setOpen(false), []);
  const colour =
    className ?? 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`About “${title}”`}
        className={`inline-flex shrink-0 items-center justify-center rounded-full p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${colour}`}
      >
        <InfoIcon size={13} />
      </button>
      {open && (
        <InfoModal title={title} width={width} onClose={close}>
          {children}
        </InfoModal>
      )}
    </>
  );
}
