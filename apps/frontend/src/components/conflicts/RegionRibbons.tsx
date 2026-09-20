import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ConflictRegion } from '@pierre-review/shared';
import { ribbonSides, type RibbonSide, type SlotDecision } from '../../lib/mergeResolver.js';
import { FILL_CLASS } from './copy.js';

// ── THE RIBBONS ──────────────────────────────────────────────────────────────────────────────
//
// One filled bezier per side that actually put content into the result, drawn across the gutter
// track from the accepted hunk's near edge to the centre hunk's. It is the FOURTH encoding of a
// state the wash, the centre's 2px rule and the strip's word already carry, which is why it is
// `aria-hidden`: nothing here is available only through the ribbon.
//
// ⚠ IT ONLY EVER READS GEOMETRY. ONE SCROLLER, ONE GRID, FIVE TRACKS (`ResolverPanes`' header,
// `SlotRow`'s header) is what makes the three panes line up with no spacer, no measurement and no
// scroll-sync driver. This overlay never writes `scrollTop`, never calls `focus()`, never gives a
// pane a scroller of its own, and holds NO React state — a scroll frame writes to this SVG's DOM
// and nothing else. The precedent is `Timeline/index.tsx`'s `drawCrossConnectors` /
// `scheduleConnectors`: an imperative SVG built into a `DocumentFragment` and committed with
// `replaceChildren`, rAF-coalesced, `pointer-events: none`.
//
// ⚠ DO NOT BUMP `CONFLICT_MODEL_VERSION` FOR ANYTHING IN THIS FILE. That constant is folded into
// the session's model hash and pins WHAT BYTES A DECISION PRODUCES (`packages/shared`'s
// `conflict-fold.ts`). Drawing a shape over the gutter produces no bytes and changes no fold, so a
// defensive bump here would invalidate every live session — every reader in the middle of a
// resolve would lose their decisions — for a picture.
//
// ⚠ CACHE IN CONTENT COORDINATES. Cell rects are measured once per STRUCTURAL change and stored
// relative to the scroll content, which is scroll-invariant; a scroll frame then reads `scrollTop`
// and `clientHeight` and does arithmetic. Zero `getBoundingClientRect()` calls per frame, so no
// forced layout on a fast scroll through a four-hundred-region file.

const NS = 'http://www.w3.org/2000/svg';

/** A side that contributed a DECISION but no lines — a deletion, or a `theirs_only` region whose
 *  `ours` array is empty — still gets a visible wedge rather than a zero-height nothing. The wedge
 *  is the honest picture: that side answered, it just had no lines to give. */
const MIN_EDGE = 2;

/** One ribbon that should exist, before anything has been measured.
 *  ⚠ NO `fill` FIELD. Every ribbon paints in `FILL_CLASS`, the applied green — see `copy.ts`. A
 *  per-spec colour was the type-hued ribbon this replaced, and carrying a constant through two
 *  interfaces is an invitation to make it vary again. */
interface Spec {
  regionId: number;
  side: RibbonSide;
}

/** One ribbon's measured geometry. `x` is in SVG space (no horizontal scroll), `y` in CONTENT
 *  space — i.e. including `scrollTop`, so it survives every scroll frame untouched. */
interface Measured {
  srcX: number;
  srcTop: number;
  srcBottom: number;
  dstX: number;
  dstTop: number;
  dstBottom: number;
}

interface Geometry {
  headerH: number;
  items: Measured[];
}

export function RegionRibbons({
  scrollerRef,
  fileIndex,
  regions,
  slots,
  narrow,
}: {
  /** The panes' ONE scroller. READ-ONLY here: rects, `scrollTop`, `clientHeight`, and a passive
   *  `scroll` listener. Typed structurally so either ref flavour is assignable. */
  scrollerRef: { current: HTMLDivElement | null };
  /** The open file. Part of every `data-mr-cell` key, so a ribbon can never measure a cell left
   *  behind by the previous file. */
  fileIndex: number;
  regions: readonly ConflictRegion[];
  slots: ReadonlyMap<number, SlotDecision>;
  /** Below `NARROW_PX` the columns stack and there are no gutters to draw across. */
  narrow: boolean;
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const dirtyRef = useRef(true);
  const geomRef = useRef<Geometry | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const specsRef = useRef<readonly Spec[]>([]);
  const narrowRef = useRef(narrow);
  const fileRef = useRef(fileIndex);

  // Which ribbons exist at all. ⚠ THE RULE LIVES IN `mergeResolver.ts`, beside the wash rule it has
  // to agree with, so it is unit-testable and the two cannot drift: a ribbon leaving a side the
  // wash says was turned down would be the two encodings contradicting each other.
  const specs = useMemo<Spec[]>(() => {
    const out: Spec[] = [];
    for (const region of regions) {
      const slot = slots.get(region.id);
      if (slot == null) continue;
      for (const side of ribbonSides(region, slot)) out.push({ regionId: region.id, side });
    }
    return out;
  }, [regions, slots]);

  // ── THE IMPERATIVE HALF ────────────────────────────────────────────────────────────────────
  //
  // Plain functions closing over REFS ONLY, so they are stable for the component's lifetime and no
  // effect has to re-run to pick up a new identity. Nothing below touches React state.

  function hide(): void {
    const svg = svgRef.current;
    if (svg == null) return;
    if (svg.childElementCount > 0) svg.replaceChildren();
    svg.style.display = 'none';
  }

  function span(top: number, bottom: number): [number, number] {
    const h = bottom - top;
    if (h >= MIN_EDGE) return [top, bottom];
    const mid = (top + bottom) / 2;
    return [mid - MIN_EDGE / 2, mid + MIN_EDGE / 2];
  }

  function measure(): void {
    const scroller = scrollerRef.current;
    const specsNow = specsRef.current;
    geomRef.current = null;
    dirtyRef.current = false;
    if (scroller == null || narrowRef.current || specsNow.length === 0) return;

    const sRect = scroller.getBoundingClientRect();
    const scrollTop = scroller.scrollTop;
    const header = scroller.querySelector<HTMLElement>('[data-mr-pane-header]');
    const headerH = header == null ? 0 : header.getBoundingClientRect().height;
    const file = fileRef.current;

    // ⚠ ONE DOM WALK, NOT TWO PER RIBBON. `measure()` runs SYNCHRONOUSLY on every decision (see the
    // effect below), and a file near the four-hundred-region mark with most of it decided reaches
    // eight hundred specs — sixteen hundred attribute `querySelector` walks over tens of thousands
    // of line divs, inside a layout effect, per keystroke. One `querySelectorAll` into a map gives
    // the same rects at the same moment for one walk.
    const cells = new Map<string, HTMLElement>();
    for (const el of scroller.querySelectorAll<HTMLElement>('[data-mr-cell]')) {
      const key = el.dataset.mrCell;
      if (key != null) cells.set(key, el);
    }

    const items: Measured[] = [];
    for (const spec of specsNow) {
      const src = cells.get(`${file}:${spec.regionId}:${spec.side}`);
      const dst = cells.get(`${file}:${spec.regionId}:centre`);
      if (src == null || dst == null) continue;
      const a = src.getBoundingClientRect();
      const b = dst.getBoundingClientRect();
      const [srcTop, srcBottom] = span(
        a.top - sRect.top + scrollTop,
        a.bottom - sRect.top + scrollTop,
      );
      const [dstTop, dstBottom] = span(
        b.top - sRect.top + scrollTop,
        b.bottom - sRect.top + scrollTop,
      );
      items.push({
        // The NEAR edges: a left-pane hunk leaves by its right face and a right-pane hunk by its
        // left, and the centre meets each on the side facing it. `dstX - srcX` is then the gutter
        // track's own width, MEASURED — so a `rem` change or a new track width follows for free.
        srcX: (spec.side === 'left' ? a.right : a.left) - sRect.left,
        dstX: (spec.side === 'left' ? b.left : b.right) - sRect.left,
        srcTop,
        srcBottom,
        dstTop,
        dstBottom,
      });
    }
    geomRef.current = { headerH, items };
  }

  function draw(): void {
    const svg = svgRef.current;
    const scroller = scrollerRef.current;
    const geom = geomRef.current;
    if (svg == null || scroller == null || geom == null || geom.items.length === 0) {
      hide();
      return;
    }
    const scrollTop = scroller.scrollTop;
    const clientH = scroller.clientHeight;
    // The SVG's own top edge, in content coordinates: it starts below the sticky pane headers, so
    // the band they cover is the one place a ribbon can never exist.
    const origin = scrollTop + geom.headerH;
    const bandBottom = scrollTop + clientH;

    const frag = document.createDocumentFragment();
    for (const m of geom.items) {
      // ⚠ THE UNION OF THE TWO BOXES, NOT EITHER ONE. The centre hunk starts lower than its sides
      // (the strip sits above it) and can be several times taller, so testing one end alone drops
      // ribbons that are half on screen. ONE END VISIBLE ⇒ STILL DRAWN: that is what makes the
      // linkage read as glued — it slides off the top edge rather than vanishing when its far end
      // crosses the fold — and `.mr-ribbons`' `overflow: hidden` does the cutting.
      const top = Math.min(m.srcTop, m.dstTop);
      const bottom = Math.max(m.srcBottom, m.dstBottom);
      // `<=` / `>=` so an exactly-touching ribbon, which is a zero-pixel sliver, is skipped.
      if (bottom <= origin || top >= bandBottom) continue;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute(
        'd',
        ribbonPath(
          m.srcX,
          m.srcTop - origin,
          m.srcBottom - origin,
          m.dstX,
          m.dstTop - origin,
          m.dstBottom - origin,
        ),
      );
      path.setAttribute('class', FILL_CLASS);
      frag.appendChild(path);
    }
    if (frag.childElementCount === 0) {
      hide();
      return;
    }
    svg.style.display = 'block';
    svg.style.top = `${geom.headerH}px`;
    svg.style.height = `${Math.max(0, clientH - geom.headerH)}px`;
    svg.replaceChildren(frag);
  }

  function schedule(remeasure: boolean): void {
    if (remeasure) dirtyRef.current = true;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (dirtyRef.current) measure();
      draw();
    });
  }

  // ── THE SUBSCRIPTIONS ──────────────────────────────────────────────────────────────────────
  //
  // ⚠ DECLARED BEFORE THE MEASURE EFFECT ON PURPOSE. Effects in one commit run in declaration
  // order, so this is what puts a live `ResizeObserver` in `roRef` before the first re-target below
  // looks for one.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller == null) return;
    const onScroll = (): void => schedule(false);
    // ⚠ THE RO RE-MEASURES THROUGH THE rAF, NEVER SYNCHRONOUSLY — a draw inside an RO callback can
    // loop. It watches the SCROLLER (viewport height, window resize, the narrow flip) and the GRID
    // (row heights: a wrapped line, the unchanged-region fold, the suggestion panel mounting, a
    // late font or highlight pass).
    const ro = new ResizeObserver(() => schedule(true));
    roRef.current = ro;
    ro.observe(scroller);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      ro.disconnect();
      roRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    specsRef.current = specs;
    narrowRef.current = narrow;
    fileRef.current = fileIndex;

    const scroller = scrollerRef.current;
    const ro = roRef.current;
    // Re-targeted rather than recreated: `activeFile` going null → non-null REPLACES the grid
    // element, so the node observed a moment ago is no longer in the document.
    if (ro != null && scroller != null) {
      ro.disconnect();
      ro.observe(scroller);
      const grid = scroller.querySelector<HTMLElement>('[data-mr-grid]');
      if (grid != null) ro.observe(grid);
    }

    // ⚠ SYNCHRONOUS, NOT THROUGH THE rAF. A decision changes the centre cell's text and therefore
    // every later row's offset; an rAF here would paint one frame of ribbons attached to the rows
    // they used to join, which a reader reads as the linkage slipping. The forced layout is
    // already being paid — a decision re-renders every `SlotRow`.
    measure();
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs, narrow, fileIndex]);

  // The element mounts unconditionally — a stable hook order, and no branch in the parent — and
  // goes dark from the inside in narrow mode.
  return <svg ref={svgRef} className="mr-ribbons" aria-hidden="true" style={{ display: 'none' }} />;
}

/**
 * One ribbon: two cubics joined by the two hunks' facing edges, closed with `Z`.
 *
 * ⚠ EVERY CONTROL POINT SITS AT ITS OWN ENDPOINT'S y, AND THAT IS WHAT KEEPS THE SHAPE SIMPLE.
 * Each edge is then a cubic whose four control y-values are `[y0, y0, y1, y1]`, i.e.
 * `y(t) = y0 + (y1 - y0)·(3t² - 2t³)` — monotone, and by the convex-hull property never leaving
 * `[min(y0,y1), max(y0,y1)]`, so no overshoot. Both edges share `x0`, `x1` and `k`, so they share
 * that blend exactly, and their vertical separation is
 *
 *     y_bot(t) - y_top(t) = (y0b - y0t) + [ (y1b - y1t) - (y0b - y0t) ] · B(t)
 *
 * — a convex combination of two POSITIVE heights, hence positive for every `t`. The two edges
 * cannot cross, whatever the two hunks' heights or how far apart they sit. Pulling a handle
 * vertically to "soften" the curve is exactly what destroys that guarantee.
 */
function ribbonPath(
  x0: number,
  y0t: number,
  y0b: number,
  x1: number,
  y1t: number,
  y1b: number,
): string {
  // Half the gutter, MEASURED, and SIGNED — so the right-hand ribbon's handles lean back toward
  // the centre with no second branch. `x1 === x0` (a zero-width track) degenerates to straight
  // edges, which is harmless and needs no special case.
  const k = (x1 - x0) * 0.5;
  const f = (n: number): string => n.toFixed(1);
  return (
    `M ${f(x0)} ${f(y0t)}` +
    ` C ${f(x0 + k)} ${f(y0t)} ${f(x1 - k)} ${f(y1t)} ${f(x1)} ${f(y1t)}` +
    ` L ${f(x1)} ${f(y1b)}` +
    ` C ${f(x1 - k)} ${f(y1b)} ${f(x0 + k)} ${f(y0b)} ${f(x0)} ${f(y0b)}` +
    ` Z`
  );
}
