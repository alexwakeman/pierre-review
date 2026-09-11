import { useMemo, useState } from 'react';
import type {
  ConflictDecision,
  ConflictHunkSuggestion,
  ConflictLine,
  ConflictRegion,
} from '@pierre-review/shared';
import { centreLines, slotRole, type SlotDecision } from '../../lib/mergeResolver.js';
import { highlightLines } from '../../lib/hljsLines.js';
import { AcceptLeftIcon, AcceptRightIcon, ChevronIcon } from '../Icons.js';
import { CodeCell, type CellRow } from './CodeCell.js';
import { HunkSuggestionPanel } from './HunkSuggestionPanel.js';
import { SlotStrip } from './SlotStrip.js';
import type { HunkAskState } from './useHunkSuggestion.js';
import {
  HIDE_UNCHANGED,
  PANE_OURS,
  PANE_RESULT,
  RULE_CLASS,
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
  onActivate: () => void;
  onDecide: (decision: ConflictDecision | null) => void;
}): JSX.Element {
  // Expansion is LOCAL and EPHEMERAL. It is a derived view state, so it is computed for the
  // render and never written back anywhere — the same rule the app's sub-tabs follow.
  const [expanded, setExpanded] = useState(false);

  const role = slotRole(region, slot);
  const rule = role == null ? null : RULE_CLASS[role];
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

  const gutter = (
    side: 'left' | 'right',
    decision: ConflictDecision,
    label: string,
  ): JSX.Element => (
    <div className="flex items-start justify-center pt-0.5">
      {region.allowed.includes(decision) && (
        <button
          type="button"
          // ⚠ A DUPLICATE, AND HIDDEN FROM ASSISTIVE TECH ON PURPOSE. The strip already offers
          // this verb with a real name; announcing it twice makes every region read as a pair of
          // identical buttons. `tabIndex={-1}` for the same reason.
          aria-hidden
          tabIndex={-1}
          title={label}
          onClick={() => {
            onActivate();
            onDecide(decision);
          }}
          className="rounded p-0.5 text-gray-500 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-900 group-focus-within:opacity-100 group-hover:opacity-100 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          {side === 'left' ? <AcceptLeftIcon size={13} /> : <AcceptRightIcon size={13} />}
        </button>
      )}
    </div>
  );

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
      onAskClaude={onAskClaude}
      askInFlight={ask?.status === 'asking'}
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

  // ⚠ `contents` KEEPS THE FIVE CELLS AS DIRECT GRID ITEMS. A real wrapper box would make each
  // row its own formatting context and the columns would stop lining up. The `group` class still
  // works: `display: contents` removes the box, not the element, so hover still propagates.
  return (
    <div className="group contents">
      {narrow ? (
        // Below the three-column threshold the same five children stack in source order — left,
        // centre, right — with the gutters hidden. State lives above this component, so widening
        // the window restores the panes with every decision intact.
        <div className="col-span-full border-t border-gray-200 py-1 dark:border-gray-800">
          <StackedSide label={PANE_OURS} rows={left} role={role} />
          {strip}
          <StackedSide label={PANE_RESULT} rows={middle} role={role} rule={rule} />
          {pending}
          <StackedSide label={paneTheirs(baseRef)} rows={right} role={role} />
          {foldControl}
        </div>
      ) : (
        <>
          <div className="min-w-0 border-t border-gray-200 dark:border-gray-800">
            <CodeCell rows={left} role={role} ariaHidden />
            {foldControl}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-800">
            {gutter('left', 'ours', `Take your version of ${path}`)}
          </div>
          <div className="min-w-0 border-t border-gray-200 dark:border-gray-800">
            {strip}
            <CodeCell rows={middle} role={role} rule={rule} />
            {pending}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-800">
            {gutter('right', 'theirs', `Take the change from ${baseRef}`)}
          </div>
          <div className="min-w-0 border-t border-gray-200 dark:border-gray-800">
            <CodeCell rows={right} role={role} ariaHidden />
          </div>
        </>
      )}
    </div>
  );
}

function StackedSide({
  label,
  rows,
  role,
  rule,
}: {
  label: string;
  rows: CellRow[];
  role: ReturnType<typeof slotRole>;
  rule?: string | null;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="px-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <CodeCell rows={rows} role={role} rule={rule} />
    </div>
  );
}
