// THE DESIGN GRID (docs/FRONTEND.md § Design diagrams): how a change (or a whole story) is built —
// stages across, layers down, one card per responsibility. The ONE renderer of a stored
// `DesignDiagram`; the Claude Review tab's Design section and This Sprint's ticket drawer both draw it.
//
//   LAYOUT   a CSS grid: a narrow layer-label column + one `minmax(0, 1fr)` column per act, so it
//            shrinks to the pane (the drawer is ~620px) with NO horizontal scroll; labels wrap, and no
//            text is smaller than 11px. Only the layers some card uses get a row (lib/designGrid.ts).
//   ARROWS   an SVG layer UNDER the cards, computed from the cards' DOM rects and re-measured by a
//            ResizeObserver. Purely visual (aria-hidden): the same arrows are an sr-only list.
//   CHANGE   new / changed / unchanged is a WORD + icon on the card AND a border style (solid, dashed,
//            plain) — never colour alone.
//   CLICK    a card with files is a button: one file opens it in the Changes tab; several open a small
//            list, each row opening its file. Which PR's Changes tab is the caller's `openFile`.
//
// Every string is the server's validated plain text, rendered as React text.
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { CHANGE_WORD, arrowPath, layoutDesign, memberForRef, prBadgeTexts, type ArrowGeometry } from '../lib/designGrid.js';
import { PencilIcon, PlusIcon } from './Icons.js';

export type OpenDesignFile = (cell: DesignCell, path: string) => void;

const CARD_CHANGE: Record<DesignCell['change'], string> = {
  new: 'border-2 border-solid border-ai-signal-fill bg-white dark:bg-gray-950',
  changed: 'border-2 border-dashed border-ai-signal-fill/70 bg-white dark:bg-gray-950',
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
  const markerId = useId().replace(/:/g, '');
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Array<ArrowGeometry & { key: string; label: string | null }>>([]);
  // NARROW (the ticket drawer, ~620px): the layer names move from a side column to a band heading
  // above each layer's cards, giving the stages the width — otherwise every card wraps to six lines
  // and the grid stops fitting on a laptop screen.
  const [narrow, setNarrow] = useState(false);
  const badges = useMemo(() => prBadgeTexts(members), [members]);
  // 1, 2, 3… for the arrows that carry a label, in the design's own order.
  const labelNumbers = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of layout.arrows) if (a.label != null) m.set(`${a.from}>${a.to}`, m.size + 1);
    return m;
  }, [layout]);

  const measure = useCallback((): void => {
    const grid = gridRef.current;
    if (grid == null) return;
    const g = grid.getBoundingClientRect();
    setNarrow(g.width > 0 && g.width < NARROW_PX);
    const box = (id: string) => {
      const el = cardRefs.current.get(id);
      if (el == null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - g.left, y: r.top - g.top, w: r.width, h: r.height };
    };
    const next: Array<ArrowGeometry & { key: string; label: string | null }> = [];
    for (const a of layout.arrows) {
      const from = box(a.from);
      const to = box(a.to);
      if (from == null || to == null) continue;
      next.push({ ...arrowPath(from, to), key: `${a.from}>${a.to}`, label: a.label });
    }
    setPaths(next);
  }, [layout]);

  useLayoutEffect(() => {
    measure();
    const grid = gridRef.current;
    if (grid == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(grid);
    for (const el of cardRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

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
        className={`relative grid pr-1 ${narrow ? 'gap-x-4 gap-y-1.5' : 'gap-x-5 gap-y-3'}`}
        style={{
          gridTemplateColumns: narrow
            ? `repeat(${nActs}, minmax(0, 1fr))`
            : `minmax(3.25rem, 6.5rem) repeat(${nActs}, minmax(0, 1fr))`,
        }}
      >
        <svg aria-hidden className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible text-gray-400 dark:text-gray-500">
          <defs>
            <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          {paths.map((p) => (
            <g key={p.key}>
              <path d={p.d} fill="none" stroke="currentColor" strokeWidth={1.5} markerEnd={`url(#${markerId})`} />
            </g>
          ))}
        </svg>

        {/* A labelled arrow carries a small NUMBER on top of the line, keyed below the grid: a gap
            between two cards is ~20px, too narrow for words, and a label there covered card text. */}
        {paths.map((p) => {
          const n = labelNumbers.get(p.key);
          return n == null ? null : (
            <span
              key={`l:${p.key}`}
              aria-hidden
              className="pointer-events-none absolute z-20 flex h-4 min-w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-gray-400 bg-white px-0.5 text-[11px] font-semibold leading-none text-gray-800 dark:border-gray-500 dark:bg-gray-950 dark:text-gray-100"
              style={{ left: p.lx, top: p.ly }}
            >
              {n}
            </span>
          );
        })}

        {/* Header row: the stages. */}
        {!narrow && <div aria-hidden />}
        {layout.acts.map((a, i) => (
          <div
            key={a.id}
            className="relative z-10 min-w-0 self-end break-words text-[12px] font-semibold text-gray-800 dark:text-gray-100"
            style={{ gridRow: 1, gridColumn: i + col0 }}
          >
            <span className="sr-only">Stage {i + 1}: </span>
            {a.title}
          </div>
        ))}

        {byRow.map((r, row) => (
          <Fragment key={r.layer}>
            <div
              className={`relative z-10 min-w-0 break-words text-[11px] font-medium text-gray-600 dark:text-gray-300 ${
                narrow ? 'mt-1 border-t border-gray-200 pt-1 dark:border-gray-800' : 'self-center'
              }`}
              style={narrow ? { gridRow: rowOf(row) - 1, gridColumn: '1 / -1' } : { gridRow: rowOf(row), gridColumn: 1 }}
            >
              {r.label}
            </div>
            {r.cells.map((g) => (
              <div key={g.cell.id} className="relative z-10 min-w-0" style={{ gridRow: rowOf(row), gridColumn: g.col + col0 }}>
                <DesignCard
                  cell={g.cell}
                  stage={layout.acts[g.col]!.title}
                  layerLabel={r.label}
                  member={memberForRef(g.cell.pr, members)}
                  badges={badges}
                  openFile={openFile}
                  cardRef={(el) => {
                    if (el) cardRefs.current.set(g.cell.id, el);
                    else cardRefs.current.delete(g.cell.id);
                  }}
                />
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      {labelNumbers.size > 0 && (
        <ol aria-hidden className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-gray-700 dark:text-gray-300">
          {layout.arrows.map((a) => {
            const n = labelNumbers.get(`${a.from}>${a.to}`);
            return n == null ? null : (
              <li key={`${a.from}>${a.to}`} className="inline-flex items-center gap-1">
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full border border-gray-400 px-0.5 text-[11px] font-semibold leading-none dark:border-gray-500">
                  {n}
                </span>
                {a.label}
              </li>
            );
          })}
        </ol>
      )}
      {layout.arrows.length > 0 && (
        <ul className="sr-only" aria-label="Hand-offs">
          {layout.arrows.map((a) => (
            <li key={`${a.from}>${a.to}`}>{a.text}</li>
          ))}
        </ul>
      )}
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
            className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${
              cell.change === 'new' ? 'text-ai-signal' : 'text-gray-700 dark:text-gray-200'
            }`}
          >
            {cell.change === 'new' ? <PlusIcon size={10} /> : <PencilIcon size={10} />}
            {word}
          </span>
        )}
        {cell.pattern != null && (
          <span className="inline-block max-w-full break-words rounded bg-gray-100 px-1 text-[11px] text-gray-700 dark:bg-gray-800 dark:text-gray-200">
            {cell.pattern}
          </span>
        )}
        {member != null && (
          <span className="whitespace-nowrap rounded border border-gray-300 px-1 text-[11px] text-gray-700 dark:border-gray-700 dark:text-gray-200">
            {badges.get(member.prId) ?? `#${member.number}`}
          </span>
        )}
      </span>
      <span className="mt-0.5 line-clamp-2 block break-words text-[13px] leading-snug text-gray-900 dark:text-gray-50">
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

  const cls = `block w-full min-w-0 rounded-md px-2 py-1.5 text-left ${CARD_CHANGE[cell.change]}`;
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
        className={`${cls} cursor-pointer hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500`}
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
              className="z-[60] max-w-[min(28rem,92vw)] rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
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
                      className="block w-full break-all rounded px-2 py-1 text-left font-mono text-[12px] text-gray-800 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-gray-100 dark:hover:bg-gray-800"
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
