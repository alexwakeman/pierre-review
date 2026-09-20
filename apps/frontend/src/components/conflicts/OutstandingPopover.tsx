import { useCallback, useEffect, useRef } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { OutstandingFile } from '../../lib/conflictCommit.js';
import { CaretIcon } from '../Icons.js';
import {
  ALL_DECIDED,
  OUTSTANDING_TITLE,
  decisionsDecided,
  jumpToFileLabel,
  toDecide,
} from './copy.js';
import { useResolverPopoverEscape } from './popoverLayer.js';

// ── WHAT IS LEFT TO DECIDE ───────────────────────────────────────────────────────────────────
//
// The toolbar's countdown, and behind it the per-file list that says which files the count is in.
//
// ⚠ THIS IS THE RELOCATED HALF OF THE LANDING STEP, NOT A SECOND COPY OF IT. "Still to decide"
// used to be rendered only on the landing step, and the toolbar's button was left enabled for the
// single reason that pressing it was the only route to that list. The button is now shut by the
// same fold as the commit itself, so the list moved to where the reader is: one press off the
// counter, beside the panes it sends them back into. The landing step still renders its own copy —
// it also names what the commit will NOT carry, which nothing here claims to.
//
// ⚠ THE ROWS ARE `<button>`s AND THE SENTENCE IS `commitBlockedReason`'s. Every row navigates, so
// it needs the keyboard; and the sentence above them is the one the disabled button wears, because
// a popover that explained the block in its own words would be the second spelling this feature
// keeps folding away.
//
// ⚠ ITS OWN `Escape` CLOSES IT AND STOPS THERE — through `useResolverPopoverEscape`, the
// `BasePopover` rule. A local `window` capture listener did NOT achieve that, whatever the
// comment here used to claim: the overlay's handler is registered on MOUNT, same-target
// same-phase listeners fire in registration order, so its `stopImmediatePropagation` ran first
// and this one never did — the key closed the whole resolver, and with `decidedCount === 0` there
// was not even a reopen toast. The shared hook also counts itself, which is what tells the shell
// to stand aside.
//
// ⚠ AND OPENING IT MOVES FOCUS INTO IT. `FloatingPortal` appends to `document.body`, AFTER the
// whole `#root` subtree, and nothing here renders floating-ui's tab-order guards — so tabbing
// from the trigger walked every "Show N unchanged lines" fold in the visible file before reaching
// the first row. These rows are the ONE keyboard route to the outstanding files now that the
// button beside them is disabled.

export function OutstandingPopover({
  decided,
  total,
  outstanding,
  blockedReason,
  open,
  onOpenChange,
  onJumpToFile,
}: {
  /** The countdown, off the shell's ONE `CommitPlan`. Never re-folded here. */
  decided: number;
  total: number;
  /** Every supported file with an unanswered region, in manifest order. */
  outstanding: readonly OutstandingFile[];
  /** `commitBlockedReason(plan, headMoved)` — null when nothing is in the commit's way. */
  blockedReason: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Go to that file's first unanswered region, and close. */
  onJumpToFile: (index: number) => void;
}): JSX.Element {
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    strategy: 'fixed',
    placement: 'bottom-end',
    middleware: [offset(4), flip({ fallbackPlacements: ['top-end'] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeSelf = useCallback(() => onOpenChange(false), [onOpenChange]);

  useResolverPopoverEscape(open, closeSelf);

  // In on open, back to the trigger on close — the motion `FileMenu` already makes. The first row
  // when there is one (that is what the reader pressed the counter to reach); the dialog itself
  // when everything is decided and the panel is one sentence.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('button') ?? panel)?.focus();
    return () => {
      if (triggerRef.current?.isConnected === true) triggerRef.current.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={(el) => {
          refs.setReference(el);
          triggerRef.current = el;
        }}
        {...getReferenceProps()}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={OUTSTANDING_TITLE}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {decisionsDecided(decided, total)}
        <CaretIcon size={11} className="shrink-0 text-gray-500 dark:text-gray-400" />
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={(el) => {
              refs.setFloating(el);
              panelRef.current = el;
            }}
            style={floatingStyles}
            {...getFloatingProps()}
            role="dialog"
            aria-label={OUTSTANDING_TITLE}
            // `-1`: the panel takes focus itself when it has no rows to hand it to, and must not
            // become a tab stop of its own once the reader is past it.
            tabIndex={-1}
            className="z-[70] w-[26rem] max-w-[92vw] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg outline-none dark:border-gray-800 dark:bg-gray-900"
          >
            <p className="border-b border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-800 dark:border-gray-800 dark:text-gray-100">
              {blockedReason ?? ALL_DECIDED}
            </p>
            {outstanding.length > 0 && (
              <ul className="max-h-[50vh] overflow-y-auto py-1">
                {outstanding.map((row) => (
                  <li key={row.index}>
                    <button
                      type="button"
                      onClick={() => {
                        onJumpToFile(row.index);
                        onOpenChange(false);
                      }}
                      // ⚠ IT REPEATS BOTH VISIBLE SPANS, exactly as the landing step's row does.
                      // An `aria-label` replaces the whole subtree, so a name of "Go to <path>"
                      // alone drops the per-file remainder out of the accessible name — and that
                      // remainder is nowhere else on this screen.
                      aria-label={jumpToFileLabel(row.path, row.remaining)}
                      className="flex w-full flex-wrap items-baseline gap-x-2 px-2.5 py-1 text-left text-[12px] hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      <span className="min-w-0 font-mono text-gray-800 dark:text-gray-100">
                        {row.path}
                      </span>
                      <span className="text-gray-600 dark:text-gray-300">
                        {toDecide(row.remaining)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
