// THE LANE BOARD (docs/FRONTEND.md § Activity → This Sprint): columns across, lanes down, one card per
// slot, right-angled arrows through the gaps. ONE renderer for This Sprint's three views (Critical path,
// Theme, People); the pure layout is lib/laneBoard.ts. Its arrow pieces — the router hook, the arrow
// layer with its numbered markers, the key and the sr-only list — are SHARED with the design grid
// (components/DesignGrid.tsx), so the two read as one design.
//
//   LAYOUT   a CSS grid: a lane-label column + one column per board column. A collapsed (Complete)
//            column is narrow and shows counts; "Show" opens the whole column, and a lane's own
//            "n tickets" opens that lane's cell only ("Hide" folds it again). NARROW (< NARROW_PX): the lane label
//            moves to a band heading above the lane's cards, as the design grid's layer names do. Below
//            the columns' minimum widths the board scrolls inside its own box (snapping to columns),
//            never the page. A PHONE gets `StackedLaneBoard` instead: lanes down, each lane's columns
//            down, the arrows as a visible numbered list (the redesign; docs/redesign/DESIGN.md § 6).
//   ARROWS   routed by lib/designGrid.ts `routeArrow` through the padding round each card and the grid's
//            gaps, re-measured by a ResizeObserver. A critical arrow is drawn in the accent. A labelled
//            arrow carries a number, keyed below the board. HOVERING an arrow's line or its number (or
//            focusing the number) shows what the arrow means in a popover beside the number, on the
//            side that covers the fewest cards (lib/avoidRects.ts); it closes
//            when the pointer leaves. No click, no pin. The numbers are in the tab order. The same
//            arrows are also an sr-only list.
import { createContext, Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { autoUpdate, FloatingPortal, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react';
import { avoidRects } from '../lib/avoidRects.js';
import { HOVER_PANEL_CLASS } from './HoverPopover.js';
import { geometryOf, placeArrowLabels, routePoints, separateArrowRuns, type ArrowGeometry, type PlacedCard } from '../lib/designGrid.js';
import type { BoardLayout } from '../lib/laneBoard.js';
import { ArrowIcon, ChevronIcon } from './Icons.js';
import { cx, FOCUS_RING } from './ui/cx.js';
import { useIsPhone } from './ui/media.js';

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
  /** Every card's box on screen now (viewport coordinates) — what a popover should not cover. */
  cardRects: () => DOMRect[];
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
    const keys: string[] = [];
    const routes: Array<Array<[number, number]>> = [];
    let padX = 0;
    let padY = 0;
    let minCardH = Infinity;
    for (const a of arrows) {
      const from = placed(a.from);
      const to = placed(a.to);
      if (from == null || to == null) continue;
      keys.push(a.key);
      padX = Math.max(padX, from.card.x - from.slot.x);
      padY = Math.max(padY, from.card.y - from.slot.y);
      minCardH = Math.min(minCardH, from.card.h, to.card.h);
      routes.push(routePoints(from, to, (r, c) => taken.has(`${r}:${c}`), gapX, gapY));
    }
    // Lines that would share a run get their own parallel tracks (lib/designGrid.ts separateArrowRuns).
    // Sideways runs are mostly the ENTRIES into a card's side, which have the card's height to spread
    // over — so two arrowheads meeting at one box land well apart, not only the row gap's width.
    const roomY = Math.max(gapY + 2 * padY - 4, Number.isFinite(minCardH) ? minCardH * 0.5 : 0);
    const separated = separateArrowRuns(routes, gapX + 2 * padX - 4, roomY);
    // …and each numbered marker sits clear of every other line, so it never hides an arrowhead.
    const labels = placeArrowLabels(separated);
    const next: RoutedPath[] = separated.map((pts, i) => ({
      ...geometryOf(pts),
      lx: labels[i]![0],
      ly: labels[i]![1],
      key: keys[i]!,
    }));
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
  const cardRects = useCallback(() => [...cards.current.values()].map((el) => el.getBoundingClientRect()), []);
  return { gridRef, cardRef, slotRef, paths, narrow, cardRects };
}

const NO_RECTS = (): DOMRect[] => [];

/** The board's card boxes, for a popover inside a lane header to keep clear of (LaneBoard provides it). */
const ObstaclesContext = createContext<() => readonly DOMRect[]>(NO_RECTS);
export const useBoardObstacles = (): (() => readonly DOMRect[]) => useContext(ObstaclesContext);

/** The numbered marker on an arrow and in its key. */
const NUMBER_CLASS =
  'flex h-4 min-w-4 items-center justify-center rounded-full ring-1 ring-ui-line px-0.5 text-meta font-semibold leading-none';

/** What an arrow means, for its popover: the keyed words and the full sentence. */
export interface ArrowDetail {
  label: string | null;
  text: string;
}

/** The arrows under the cards, and the numbered markers on top of the labelled ones. Inside the grid. */
export function ArrowLayer({
  paths,
  numbers,
  critical,
  details,
  avoid = NO_RECTS,
}: {
  paths: readonly RoutedPath[];
  /** Arrow key → its number, for the labelled arrows. */
  numbers: ReadonlyMap<string, number>;
  /** Arrow keys drawn in the accent. */
  critical?: ReadonlySet<string>;
  /** Arrow key → what it means. An arrow with no entry shows no popover. */
  details?: ReadonlyMap<string, ArrowDetail>;
  /** The boxes a popover should not cover (the hook's `cardRects`). */
  avoid?: () => readonly DOMRect[];
}): JSX.Element {
  const id = useId().replace(/:/g, '');
  const plain = `${id}-a`;
  const accent = `${id}-c`;
  // The arrow whose LINE the pointer is over (its popover shows at its marker while it stays there).
  const [lineHover, setLineHover] = useState<string | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const onShown = useCallback((key: string, open: boolean) => {
    setShown((prev) => {
      if (prev.has(key) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => () => {
    if (leaveTimer.current != null) clearTimeout(leaveTimer.current);
  }, []);
  const enterLine = (key: string): void => {
    if (leaveTimer.current != null) clearTimeout(leaveTimer.current);
    setLineHover(key);
  };
  const leaveLine = (): void => {
    if (leaveTimer.current != null) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setLineHover(null), 150);
  };
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
          const lit = shown.has(p.key) || lineHover === p.key;
          return (
            <g key={p.key}>
              <path
                d={p.d}
                fill="none"
                stroke="currentColor"
                className={on ? 'text-ai-signal-fill' : lit ? 'text-gray-800 dark:text-gray-100' : undefined}
                strokeWidth={(on ? 2.25 : 1.75) + (lit ? 1 : 0)}
                strokeLinejoin="round"
                strokeLinecap="round"
                markerEnd={`url(#${on ? accent : plain})`}
              />
              {details?.has(p.key) === true && (
                // A wide invisible stroke: the line's hover target (a 1.75px line is too thin to hit).
                <path
                  d={p.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  style={{ pointerEvents: 'stroke' }}
                  onMouseEnter={() => enterLine(p.key)}
                  onMouseLeave={leaveLine}
                />
              )}
            </g>
          );
        })}
      </svg>
      {/* A labelled arrow carries a small NUMBER on top of the line, keyed below: a gap between two
          cards is ~20px, too narrow for words, and a label there covered card text. An arrow with a
          detail but no number still gets an invisible anchor, so hovering its line shows the popover. */}
      {paths.map((p) => {
        const n = numbers.get(p.key) ?? null;
        const detail = details?.get(p.key);
        if (detail == null) {
          return n == null ? null : (
            <span
              key={`l:${p.key}`}
              aria-hidden
              className={`pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 bg-ui-bg text-ui-ink ${NUMBER_CLASS}`}
              style={{ left: p.lx, top: p.ly }}
            >
              {n}
            </span>
          );
        }
        return (
          <ArrowMarker
            key={`l:${p.key}`}
            n={n}
            x={p.lx}
            y={p.ly}
            detail={detail}
            lineHovered={lineHover === p.key}
            avoid={avoid}
            onShown={(open) => onShown(p.key, open)}
          />
        );
      })}
    </>
  );
}

/**
 * One arrow's number and its popover. Hover or focus shows it, beside the number on the side that covers
 * the fewest cards; it closes as soon as the pointer leaves (the panel takes no pointer, so it cannot
 * hold itself open) or focus moves on. Escape closes it. No click, no pin.
 */
function ArrowMarker({
  n,
  x,
  y,
  detail,
  lineHovered,
  avoid,
  onShown,
}: {
  n: number | null;
  x: number;
  y: number;
  detail: ArrowDetail;
  lineHovered: boolean;
  avoid: () => readonly DOMRect[];
  onShown: (open: boolean) => void;
}): JSX.Element {
  const [transient, setTransient] = useState(false);
  const open = transient || lineHovered;
  const popId = useId();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setTransient,
    strategy: 'fixed',
    middleware: [avoidRects(avoid)],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { delay: { open: 60, close: 80 } });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  useEffect(() => onShown(open), [open, onShown]);

  const name = n != null ? `Dependency ${n}${detail.label != null ? `: ${detail.label}` : ''}` : detail.label ?? 'Dependency';
  return (
    <>
      {n != null ? (
        <span
          ref={refs.setReference}
          tabIndex={0}
          role="img"
          {...getReferenceProps()}
          aria-label={name}
          aria-describedby={open ? popId : undefined}
          className={`absolute z-20 -translate-x-1/2 -translate-y-1/2 cursor-default bg-ui-bg text-ui-ink hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${NUMBER_CLASS}`}
          style={{ left: x, top: y }}
        >
          {n}
        </span>
      ) : (
        // No number: an invisible anchor at the arrow's label point, so the line's hover has a place to show.
        <span ref={refs.setReference} aria-hidden className="pointer-events-none absolute h-0 w-0" style={{ left: x, top: y }} />
      )}
      {open && (
        <FloatingPortal>
          <div ref={refs.setFloating} id={popId} style={floatingStyles} {...getFloatingProps()} className={HOVER_PANEL_CLASS}>
            {/* The sentence usually ends with the keyed words; a heading repeating them says it twice. */}
            {detail.label != null && !detail.text.includes(detail.label) ? (
              <>
                <p className="flex items-center gap-1.5 font-semibold">
                  {n != null && <span className={NUMBER_CLASS}>{n}</span>}
                  {detail.label}
                </p>
                <p className="mt-1 text-gray-700 dark:text-gray-300">{detail.text}</p>
              </>
            ) : (
              <p className="flex items-start gap-1.5">
                {n != null && <span className={`mt-px shrink-0 ${NUMBER_CLASS}`}>{n}</span>}
                <span>{detail.text}</span>
              </p>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** The one-line key under a board: each number and its words. Visual only (the sr-only list says it). */
export function ArrowKey({ items }: { items: ReadonlyArray<{ n: number; label: string }> }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ol aria-hidden className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-ui-mute">
      {items.map((it) => (
        <li key={it.n} className="inline-flex items-center gap-1">
          <span className={NUMBER_CLASS}>{it.n}</span>
          {it.label}
        </li>
      ))}
    </ol>
  );
}

/** One entry of a `BorderKey`: a swatch drawn from the CARD'S OWN border classes (so the key can never
 *  drift from the cards), or a dot, and its words. */
export interface BorderKeyItem {
  key: string;
  label: string;
  /** The card's own border classes, for a card-shaped swatch. */
  swatch?: string;
  /** Classes for a small round dot instead. */
  dot?: string;
  /** An icon from Icons.tsx instead (This Sprint's card marks: the route, the hourglass). */
  icon?: ReactNode;
}

/**
 * THE KEY TO THE CARD BORDERS, under a grid — ONE component for This Sprint's lane boards and the
 * design grid (components/DesignGrid.tsx), beside `ArrowKey`, so the two draw their keys one way. The
 * caller lists ONLY the styles its cards actually draw. A real labelled list (the swatches are
 * decorative): it is visible on the surface because it NAMES marks; the explanation stays behind the
 * heading's ⓘ. ⚠ The same border means different things on the two surfaces (dashed accent = waiting
 * on the sprint board, Changed on the design grid), which is why each draws its own key.
 */
export function BorderKey({
  items,
  label = 'Card borders',
  testId,
}: {
  items: ReadonlyArray<BorderKeyItem>;
  label?: string;
  testId?: string;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} data-testid={testId} className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-ui-mute">
      {items.map((it) => (
        <li key={it.key} className="inline-flex items-center gap-1.5">
          {it.icon != null ? (
            <span aria-hidden className="flex shrink-0">
              {it.icon}
            </span>
          ) : it.dot != null ? (
            <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${it.dot}`} />
          ) : (
            <span aria-hidden className={`inline-block h-3.5 w-6 shrink-0 rounded-ui ${it.swatch ?? ''}`} />
          )}
          {it.label}
        </li>
      ))}
    </ul>
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

/** The board's props (the grid on a wide screen, the stacked list on a phone). */
interface LaneBoardProps<L, C> {
  /** The accessible name of the whole board. */
  label: string;
  layout: BoardLayout<L, C>;
  /** The lane-label column's CSS track, e.g. `minmax(8rem, 12rem)`. */
  laneWidth: string;
  renderLane: (lane: BoardLayout<L, C>['lanes'][number]) => ReactNode;
  renderCard: (card: BoardLayout<L, C>['cards'][number], ref: (el: HTMLElement | null) => void) => ReactNode;
  /** Show or hide a collapsible column's cards. */
  onToggleColumn: (id: string) => void;
  /** Show or hide ONE lane's cards in a collapsed column (its "n tickets"). Absent = a plain count. */
  onToggleCell?: (laneId: string, columnId: string) => void;
  /** A key drawn under the board, before the arrows' key (e.g. the card marks). */
  legend?: ReactNode;
}

/** The quiet link-like toggle a column header and a collapsed cell use ("Show", "2 tickets"). */
const TOGGLE_CLASS = `inline-flex items-center gap-0.5 rounded-ui px-1 text-meta font-medium text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:min-h-10 ${FOCUS_RING}`;

export function LaneBoard<L, C>(props: LaneBoardProps<L, C>): JSX.Element {
  // A PHONE stacks the board (lanes down, then each lane's columns down) — a five-column grid at
  // 390px left every card a sliver. Every fact survives: the arrows become a visible numbered list.
  const phone = useIsPhone();
  return phone ? <StackedLaneBoard {...props} /> : <GridLaneBoard {...props} />;
}

function GridLaneBoard<L, C>({ label, layout, laneWidth, renderLane, renderCard, onToggleColumn, onToggleCell, legend }: LaneBoardProps<L, C>): JSX.Element {
  const cells = layout.cards;
  const arrows = layout.arrows;
  // A collapsed column's "n tickets" (or an opened cell's "Hide") sits in its lane's first row: an arrow
  // routes round it, never through.
  const occupied = useMemo(() => {
    const colOf = new Map(layout.columns.map((c) => [c.id, c.index]));
    return layout.lanes.flatMap((l) =>
      [...l.hidden.keys(), ...l.opened.keys()].flatMap((id) => (colOf.has(id) ? [{ row: l.row, col: colOf.get(id)! }] : [])),
    );
  }, [layout.columns, layout.lanes]);
  const { gridRef, cardRef, slotRef, paths, narrow, cardRects } = useRoutedArrows(cells, arrows, NARROW_PX, occupied);
  const numbers = useMemo(() => new Map(arrows.filter((a) => a.n != null).map((a) => [a.key, a.n!])), [arrows]);
  const details = useMemo(() => new Map(arrows.map((a) => [a.key, { label: a.label, text: a.text }])), [arrows]);
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
  const track = (c: (typeof layout.columns)[number]): string => (c.collapsed && !c.widened ? 'minmax(4.5rem, 6rem)' : narrow ? 'minmax(9rem, 1fr)' : 'minmax(7.5rem, 1fr)');
  const template = `${narrow ? '' : `${laneWidth} `}${layout.columns.map(track).join(' ')}`;

  return (
    <ObstaclesContext.Provider value={cardRects}>
    <div role="group" aria-label={label} className="w-full">
      <div className={cx('w-full overflow-x-auto', narrow && 'snap-x snap-proximity')}>
        <div ref={gridRef} className={cx('relative grid gap-y-1 pb-1 pr-1', narrow ? 'gap-x-8' : 'gap-x-12')} style={{ gridTemplateColumns: template }}>
          {/* Lane rules, under everything: a hairline above each lane (no zebra ground — the cards
              are the raised tone, the lanes are the page). */}
          {layout.lanes.map((l) => (
            <div
              key={`bg:${l.id}`}
              aria-hidden
              className="pointer-events-none z-0 border-t border-ui-line/70"
              style={{ gridRow: narrow ? `${gridRow(l.row) - 1} / span ${l.span + 1}` : `${gridRow(l.row)} / span ${l.span}`, gridColumn: '1 / -1' }}
            />
          ))}

          <ArrowLayer paths={paths} numbers={numbers} critical={critical} details={details} avoid={cardRects} />

          {/* Header row: the columns. */}
          {!narrow && <div aria-hidden style={{ gridRow: 1, gridColumn: 1 }} />}
          {layout.columns.map((c) => (
            <div
              key={c.id}
              className="relative z-10 flex min-w-0 snap-start flex-wrap items-end gap-x-1.5 self-end pb-1.5 text-body font-medium text-ui-ink"
              style={{ gridRow: 1, gridColumn: c.index + col0 }}
            >
              <span className="min-w-0 break-words">{c.name}</span>
              <span className="text-meta font-normal tabular-nums text-ui-faint">{c.count}</span>
              {c.collapsible && (
                <button
                  type="button"
                  aria-expanded={!c.collapsed}
                  aria-label={`${c.collapsed ? 'Show' : 'Hide'} ${c.name} tickets`}
                  onClick={() => onToggleColumn(c.id)}
                  className={TOGGLE_CLASS}
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
                className={`relative z-10 min-w-0 break-words py-2.5 ${narrow ? '' : 'pr-1'}`}
                style={narrow ? { gridRow: gridRow(l.row) - 1, gridColumn: '1 / -1' } : { gridRow: `${gridRow(l.row)} / span ${l.span}`, gridColumn: 1 }}
              >
                {renderLane(l)}
              </div>
              {[...[...l.hidden].map(([colId, n]) => ({ colId, n, open: false })), ...[...l.opened].map(([colId, n]) => ({ colId, n, open: true }))].map(
                ({ colId, n, open }) => {
                  const c = layout.columns.find((x) => x.id === colId);
                  if (c == null) return null;
                  return (
                    <div
                      key={`h:${l.id}:${colId}`}
                      className="relative z-10 self-center px-1 text-meta text-ui-mute"
                      style={{ gridRow: gridRow(l.row), gridColumn: c.index + col0 }}
                    >
                      <CellToggle n={n} open={open} column={c.name} lane={l.label} onToggle={onToggleCell == null ? null : () => onToggleCell(l.id, colId)} />
                    </div>
                  );
                },
              )}
            </Fragment>
          ))}

          {/* Cards, row-major, so a screen reader reads each lane across its columns. */}
          {[...cells]
            .sort((a, b) => a.row - b.row || a.col - b.col)
            .map((c) => (
              <div key={c.id} ref={slotRef(c.id)} className="relative z-10 flex min-w-0 flex-col p-1.5" style={{ gridRow: gridRow(c.row), gridColumn: c.col + col0 }}>
                {renderCard(c, cardRef(c.id))}
              </div>
            ))}
        </div>
      </div>
      {legend}
      <ArrowKey items={layout.key} />
      <ArrowList label="Dependencies" items={arrows} />
    </div>
    </ObstaclesContext.Provider>
  );
}

/** A collapsed column's per-lane "n tickets" (or "Hide" once opened). `onToggle` null = a plain count. */
function CellToggle({ n, open, column, lane, onToggle }: { n: number; open: boolean; column: string; lane: string; onToggle: (() => void) | null }): JSX.Element {
  const words = `${n} ${n === 1 ? 'ticket' : 'tickets'}`;
  if (onToggle == null) return <>{words}</>;
  return (
    <button type="button" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${words} in ${column} for ${lane}`} onClick={onToggle} className={TOGGLE_CLASS}>
      <ChevronIcon size={10} dir={open ? 'down' : 'right'} />
      {open ? 'Hide' : words}
    </button>
  );
}

const NO_REF = (): void => {};

/**
 * THE PHONE BOARD: each lane is a section (its header, then one block per column that holds its
 * cards: "In progress 2" over the cards, two to a row). A collapsed column keeps its per-lane
 * "n tickets" toggle, and its header toggle moves to a "Complete 3 · Show" line above the board. The
 * ARROWS cannot be routed through a stack, so they become a VISIBLE list under the board (every
 * arrow's full sentence, numbered as on the wide board; the cards still wear the waiting mark).
 */
function StackedLaneBoard<L, C>({ label, layout, renderLane, renderCard, onToggleColumn, onToggleCell, legend }: LaneBoardProps<L, C>): JSX.Element {
  const collapsible = layout.columns.filter((c) => c.collapsible);
  const byLane = useMemo(
    () =>
      layout.lanes.map((l) => {
        const own = layout.cards.filter((c) => c.row >= l.row && c.row < l.row + l.span);
        const cols = layout.columns
          .map((col) => ({
            col,
            cards: own.filter((c) => c.col === col.index).sort((a, b) => a.row - b.row),
            hidden: l.hidden.get(col.id) ?? null,
            opened: l.opened.get(col.id) ?? null,
          }))
          .filter((x) => x.cards.length > 0 || x.hidden != null);
        return { lane: l, cols };
      }),
    [layout],
  );
  const deps = layout.arrows;
  return (
    <div role="group" aria-label={label} data-layout="stacked" className="w-full">
      {collapsible.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 pb-1 text-meta text-ui-mute">
          {collapsible.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1">
              {c.name} <span className="tabular-nums text-ui-faint">{c.count}</span>
              <button
                type="button"
                aria-expanded={!c.collapsed}
                aria-label={`${c.collapsed ? 'Show' : 'Hide'} ${c.name} tickets`}
                onClick={() => onToggleColumn(c.id)}
                className={TOGGLE_CLASS}
              >
                <ChevronIcon size={10} dir={c.collapsed ? 'right' : 'down'} />
                {c.collapsed ? 'Show' : 'Hide'}
              </button>
            </span>
          ))}
        </p>
      )}
      {byLane.map(({ lane, cols }) => (
        <section key={lane.id} aria-label={lane.label} className="space-y-3 border-t border-ui-line/70 py-3">
          <div>{renderLane(lane)}</div>
          {cols.map(({ col, cards, hidden, opened }) => (
            <div key={col.id} className="space-y-1.5">
              <p className="flex min-h-6 items-center gap-1.5 text-meta font-medium text-ui-mute">
                {col.name}
                <span className="font-normal tabular-nums text-ui-faint">{cards.length > 0 ? cards.length : hidden}</span>
                {hidden != null && (
                  <CellToggle n={hidden} open={false} column={col.name} lane={lane.label} onToggle={onToggleCell == null ? null : () => onToggleCell(lane.id, col.id)} />
                )}
                {opened != null && (
                  <CellToggle n={opened} open column={col.name} lane={lane.label} onToggle={onToggleCell == null ? null : () => onToggleCell(lane.id, col.id)} />
                )}
              </p>
              {cards.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {cards.map((c) => (
                    <div key={c.id} className="flex min-w-0 flex-col">
                      {renderCard(c, NO_REF)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
      {legend}
      {deps.length > 0 && (
        <div className="pt-3">
          <p className="text-meta font-medium text-ui-mute">Dependencies</p>
          <ol aria-hidden className="mt-1 space-y-1.5 text-meta text-ui-mute">
            {deps.map((a) => (
              <li key={a.key} className="flex items-start gap-1.5">
                {a.n != null ? (
                  <span className={`mt-px shrink-0 ${NUMBER_CLASS}`}>{a.n}</span>
                ) : (
                  <span className="mt-px flex w-4 shrink-0 justify-center">
                    <ArrowIcon size={11} />
                  </span>
                )}
                <span className={a.critical ? 'text-ui-ink' : undefined}>{a.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <ArrowList label="Dependencies" items={deps} />
    </div>
  );
}
