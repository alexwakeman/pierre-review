import { useCallback } from 'react';
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
import type { ConflictRegion } from '@pierre-review/shared';
import { highlightLines } from '../../lib/hljsLines.js';
import { CompareBaseIcon } from '../Icons.js';
import { COMPARE_BASE, COMPARE_BASE_EMPTY, COMPARE_BASE_HEADER } from './copy.js';
import { useResolverPopoverEscape } from './popoverLayer.js';

// ── COMPARE WITH THE MERGE BASE ──────────────────────────────────────────────────────────────
//
// ⚠ IT IS A POPUP AND IT IS NEVER A FOURTH COLUMN. The ancestor is what the two panes are both
// changes TO — it belongs in the reader's hand for a moment, not permanently on screen taking a
// quarter of the width from the three things they are actually choosing between. A fourth pane
// also breaks the "one grid, five tracks" alignment guarantee for a column nobody decides in.
//
// ⚠ ITS OWN `Escape` CLOSES IT AND STOPS THERE — through `useResolverPopoverEscape`, NOT through
// a local listener. A local one did not work: the overlay's handler is registered on MOUNT and
// same-target, same-phase listeners fire in registration order, so the shell's
// `stopImmediatePropagation` ran first and this popover's never did. The shared hook also counts
// itself, which is what tells the shell to stand aside.

export function BasePopover({
  region,
  language,
  open,
  onOpenChange,
}: {
  /** The CURRENT region, or null when nothing is selected. */
  region: ConflictRegion | null;
  language: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const closeSelf = useCallback(() => onOpenChange(false), [onOpenChange]);

  useResolverPopoverEscape(open, closeSelf);

  const lines = region?.base.map((l) => l.text) ?? [];
  const html = highlightLines(lines, language);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        title={COMPARE_BASE_HEADER}
        className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-600"
      >
        <CompareBaseIcon size={13} />
        {COMPARE_BASE}
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            role="dialog"
            aria-label={COMPARE_BASE_HEADER}
            className="z-[70] w-[36rem] max-w-[92vw] overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-900"
          >
            <div className="border-b border-gray-200 px-2.5 py-1.5 text-[11px] text-gray-600 dark:border-gray-800 dark:text-gray-300">
              {COMPARE_BASE_HEADER}
            </div>
            {region == null ? (
              <div className="px-2.5 py-2 text-xs text-gray-600 dark:text-gray-300">
                {COMPARE_BASE_EMPTY}
              </div>
            ) : (
              <div className="code-hl max-h-[50vh] overflow-y-auto px-2.5 py-1.5 font-mono text-[12px] leading-[18px] text-gray-900 dark:text-gray-100">
                {lines.map((text, i) => (
                  <div key={i} className="flex">
                    <span className="w-9 shrink-0 select-none pr-2 text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {region.base[i]?.n ?? ''}
                    </span>
                    {html?.[i] != null ? (
                      <span
                        className="min-h-[18px] min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
                        dangerouslySetInnerHTML={{ __html: html[i]! }}
                      />
                    ) : (
                      <span className="min-h-[18px] min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {text}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
