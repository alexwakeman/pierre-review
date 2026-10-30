// THE DESIGN GRID (docs/FRONTEND.md § Design diagrams): how a change (or a whole story) is built —
// stages across, layers down, one card per responsibility. The ONE renderer of a stored
// `DesignDiagram`; the Claude Review tab's Design section and the Story section both draw it.
//
//   LAYOUT   a CSS grid: a narrow layer-label column + one `minmax(0, 1fr)` column per act, so it
//            shrinks to the pane (the drawer is ~620px) with NO horizontal scroll; labels wrap, and no
//            text is smaller than 11px. Only the layers some card uses get a row (lib/designGrid.ts).
//   ARROWS   right-angled lines in an SVG layer under the cards, routed ONLY through the padding round
//            each card and the grid gaps (lib/designGrid.ts routeArrow), so a line never passes behind
//            a card; re-measured by a ResizeObserver. A labelled arrow carries a number, keyed below.
//            Hovering a line or its number shows what it means beside the number, on the side covering
//            the fewest cards; it closes when the pointer leaves (no click, no pin).
//            Purely visual (aria-hidden): the same arrows are an sr-only list. The router hook, the arrow
//            layer, the key and the list are the LANE BOARD's (components/LaneBoard.tsx), shared so
//            This Sprint's boards and this grid draw one way.
//   CHANGE   new / changed / unchanged is a WORD + icon on the card AND a border style (solid, dashed,
//            plain) — never colour alone. A VISIBLE key under the grid names each border it draws (the
//            lane board's shared `BorderKey`, swatches from CARD_CHANGE itself).
//   CLICK    a card with files is a button: one file opens it in the Changes tab; several open a small
//            list, each row opening its file. Which PR's Changes tab is the caller's `openFile`.
//
// Every string is the server's validated plain text, rendered as React text.
import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { DesignCell, DesignDiagram, SequenceDiagramMember } from '@pierre-review/shared';
import { claimActivePopover } from '../lib/activePopover.js';
import { CHANGE_KEY_LABEL, CHANGE_WORD, changesPresent, layoutDesign, memberForRef, prBadgeTexts } from '../lib/designGrid.js';
import { ArrowKey, ArrowLayer, ArrowList, BorderKey, useRoutedArrows } from './LaneBoard.js';
import { PencilIcon, PlusIcon } from './Icons.js';

export type OpenDesignFile = (cell: DesignCell, path: string) => void;

const CARD_CHANGE: Record<DesignCell['change'], string> = {
  new: 'border-2 border-solid border-ai-signal-fill bg-ui-surface',
  changed: 'border-2 border-dashed border-ai-signal-fill/70 bg-ui-surface',
  unchanged: 'border border-solid border-ai-border bg-ai-surface-2',
};

export function DesignGrid({
  design,
  members = [],
  label,
  openFile,
}: {
  design: DesignDiagram;
  // Story designs: the members, in ref order (PR1 = members[0]). Empty for a PR design.
  members?: readonly SequenceDiagramMember[];
  // The accessible name of the whole grid.
  label: string;
  // Absent ⇒ cards are not clickable.
  openFile?: OpenDesignFile;
}): JSX.Element {
  const layout = useMemo(() => layoutDesign(design), [design]);
  const badges = useMemo(() => prBadgeTexts(members), [members]);
  // The router's inputs (the lane board's shared hook, components/LaneBoard.tsx).
  const cells = useMemo(() => layout.cells.map((c) => ({ id: c.cell.id, row: c.row, col: c.col })), [layout]);
  const arrows = useMemo(() => layout.arrows.map((a) => ({ ...a, key: `${a.from}>${a.to}` })), [layout]);
  // NARROW (a narrow pane): the layer names move from a side column to a band heading above each
  // layer's cards, giving the stages the width — otherwise every card wraps to six lines and the grid
  // stops fitting on a laptop screen.
  const { gridRef, cardRef, slotRef, paths, narrow, cardRects } = useRoutedArrows(cells, arrows, NARROW_PX);
  // 1, 2, 3… for the arrows that carry a label, in the design's own order.
  const labelNumbers = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of arrows) if (a.label != null) m.set(a.key, m.size + 1);
    return m;
  }, [arrows]);
  // What each arrow means, for its popover (hover the line or the number; nothing pins).
  const arrowDetails = useMemo(() => new Map(arrows.map((a) => [a.key, { label: a.label, text: a.text }])), [arrows]);
  const keyItems = useMemo(
    () => arrows.flatMap((a) => (a.label != null && labelNumbers.has(a.key) ? [{ n: labelNumbers.get(a.key)!, label: a.label }] : [])),
    [arrows, labelNumbers],
  );

  const nActs = layout.acts.length;
  const col0 = narrow ? 1 : 2; // the first stage's grid column
  const rowOf = (layerRow: number): number => (narrow ? 3 + layerRow * 2 : layerRow + 2);
  // Row-major DOM order, so a screen reader reads each layer across its stages.
  const byRow = layout.rows.map((r, row) => ({
    ...r,
    cells: layout.cells.filter((c) => c.row === row).sort((a, b) => a.col - b.col),
  }));

  return (
    <div role="group" aria-label={label} className="w-full">
      <div
        ref={gridRef}
        className={`relative grid pr-1 ${narrow ? 'gap-x-4 gap-y-2' : 'gap-x-8 gap-y-5'}`}
        style={{
          gridTemplateColumns: narrow
            ? `repeat(${nActs}, minmax(0, 1fr))`
            : `minmax(3.25rem, 6.5rem) repeat(${nActs}, minmax(0, 1fr))`,
        }}
      >
        <ArrowLayer paths={paths} numbers={labelNumbers} details={arrowDetails} avoid={cardRects} />

        {/* Header row: the stages. */}
        {!narrow && <div aria-hidden />}
        {layout.acts.map((a, i) => (
          <div
            key={a.id}
            className="relative z-10 min-w-0 self-end break-words text-meta font-semibold text-ui-ink"
            style={{ gridRow: 1, gridColumn: i + col0 }}
          >
            <span className="sr-only">Stage {i + 1}: </span>
            {a.title}
          </div>
        ))}

        {byRow.map((r, row) => (
          <Fragment key={r.layer}>
            <div
              className={`relative z-10 min-w-0 break-words text-meta font-medium text-ui-mute ${
                narrow ? 'mt-1 border-t border-ui-line pt-1' : 'self-center'
              }`}
              style={narrow ? { gridRow: rowOf(row) - 1, gridColumn: '1 / -1' } : { gridRow: rowOf(row), gridColumn: 1 }}
            >
              {r.label}
            </div>
            {r.cells.map((g) => (
              <div
                key={g.cell.id}
                ref={slotRef(g.cell.id)}
                className={`relative z-10 min-w-0 ${narrow ? 'p-1.5' : 'p-2.5'}`}
                style={{ gridRow: rowOf(row), gridColumn: g.col + col0 }}
              >
                <DesignCard
                  cell={g.cell}
                  stage={layout.acts[g.col]!.title}
                  layerLabel={r.label}
                  member={memberForRef(g.cell.pr, members)}
                  badges={badges}
                  openFile={openFile}
                  cardRef={cardRef(g.cell.id)}
                />
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      {/* The card borders, named on the surface (each swatch is the card's own classes); how the
          design was drawn stays behind the heading's ⓘ. */}
      <BorderKey
        testId="design-border-key"
        items={changesPresent(layout).map((k) => ({ key: k, label: CHANGE_KEY_LABEL[k], swatch: CARD_CHANGE[k] }))}
      />
      <ArrowKey items={keyItems} />
      <ArrowList label="Hand-offs" items={layout.arrows.map((a) => ({ key: `${a.from}>${a.to}`, text: a.text }))} />
    </div>
  );
}

const NARROW_PX = 760;


function DesignCard({
  cell,
  stage,
  layerLabel,
  member,
  badges,
  openFile,
  cardRef,
}: {
  cell: DesignCell;
  stage: string;
  layerLabel: string;
  member: SequenceDiagramMember | null;
  badges: Map<number, string>;
  openFile?: OpenDesignFile;
  cardRef: (el: HTMLElement | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const word = CHANGE_WORD[cell.change];
  const clickable = openFile != null && cell.files.length > 0;
  const many = cell.files.length > 1;
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);
  useEffect(() => {
    if (!open) return;
    return claimActivePopover(() => setOpen(false));
  }, [open]);

  const body = (
    <>
      <span className="flex flex-wrap items-center gap-1">
        {word != null && (
          <span
            className={`inline-flex items-center gap-0.5 text-meta font-semibold ${
              cell.change === 'new' ? 'text-ai-signal' : 'text-ui-ink'
            }`}
          >
            {cell.change === 'new' ? <PlusIcon size={10} /> : <PencilIcon size={10} />}
            {word}
          </span>
        )}
        {cell.pattern != null && (
          <span className="inline-block max-w-full break-words rounded-ui bg-ui-raise px-1 text-meta text-ui-ink">
            {cell.pattern}
          </span>
        )}
        {member != null && (
          <span className="whitespace-nowrap rounded-ui border border-ui-line px-1 text-meta text-ui-ink">
            {badges.get(member.prId) ?? `#${member.number}`}
          </span>
        )}
      </span>
      <span className="mt-0.5 line-clamp-2 block break-words text-body leading-snug text-ui-ink">
        {cell.label}
      </span>
    </>
  );
  // What a screen reader hears for the card as a whole.
  const name = [
    cell.label,
    word ?? 'Unchanged',
    cell.pattern != null ? `pattern ${cell.pattern}` : null,
    member != null ? `pull request ${member.repo} #${member.number}` : null,
    `${stage}, ${layerLabel}`,
    clickable ? (many ? `${cell.files.length} files` : `open ${cell.files[0]}`) : null,
  ]
    .filter(Boolean)
    .join('; ');

  const cls = `block w-full min-w-0 rounded-ui px-2 py-1.5 text-left ${CARD_CHANGE[cell.change]}`;
  if (!clickable) {
    return (
      <div ref={cardRef} className={cls} role="note" aria-label={name}>
        {body}
      </div>
    );
  }
  return (
    <>
      <button
        ref={(el) => {
          cardRef(el);
          refs.setReference(el);
        }}
        type="button"
        {...getReferenceProps()}
        aria-label={name}
        aria-haspopup={many ? 'true' : undefined}
        aria-expanded={many ? open : undefined}
        aria-controls={many && open ? listId : undefined}
        onClick={() => {
          if (many) setOpen((o) => !o);
          else openFile!(cell, cell.files[0]!);
        }}
        className={`${cls} cursor-pointer hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent`}
      >
        {body}
      </button>
      {many && open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps({ onClick: (e) => e.stopPropagation() })}
              id={listId}
              data-noactivate
              className="z-[60] max-w-[min(28rem,92vw)] rounded-ui border border-ui-line bg-ui-surface p-1 shadow-lg"
            >
              <ul className="space-y-0.5">
                {cell.files.map((f) => (
                  <li key={f}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        openFile!(cell, f);
                      }}
                      className="hit block w-full break-all rounded-ui px-2 py-1 text-left font-mono text-meta text-ui-ink hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                    >
                      {f}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
