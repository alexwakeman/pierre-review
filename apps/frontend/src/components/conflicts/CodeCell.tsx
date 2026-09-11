import { memo } from 'react';
import type { SlotRole } from '../../lib/mergeResolver.js';
import { WASH_CLASS } from './copy.js';

// ── ONE PANE'S CELL FOR ONE REGION ───────────────────────────────────────────────────────────
//
// ⚠ CODE WRAPS; IT DOES NOT SCROLL SIDEWAYS. `overflow-x: auto` on a column forces `overflow-y:
// auto` on the same element, which gives each of the three panes its own vertical scrollbar and
// puts the resolver straight back into three-scroller synchronisation — the thing the single-grid
// layout exists to avoid. So: `whitespace-pre-wrap [overflow-wrap:anywhere]`.
//
// The cost is worth naming: with wrapping on, individual LINES inside a tall region may not sit
// on the same visual row across the three panes. The alignment grain is the REGION, which is the
// grain the reader acts on and the only one the merge engine actually asserted — pairing
// individual lines inside a contested region would be a correspondence claim nobody made.
//
// ⚠ THE WASH SIZES ITSELF TO THE CONTENT, THE CELL FILLS THE ROW. The grid stretches every cell
// to the tallest in its row; the leftover under a short side gets `.mr-filler`'s hatch, which is
// the only thing distinguishing "this side has nothing here" from "this side's lines are blank".

export type CellRow =
  /** `n` is that SIDE's own file line number. The CENTRE pane passes null: the result has
   *  no line numbers yet, and printing an index as one would be a claim about a file that does
   *  not exist. */
  | { kind: 'line'; n: number | null; text: string; html: string | null }
  /** The collapsed middle of a folded unchanged region. Fixed height in all three panes so the
   *  fold does not itself knock the columns out of alignment. */
  | { kind: 'gap' };

export const CodeCell = memo(function CodeCell({
  rows,
  role,
  rule,
  ariaHidden,
}: {
  rows: CellRow[];
  role: SlotRole;
  /** The centre cell wears a 2px left rule in the role's ink — encoding two of three. */
  rule?: string | null;
  /** Set on the left/right cells of a region whose content the strip already announces, so the
   *  same lines are not read out three times. */
  ariaHidden?: boolean;
}): JSX.Element {
  const wash = role == null ? '' : WASH_CLASS[role];
  return (
    <div className="mr-filler min-w-0" aria-hidden={ariaHidden === true ? true : undefined}>
      <div
        className={`min-w-0 font-mono text-[12px] leading-[18px] text-gray-900 dark:text-gray-100 ${wash} ${
          rule != null ? `border-l-2 ${rule}` : ''
        }`}
      >
        {rows.map((row, i) =>
          row.kind === 'gap' ? (
            <div key={`gap-${i}`} className="mr-filler h-[18px]" />
          ) : (
            <div key={`${row.n ?? 'r'}-${i}`} className="flex">
              <span className="w-9 shrink-0 select-none pr-2 text-right tabular-nums text-gray-500 dark:text-gray-400">
                {row.n ?? ''}
              </span>
              {row.html != null ? (
                // ⚠ ONLY highlight.js OUTPUT REACHES HERE. `highlightLines` escapes through
                // hljs's own emitter and returns null on every gate it cannot clear; the plain
                // branch below is React's normal text rendering.
                <span
                  className="mr-code min-h-[18px] min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
                  dangerouslySetInnerHTML={{ __html: row.html }}
                />
              ) : (
                <span className="min-h-[18px] min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {row.text}
                </span>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
});
