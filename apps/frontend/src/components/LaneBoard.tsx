// THE LANE BOARD (docs/FRONTEND.md § Activity → This Sprint): columns across, lanes down, one card per
// slot, right-angled arrows through the gaps. ONE renderer for This Sprint's three views (Critical path,
// Theme, People); the pure layout is lib/laneBoard.ts. Its arrow pieces — the router hook, the arrow
// layer with its numbered markers, the key and the sr-only list — are SHARED with the design grid
// (components/DesignGrid.tsx), so the two read as one design.
//
//   LAYOUT   a CSS grid: a lane-label column + one column per board column. A collapsed (Complete)
//            column is narrow and shows counts; "Show" opens it. NARROW (< NARROW_PX): the lane label
//            moves to a band heading above the lane's cards, as the design grid's layer names do. Below
//            the columns' minimum widths the board scrolls inside its own box, never the page.
//   ARROWS   routed by lib/designGrid.ts `routeArrow` through the padding round each card and the grid's
//            gaps, re-measured by a ResizeObserver. A critical arrow is drawn in the accent. A labelled
//            arrow carries a number, keyed below the board. Purely visual (aria-hidden): the same arrows
//            are an sr-only list.
import { Fragment, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { routeArrow, type ArrowGeometry, type PlacedCard } from '../lib/designGrid.js';
import type { BoardLayout } from '../lib/laneBoard.js';
import { ChevronIcon } from './Icons.js';

// ── The shared arrow pieces (the design grid draws with these too) ───────────────────────────────

const NONE_OCCUPIED: ReadonlyArray<{ row: number; col: number }> = [];

export interface RoutedPath extends ArrowGeometry {
  key: string;
}

/**
 * Measure every card and its padded slot, and route each arrow between two of them. Returns the refs to
 * hang on the grid, the cards and the slots, the routed paths, and whether the grid's box is narrower
 * than `narrowPx`. `cells`, `arrows` and `occupied` must be memoised by the caller (they key the
 * re-measure). `occupied` = other grid cells that hold something an arrow must not run through (the
 * lane board's "n tickets" in a collapsed column).
 */
export function useRoutedArrows(
  cells: ReadonlyArray<{ id: string; row: number; col: number }>,
  arrows: ReadonlyArray<{ key: string; from: string; to: string }>,
  narrowPx: number,
  occupied: ReadonlyArray<{ row: number; col: number }> = NONE_OCCUPIED,
): {
  gridRef: React.MutableRefObject<HTMLDivElement | null>;
  cardRef: (id: string) => (el: HTMLElement | null) => void;
  slotRef: (id: string) => (el: HTMLElement | null) => void;
  paths: RoutedPath[];
  narrow: boolean;
} {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const slots = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<RoutedPath[]>([]);
  const [narrow, setNarrow] = useState(false);
  const lastSig = useRef('');

  const measure = useCallback((): void => {
    const grid = gridRef.current;
    if (grid == null) return;
    const g = grid.getBoundingClientRect();
    // The box the grid sits in decides narrow (a grid with minimum column widths may be wider).
    const box = (grid.parentElement ?? grid).getBoundingClientRect();
    setNarrow(box.width > 0 && box.width < narrowPx);
    const rel = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - g.left, y: r.top - g.top, w: r.width, h: r.height };
    };
    const css = getComputedStyle(grid);
    const gapX = parseFloat(css.columnGap) || 0;
    const gapY = parseFloat(css.rowGap) || 0;
    const at = new Map(cells.map((c) => [c.id, c]));
    const taken = new Set([...cells, ...occupied].map((c) => `${c.row}:${c.col}`));
    const placed = (id: string): PlacedCard | null => {
      const card = cards.current.get(id);
      const slot = slots.current.get(id);
      const c = at.get(id);
      if (card == null || slot == null || c == null) return null;
      return { card: rel(card), slot: rel(slot), row: c.row, col: c.col };
    };
    const next: RoutedPath[] = [];
    for (const a of arrows) {
      const from = placed(a.from);
      const to = placed(a.to);
      if (from == null || to == null) continue;
      next.push({ ...routeArrow(from, to, (r, c) => taken.has(`${r}:${c}`), gapX, gapY), key: a.key });
    }
    // Only a CHANGED drawing re-renders — a resize that moves nothing must not loop.
    const sig = next.map((p) => `${p.key}:${p.d}`).join('|');
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      setPaths(next);
    }
  }, [cells, arrows, narrowPx, occupied]);

  useLayoutEffect(() => {
    measure();
    const grid = gridRef.current;
    if (grid == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(grid);
    if (grid.parentElement != null) ro.observe(grid.parentElement);
    for (const el of cards.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const cardRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) cards.current.set(id, el);
      else cards.current.delete(id);
    },
    [],
  );
  const slotRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) slots.current.set(id, el);
      else slots.current.delete(id);
    },
    [],
  );
  return { gridRef, cardRef, slotRef, paths, narrow };
}

/** The numbered marker on an arrow and in its key. */
const NUMBER_CLASS =
  'flex h-4 min-w-4 items-center justify-center rounded-full border border-gray-400 px-0.5 text-[11px] font-semibold leading-none dark:border-gray-500';

/** The arrows under the cards, and the numbered markers on top of the labelled ones. Inside the grid. */
export function ArrowLayer({
  paths,
  numbers,
  critical,
}: {
  paths: readonly RoutedPath[];
  /** Arrow key → its number, for the labelled arrows. */
  numbers: ReadonlyMap<string, number>;
  /** Arrow keys drawn in the accent. */
  critical?: ReadonlySet<string>;
}): JSX.Element {
  const id = useId().replace(/:/g, '');
  const plain = `${id}-a`;
  const accent = `${id}-c`;
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible text-gray-500 dark:text-gray-400">
        <defs>
          <marker id={plain} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
          <marker
            id={accent}
            className="text-ai-signal-fill"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="10"
            markerHeight="10"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {paths.map((p) => {
          const on = critical?.has(p.key) === true;
          return (
            <path
              key={p.key}
              d={p.d}
              fill="none"
              stroke="currentColor"
              className={on ? 'text-ai-signal-fill' : undefined}
              strokeWidth={on ? 2.25 : 1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              markerEnd={`url(#${on ? accent : plain})`}
            />
          );
        })}
      </svg>
      {/* A labelled arrow carries a small NUMBER on top of the line, keyed below: a gap between two
          cards is ~20px, too narrow for words, and a label there covered card text. */}
      {paths.map((p) => {
        const n = numbers.get(p.key);
        return n == null ? null : (
          <span
            key={`l:${p.key}`}
            aria-hidden
            className={`pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 bg-white text-gray-800 dark:bg-gray-950 dark:text-gray-100 ${NUMBER_CLASS}`}
            style={{ left: p.lx, top: p.ly }}
          >
            {n}
          </span>
        );
      })}
    </>
  );
}

/** The one-line key under a board: each number and its words. Visual only (the sr-only list says it). */
export function ArrowKey({ items }: { items: ReadonlyArray<{ n: number; label: string }> }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ol aria-hidden className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-gray-700 dark:text-gray-300">
      {items.map((it) => (
        <li key={it.n} className="inline-flex items-center gap-1">
          <span className={NUMBER_CLASS}>{it.n}</span>
          {it.label}
        </li>
      ))}
    </ol>
  );
}

/** The arrows as words, for assistive tech. */
export function ArrowList({ label, items }: { label: string; items: ReadonlyArray<{ key: string; text: string }> }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul className="sr-only" aria-label={label}>
      {items.map((it) => (
        <li key={it.key}>{it.text}</li>
      ))}
    </ul>
  );
}

// ── The board ────────────────────────────────────────────────────────────────────────────────────

const NARROW_PX = 760;

export function LaneBoard<L, C>({
  label,
  layout,
  laneWidth,
  renderLane,
  renderCard,
  onToggleColumn,
}: {
  /** The accessible name of the whole board. */
  label: string;
  layout: BoardLayout<L, C>;
  /** The lane-label column's CSS track, e.g. `minmax(8rem, 12rem)`. */
  laneWidth: string;
  renderLane: (lane: BoardLayout<L, C>['lanes'][number]) => ReactNode;
  renderCard: (card: BoardLayout<L, C>['cards'][number], ref: (el: HTMLElement | null) => void) => ReactNode;
  /** Show or hide a collapsible column's cards. */
  onToggleColumn: (id: string) => void;
}): JSX.Element {
  const cells = layout.cards;
  const arrows = layout.arrows;
  // A collapsed column's "n tickets" sits in its lane's first row: an arrow routes round it, never through.
  const occupied = useMemo(() => {
    const colOf = new Map(layout.columns.map((c) => [c.id, c.index]));
    return layout.lanes.flatMap((l) => [...l.hidden.keys()].flatMap((id) => (colOf.has(id) ? [{ row: l.row, col: colOf.get(id)! }] : [])));
  }, [layout.columns, layout.lanes]);
  const { gridRef, cardRef, slotRef, paths, narrow } = useRoutedArrows(cells, arrows, NARROW_PX, occupied);
  const numbers = useMemo(() => new Map(arrows.filter((a) => a.n != null).map((a) => [a.key, a.n!])), [arrows]);
  const critical = useMemo(() => new Set(arrows.filter((a) => a.critical).map((a) => a.key)), [arrows]);
  const col0 = narrow ? 1 : 2;
  // Grid rows (1-based; row 1 is the header). Narrow: each lane gets a band row above its cards.
  const laneIndexOfRow = useMemo(() => {
    const m: number[] = [];
    layout.lanes.forEach((l, i) => {
      for (let r = 0; r < l.span; r += 1) m[l.row + r] = i;
    });
    return m;
  }, [layout.lanes]);
  const gridRow = (logical: number): number => (narrow ? logical + 3 + (laneIndexOfRow[logical] ?? 0) : logical + 2);
  const track = (c: (typeof layout.columns)[number]): string => (c.collapsed ? 'minmax(4.5rem, 6rem)' : 'minmax(6.5rem, 1fr)');
  const template = `${narrow ? '' : `${laneWidth} `}${layout.columns.map(track).join(' ')}`;

  return (
    <div role="group" aria-label={label} className="w-full">
      <div className="w-full overflow-x-auto">
        <div ref={gridRef} className="relative grid gap-x-5 gap-y-1 pb-1 pr-1" style={{ gridTemplateColumns: template }}>
          {/* Lane stripes, under everything: a rule above each lane and a faint ground on every other. */}
          {layout.lanes.map((l, i) => (
            <div
              key={`bg:${l.id}`}
              aria-hidden
              className={`pointer-events-none z-0 border-t border-gray-200 dark:border-gray-800 ${i % 2 === 1 ? 'bg-gray-50/70 dark:bg-gray-900/40' : ''}`}
              style={{ gridRow: narrow ? `${gridRow(l.row) - 1} / span ${l.span + 1}` : `${gridRow(l.row)} / span ${l.span}`, gridColumn: '1 / -1' }}
            />
          ))}

          <ArrowLayer paths={paths} numbers={numbers} critical={critical} />

          {/* Header row: the columns. */}
          {!narrow && <div aria-hidden style={{ gridRow: 1, gridColumn: 1 }} />}
          {layout.columns.map((c) => (
            <div
              key={c.id}
              className="relative z-10 flex min-w-0 flex-wrap items-end gap-x-1.5 self-end pb-1 text-[12px] font-semibold text-gray-800 dark:text-gray-100"
              style={{ gridRow: 1, gridColumn: c.index + col0 }}
            >
              <span className="min-w-0 break-words">{c.name}</span>
              <span className="font-normal text-gray-600 dark:text-gray-300">{c.count}</span>
              {c.collapsible && (
                <button
                  type="button"
                  aria-expanded={!c.collapsed}
                  aria-label={`${c.collapsed ? 'Show' : 'Hide'} ${c.name} tickets`}
                  onClick={() => onToggleColumn(c.id)}
                  className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-medium text-sky-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
                >
                  <ChevronIcon size={10} dir={c.collapsed ? 'right' : 'down'} />
                  {c.collapsed ? 'Show' : 'Hide'}
                </button>
              )}
            </div>
          ))}

          {layout.lanes.map((l) => (
            <Fragment key={l.id}>
              <div
                className={`relative z-10 min-w-0 break-words py-1.5 ${narrow ? '' : 'pr-1'}`}
                style={narrow ? { gridRow: gridRow(l.row) - 1, gridColumn: '1 / -1' } : { gridRow: `${gridRow(l.row)} / span ${l.span}`, gridColumn: 1 }}
              >
                {renderLane(l)}
              </div>
              {[...l.hidden].map(([colId, n]) => {
                const c = layout.columns.find((x) => x.id === colId);
                return c == null ? null : (
                  <div
                    key={`h:${l.id}:${colId}`}
                    className="relative z-10 self-center px-1 text-[11px] text-gray-600 dark:text-gray-300"
                    style={{ gridRow: gridRow(l.row), gridColumn: c.index + col0 }}
                  >
                    {n} {n === 1 ? 'ticket' : 'tickets'}
                  </div>
                );
              })}
            </Fragment>
          ))}

          {/* Cards, row-major, so a screen reader reads each lane across its columns. */}
          {[...cells]
            .sort((a, b) => a.row - b.row || a.col - b.col)
            .map((c) => (
              <div key={c.id} ref={slotRef(c.id)} className="relative z-10 min-w-0 p-1.5" style={{ gridRow: gridRow(c.row), gridColumn: c.col + col0 }}>
                {renderCard(c, cardRef(c.id))}
              </div>
            ))}
        </div>
      </div>
      <ArrowKey items={layout.key} />
      <ArrowList label="Dependencies" items={arrows} />
    </div>
  );
}
