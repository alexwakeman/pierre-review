import { memo } from 'react';

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
//
// ⚠ THE HATCH NOW CARRIES THAT FACT ALONE, AND NOTHING ELSE IN HERE COMPETES WITH IT. A side the
// reader turned down used to keep a 1px outline (`.mr-edge-*`) in place of its wash; that family is
// deleted, so a side with no wash is either offering nothing or was not taken, and the hatch keeps
// saying only which pane has no lines. Nothing in here has a box of its own, which is what keeps
// the three panes aligned — a real border would move the text and they would drift.
//
// ⚠ A PANE WHOSE ANSWER IS "DELETE THESE LINES" STILL HAS TO BE PAINTED. The wash sits on the
// CONTENT box, so a side with no rows is a 0px box and paints nothing however loudly it is
// classed — and a pane's paint now MEANS "there is something here to take" (`panePaint`). A
// delete/modify conflict would otherwise show a bare left pane beside a red right one and read as
// one-sided while it is contested, with a live arrow over the bare half. So a painted cell with no
// rows gets one line's worth of height and wears its wash there, the same concession
// `RegionRibbons`' `MIN_EDGE` already makes for a side that contributed a decision but no lines.
// It cannot grow a row: a decidable region always has content in some other pane, and the grid
// stretches every cell to the tallest one anyway.

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
  paint,
  rule,
  ariaHidden,
  anchor,
}: {
  rows: CellRow[];
  /** The wash class for THIS pane, already looked up by `paintClass` — `''` where the pane paints
   *  nothing. ⚠ A CLASS NAME, NOT A ROLE: the three panes no longer share one, and a component may
   *  not spell a colour. */
  paint?: string | null;
  /** The centre cell wears a 2px left rule in the STATE's ink — encoding two of three, and the one
   *  that still separates `ignored` from `unapplied` now that an undecided centre has no wash. */
  rule?: string | null;
  /** Set on the left/right cells of a region whose content the strip already announces, so the
   *  same lines are not read out three times. */
  ariaHidden?: boolean;
  /** `data-mr-cell="<fileIndex>:<regionId>:<pane>"`. ⚠ IT GOES ON THE BOX THAT SIZES TO THE
   *  CONTENT, not on the stretched grid cell: it is the hunk's own rectangle that the ribbon
   *  overlay measures, and the centre's grid cell also holds the strip and the suggestion panel.
   *  The overlay only ever READS this rect — see `ResolverPanes`' one-scroller invariant. */
  anchor?: string;
}): JSX.Element {
  // See the header: paint on a zero-row cell is paint on a zero-height box, and with `panePaint`'s
  // new rule that silence is a claim ("nothing to take here") rather than an accident.
  const emptyButPainted = rows.length === 0 && paint != null && paint !== '';
  return (
    <div className="mr-filler min-w-0" aria-hidden={ariaHidden === true ? true : undefined}>
      <div
        data-mr-cell={anchor}
        className={`min-w-0 font-mono text-[12px] leading-[18px] text-gray-900 dark:text-gray-100 ${
          paint ?? ''
        } ${rule != null ? `border-l-2 ${rule}` : ''} ${emptyButPainted ? 'h-[18px]' : ''}`}
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
                  className="code-hl min-h-[18px] min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
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
