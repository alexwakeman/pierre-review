import { useMemo, useState } from 'react';
import type {
  ConflictDecision,
  ConflictHunkSuggestion,
  ConflictLine,
  ConflictRegion,
} from '@pierre-review/shared';
import {
  centreLines,
  panePaint,
  sideOffered,
  sideOutcome,
  slotRole,
  type SlotDecision,
} from '../../lib/mergeResolver.js';
import { highlightLines } from '../../lib/hljsLines.js';
import { AcceptLeftIcon, AcceptRightIcon, ChevronIcon } from '../Icons.js';
import { CodeCell, type CellRow } from './CodeCell.js';
import { HunkSuggestionPanel } from './HunkSuggestionPanel.js';
import { RegionEditPanel } from './RegionEditPanel.js';
import { SlotStrip } from './SlotStrip.js';
import type { HunkAskState } from './useHunkSuggestion.js';
import type { RegionEditState } from './useRegionEdit.js';
import {
  HIDE_UNCHANGED,
  PANE_OURS,
  PANE_RESULT,
  RULE_CLASS,
  actionLabels,
  gutterLabel,
  paintClass,
  paneTheirs,
  showUnchanged,
} from './copy.js';

// ── ONE REGION, FIVE CELLS, ONE GRID ROW ─────────────────────────────────────────────────────
//
// ⚠ VERTICAL ALIGNMENT IS A BROWSER GUARANTEE HERE, NOT A COMPUTATION. The five cells are emitted
// into the parent grid through `display: contents`, so a three-line left cell beside a seven-line
// right cell is ONE grid row whose height is its tallest cell, with `align-items: stretch` filling
// the rest. That means: no spacer rows, no `ResizeObserver` measuring cell heights, no
// scroll-synchronisation driver, and no way for the panes to drift apart. Any change that gives a
// pane its own scroller or its own element per line brings all of that back.
//
// ⚠ THE ALIGNMENT GRAIN IS THE REGION, NOT THE LINE, and that is a decision rather than a
// simplification. A contested region's two sides are two different pieces of text; claiming line 4
// on the left "corresponds to" line 4 on the right is a correspondence the merge engine never
// made, and with wrapping on it would not even be visually true.

/** An `unchanged` region longer than this folds to head 3 + a control + tail 3. */
export const CONTEXT_FOLD_LINES = 8;
const FOLD_EDGE = 3;

/** Build one cell's rows, highlighting the WHOLE cell first so the lexer keeps its state across
 *  the fold, then slicing. */
function cellRows(lines: ConflictLine[], language: string | null, folded: boolean): CellRow[] {
  const html = highlightLines(
    lines.map((l) => l.text),
    language,
  );
  const all: CellRow[] = lines.map((l, i) => ({
    kind: 'line',
    n: l.n,
    text: l.text,
    html: html?.[i] ?? null,
  }));
  if (!folded) return all;
  return [
    ...all.slice(0, FOLD_EDGE),
    { kind: 'gap' },
    ...all.slice(all.length - FOLD_EDGE),
  ];
}

function centreRows(lines: string[], language: string | null, folded: boolean): CellRow[] {
  const html = highlightLines(lines, language);
  const all: CellRow[] = lines.map((text, i) => ({
    kind: 'line',
    n: null,
    text,
    html: html?.[i] ?? null,
  }));
  if (!folded) return all;
  return [...all.slice(0, FOLD_EDGE), { kind: 'gap' }, ...all.slice(all.length - FOLD_EDGE)];
}

export function SlotRow({
  region,
  slot,
  fileIndex,
  path,
  baseRef,
  ordinal,
  total,
  language,
  narrow,
  active,
  ask,
  onAskClaude,
  onUseSuggestion,
  onDiscardSuggestion,
  edit,
  editDraft,
  onEditDraft,
  onOpenEdit,
  onCancelEdit,
  onSaveEdit,
  onActivate,
  onDecide,
}: {
  region: ConflictRegion;
  slot: SlotDecision;
  fileIndex: number;
  path: string;
  baseRef: string;
  ordinal: number;
  total: number;
  language: string | null;
  narrow: boolean;
  active: boolean;
  /** What this region's "Ask Claude" is doing, or undefined when nothing is pending. */
  ask?: HunkAskState | undefined;
  /** Absent ⇒ no Ask control renders at all (unentitled, or no plugin). */
  onAskClaude?: (() => void) | undefined;
  onUseSuggestion?: ((suggestion: ConflictHunkSuggestion) => void) | undefined;
  onDiscardSuggestion?: (() => void) | undefined;
  /** This region's text box, or undefined when it is closed. */
  edit?: RegionEditState | undefined;
  /** What the reader had typed when this row last unmounted — a file switch, on an editor that
   *  is still open. Undefined ⇒ the box opens from the region's own centre lines. */
  editDraft?: string | undefined;
  onEditDraft?: ((text: string) => void) | undefined;
  /** Absent ⇒ no Edit control at all. `unchanged` regions pass nothing: context is read-only. */
  onOpenEdit?: (() => void) | undefined;
  onCancelEdit?: (() => void) | undefined;
  onSaveEdit?: ((text: string) => void) | undefined;
  onActivate: () => void;
  onDecide: (decision: ConflictDecision | null) => void;
}): JSX.Element {
  // Expansion is LOCAL and EPHEMERAL. It is a derived view state, so it is computed for the
  // render and never written back anywhere — the same rule the app's sub-tabs follow.
  const [expanded, setExpanded] = useState(false);
  // ⚠ ONE SPELLING, SHARED WITH THE STRIP. The gutter arrows used to carry their own `title`
  // strings written out in this component — a user-facing string outside `copy.ts`, and two
  // sentences for one verb the moment either was reworded.
  const labels = actionLabels(baseRef);

  // The STATE role, for the strip's word and the centre's 2px rule only. What each PANE paints is
  // a separate question with a separate answer — see `panePaint`'s header.
  const role = slotRole(region, slot);
  const rule = role == null ? null : RULE_CLASS[role];
  // ⚠ CLASS NAMES, NOT ROLES. `CodeCell` may not spell a colour, and it is memoised on a shallow
  // prop compare — a class name is a string, so the memo holds across every row.
  // ⚠ A SIDE IS PAINTED ONLY WHILE IT IS OFFERING SOMETHING, and green once its lines went into
  // the result. `panePaint`'s header has the whole rule; the gutter arrow below calls the very
  // same `sideOffered`, so a painted side and an available arrow cannot come apart.
  const leftPaint = paintClass(panePaint(region, slot, 'left'));
  const centrePaint = paintClass(panePaint(region, slot, 'centre'));
  const rightPaint = paintClass(panePaint(region, slot, 'right'));
  // The ribbon overlay's only handle on this row. `(fileIndex, regionId)` is the whole of the
  // correspondence the merge engine ever asserted — there is no line-level pairing to anchor to.
  const anchor = (pane: 'left' | 'centre' | 'right'): string =>
    `${fileIndex}:${region.id}:${pane}`;
  const isUnchanged = region.kind === 'unchanged';
  const foldable = isUnchanged && region.base.length > CONTEXT_FOLD_LINES;
  const folded = foldable && !expanded;
  const hiddenCount = folded ? region.base.length - FOLD_EDGE * 2 : 0;

  // `unchanged` sends EMPTY `ours`/`theirs` on the wire (they would be byte-identical copies of
  // `base`), so all three panes read `base` for it.
  const oursLines = isUnchanged ? region.base : region.ours;
  const theirsLines = isUnchanged ? region.base : region.theirs;
  const centre = useMemo(() => centreLines(region, slot), [region, slot]);

  const left = useMemo(() => cellRows(oursLines, language, folded), [oursLines, language, folded]);
  const right = useMemo(
    () => cellRows(theirsLines, language, folded),
    [theirsLines, language, folded],
  );
  const middle = useMemo(() => centreRows(centre, language, folded), [centre, language, folded]);

  const foldControl = foldable ? (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-[11px] text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
    >
      <ChevronIcon dir={expanded ? 'down' : 'right'} size={11} />
      {expanded ? HIDE_UNCHANGED : showUnchanged(hiddenCount)}
    </button>
  ) : null;

  // ── THE ONE CONTROL THAT TAKES A SIDE ──────────────────────────────────────────────────────
  //
  // ⚠ IT USED TO BE A HOVER-REVEALED, `aria-hidden` DUPLICATE of a button on the strip. The strip
  // has given the verb up (see `SlotStrip`'s header), so this is now the only pointer route to
  // "take this side" and it is a real control: really named, really focusable.
  //
  // ⚠ IT RENDERS ONLY WHERE THERE IS SOMETHING TO BRING IN — `sideOffered`, the SAME predicate
  // `panePaint` uses for the wash. A pane wearing no paint and offering no arrow is one fact told
  // twice, which is the point: an arrow over `main`'s empty filler hatch invited a press that had
  // nothing behind it.
  //
  // ⚠ AND IT GOES AWAY ONCE THIS SIDE'S LINES ARE IN THE RESULT (`sideOutcome === 'contributed'`).
  // An arrow is an offer to ADD something; on a side already added it offers a no-op, and pressing
  // it re-sends the decision that is already stored. The way back out is Undo or Ignore on the
  // strip, both of which clear the decision and bring the arrow straight back — it is DERIVED from
  // `slot`, so nothing has to re-reveal it. On a conflict where one side was taken the OTHER
  // side's arrow stays, because switching sides is still a real change.
  //
  // ⚠ THAT IS ALSO WHY THERE IS NO `aria-pressed` HERE. It read `sideOutcome === 'contributed'`,
  // which is now exactly the condition under which the button does not exist, so it could only
  // ever have announced "not pressed" — noise on every arrow. Presence IS the state now: an arrow
  // means this side is not in the result. The strip's state word still says so in words.
  //
  // ⚠ ITS VISIBLE COPY IS A TOOLTIP, AND ON A WIDE TOUCH SCREEN A TOOLTIP NEVER APPEARS. Weighed
  // and left as it is: the alternative is handing the side verbs back to the strip on a coarse
  // pointer, which puts the same verb on screen TWICE and announces it twice — the exact thing
  // this control exists to end — and a left/right arrow in the gutter between two diffs is the one
  // idiom every merge tool already shares. The name is on `aria-label`, the keys are `←`/`→`, and
  // a stacked layout (where a pointer is likeliest to be all somebody has) still gets the words.
  //
  // ⚠ ROVING TAB STOP, SHARED WITH THE STRIP. `tabIndex` reads the same `active` prop, so the
  // whole row is two extra tab stops on ONE region rather than eight hundred across the file.
  //
  // ⚠ `data-mr-take` IS WHAT THE KEYBOARD REVEAL AIMS AT. `ResolverPanes`' reveal effect used to
  // focus the first `<button>` inside `[data-mr-region]`, which is the STRIP — and once the strip
  // gave up the two side verbs, the first button there is "Ignore this change and keep the
  // ancestor" on every one-sided change. Walking a file with `n` landed the reader on Ignore, one
  // reflex Space from discarding the change. The affirmative take lives two grid cells away, so it
  // has to be addressable.
  //
  // ⚠ THE TARGET IS 25 x 17 CSS px AND THAT IS A RECORDED DECISION, NOT AN OVERSIGHT. WCAG 2.5.8
  // wants 24 x 24 or a 24px offset to the next target. The width is 25 of the track's 28px, which
  // is all of it that fits without touching the panes; the HEIGHT cannot grow without growing the row,
  // which would break the one-scroller alignment invariant for every short region. The offset
  // clause carries it instead: two decidable regions are never adjacent — a three-way region list
  // always has an `unchanged` run between them, and an `unchanged` region emits NO arrow — so the
  // nearest other arrow in this column is at least two rows (≥ 36px) away.
  const gutter = (side: 'left' | 'right'): JSX.Element => {
    const decision: ConflictDecision = side === 'left' ? 'ours' : 'theirs';
    const label = side === 'left' ? labels.left : labels.right;
    return (
      // ⚠ `relative z-[1]` IS FOR THE RIBBONS, NOT FOR LAYOUT. `.mr-ribbons` is positioned with
      // z-index `auto`, so it paints above a non-positioned flex child — and the ribbon's whole
      // x-span IS this gutter track, which would tint the accept arrow sitting in it. A positioned
      // `z-[1]` puts the arrow back on top of the overlay while still painting UNDER the panes'
      // sticky `z-10` headers. It changes no box's size, so the grid's alignment invariant costs
      // nothing.
      <div className="relative z-[1] flex items-start justify-center pt-0.5">
        {sideOffered(region, side) && sideOutcome(slot, side) !== 'contributed' && (
          <button
            type="button"
            tabIndex={active ? 0 : -1}
            data-mr-take={`${fileIndex}:${region.id}:${side}`}
            title={label}
            aria-label={gutterLabel(label, region, ordinal, total, path)}
            onFocus={onActivate}
            onClick={() => {
              onActivate();
              onDecide(decision);
            }}
            // ⚠ DIM AT REST, NOT HIDDEN AT REST, AND STILL LEGIBLE AT REST. The resting pair is
            // 4.83:1 on the light page and 8.9:1 on the dark one — this is a control the reader
            // has to FIND without a pointer, so it may not take index.css's decorative opt-out,
            // which is for separators and gridlines. Nothing here has a box size: a ring is a
            // box-shadow and an outline is not laid out, so the gutter track stays 1.75rem and the
            // row's height stays its tallest CODE cell.
            //
            // ⚠ THE RESTING GROUND IS NOT ALWAYS THE PAGE. Once a side is taken the ribbon paints
            // this whole track, so the arrow sits on a tinted ground — still over 3:1, which is
            // what WCAG 1.4.11 asks of a non-text control, and `resolverControls.test.ts` measures
            // it against BOTH grounds so a later alpha bump on the ribbon cannot quietly sink it.
            //
            // ⚠ THE FOCUS RING IS A DARKER SKY IN LIGHT MODE ON PURPOSE. The lighter one measures
            // 2.1:1 on white — a focus indicator below 3:1 is a focus indicator a keyboard reader
            // cannot find, and it was the only thing marking the arrow they are standing on.
            //
            // ⚠ DO NOT BACKTICK A BARE UTILITY IN THIS COMMENT. `textContrast.test.ts` scans every
            // quoted run on every line, backticks included, so a prose mention of one half of a
            // theme pairing reads to it as a theme-LESS colour and fails the build on a comment.
            className="rounded px-1.5 py-0.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:bg-gray-100 focus-visible:text-gray-900 focus-visible:ring-1 focus-visible:ring-sky-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 dark:focus-visible:bg-gray-800 dark:focus-visible:text-gray-100 dark:focus-visible:ring-sky-400"
          >
            {side === 'left' ? <AcceptLeftIcon size={13} /> : <AcceptRightIcon size={13} />}
          </button>
        )}
      </div>
    );
  };

  const strip = isUnchanged ? null : (
    <SlotStrip
      region={region}
      slot={slot}
      role={role}
      fileIndex={fileIndex}
      ordinal={ordinal}
      total={total}
      path={path}
      baseRef={baseRef}
      active={active}
      // Stacked ⇒ no gutter tracks exist, so the two side verbs go back on the strip.
      sideTakes={narrow}
      onAskClaude={onAskClaude}
      askInFlight={ask?.status === 'asking'}
      onEdit={onOpenEdit}
      editOpen={edit != null}
      onActivate={onActivate}
      onDecide={onDecide}
    />
  );

  // ⚠ THE PENDING SUGGESTION SITS UNDER THE CENTRE CELL AND THE TWO SIDE PANES STAY VISIBLE. It
  // is a sixth state of this cell, read against the left and right panes already aligned to it —
  // not a modal, not a fourth column, and not a side-by-side against the deterministic merge
  // (which on the common case has nothing to show, since that is why the button was pressed).
  const pending =
    ask == null || onUseSuggestion == null || onDiscardSuggestion == null ? null : (
      <HunkSuggestionPanel
        state={ask}
        language={language}
        onUse={onUseSuggestion}
        onDiscard={onDiscardSuggestion}
      />
    );

  // ⚠ THE TEXT BOX SITS IN THE SAME SLOT, FOR THE SAME REASONS. It is another state of this
  // cell, read against the two side panes already aligned to it — and putting it here rather
  // than inside `CodeCell` is what keeps `data-mr-cell` on a content-sized box, so the ribbon
  // geometry never learns about it. See `RegionEditPanel`'s header.
  //
  // ⚠ IT IS SEEDED FROM `centre`, WHICH IS THE FOLD'S OWN OUTPUT for whatever this region is
  // currently showing — including a previous edit. Editing therefore starts from what is on
  // screen, never from one side chosen on the reader's behalf. A remembered DRAFT wins over it:
  // this row unmounts on a file switch while its editor state stays open, so without one the box
  // came back with the seed and the reader's typing gone.
  const editor =
    edit == null || onSaveEdit == null || onCancelEdit == null || onEditDraft == null ? null : (
      <RegionEditPanel
        state={edit}
        seed={editDraft ?? centre.join('\n')}
        path={path}
        ordinal={ordinal}
        total={total}
        onDraft={onEditDraft}
        onSave={onSaveEdit}
        onCancel={onCancelEdit}
      />
    );

  // ⚠ `contents` KEEPS THE FIVE CELLS AS DIRECT GRID ITEMS. A real wrapper box would make each
  // row its own formatting context and the columns would stop lining up.
  //
  // ⚠ NO `group` CLASS ANY MORE. It existed for exactly one thing — `group-hover:opacity-100` on
  // the two gutter arrows, back when they were revealed by the pointer. They are always drawn now,
  // so nothing in this subtree reads a `group-*` utility and a live-looking hook that styles
  // nothing is worse than none.
  return (
    <div className="contents">
      {narrow ? (
        // Below the three-column threshold the same five children stack in source order — left,
        // centre, right — and the two gutter CELLS are not emitted at all. That is why the strip
        // takes the side verbs back here (`sideTakes`): with no gutter there is nowhere else for
        // them, and a pointer would have no route to "take this side".
        // State lives above this component, so widening the window restores the panes with every
        // decision intact.
        <div className="col-span-full border-t border-gray-200 py-1 dark:border-gray-800">
          <StackedSide label={PANE_OURS} rows={left} paint={leftPaint} anchor={anchor('left')} />
          {strip}
          <StackedSide
            label={PANE_RESULT}
            rows={middle}
            paint={centrePaint}
            rule={rule}
            anchor={anchor('centre')}
          />
          {pending}
          {editor}
          <StackedSide
            label={paneTheirs(baseRef)}
            rows={right}
            paint={rightPaint}
            anchor={anchor('right')}
          />
          {foldControl}
        </div>
      ) : (
        <>
          <div className="min-w-0 border-t border-gray-200 dark:border-gray-800">
            <CodeCell rows={left} paint={leftPaint} anchor={anchor('left')} ariaHidden />
            {foldControl}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-800">
            {gutter('left')}
          </div>
          <div className="min-w-0 border-t border-gray-200 dark:border-gray-800">
            {strip}
            <CodeCell rows={middle} paint={centrePaint} rule={rule} anchor={anchor('centre')} />
            {pending}
            {editor}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-800">
            {gutter('right')}
          </div>
          <div className="min-w-0 border-t border-gray-200 dark:border-gray-800">
            <CodeCell rows={right} paint={rightPaint} anchor={anchor('right')} ariaHidden />
          </div>
        </>
      )}
    </div>
  );
}

function StackedSide({
  label,
  rows,
  paint,
  rule,
  anchor,
}: {
  label: string;
  rows: CellRow[];
  paint?: string | null;
  rule?: string | null;
  anchor?: string;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="px-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <CodeCell rows={rows} paint={paint} rule={rule} anchor={anchor} />
    </div>
  );
}
