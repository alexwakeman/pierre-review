// THE DESIGN GRID'S PURE FOLD (test/designGrid.test.ts; docs/FRONTEND.md § Design diagrams): which
// columns and rows render, where each card sits, which arrows can be drawn, and the words an arrow
// reads as for assistive tech. The component (components/DesignGrid.tsx) only lays this out.
//
//   COLUMNS  the acts, in the order the server stored them (the story as a reader tells it).
//   ROWS     ONLY the layers some cell uses, in DESIGN_LAYER_ORDER — never an empty row.
//   CELLS    one per (act, layer); a second in the same slot (the validator refuses it) is dropped,
//            never stacked. A cell naming an act or layer that is not drawn is dropped too.
//   ARROWS   only between two drawn cells, never a self-loop; anything else is dropped.
import {
  DESIGN_LAYERS,
  DESIGN_LAYER_ORDER,
  type DesignArrow,
  type DesignCell,
  type DesignDiagram,
  type DesignLayer,
  type SequenceDiagramMember,
} from '@pierre-review/shared';

export interface GridCell {
  cell: DesignCell;
  // 0-based, within the rendered grid (header row / column not counted).
  row: number;
  col: number;
}

export interface GridArrow extends DesignArrow {
  // How the arrow reads aloud: "Parse rows (Import, Domain / service) to Reject bad rows (Check, …)".
  text: string;
}

export interface GridLayout {
  acts: DesignDiagram['acts'];
  rows: Array<{ layer: DesignLayer; label: string }>;
  cells: GridCell[];
  arrows: GridArrow[];
}

export function layoutDesign(d: DesignDiagram): GridLayout {
  const actIndex = new Map(d.acts.map((a, i) => [a.id, i]));
  const used = new Set(d.cells.filter((c) => actIndex.has(c.act)).map((c) => c.layer));
  const rows = DESIGN_LAYER_ORDER.filter((l) => used.has(l)).map((layer) => ({ layer, label: DESIGN_LAYERS[layer] }));
  const rowIndex = new Map(rows.map((r, i) => [r.layer, i]));
  const taken = new Set<string>();
  const cells: GridCell[] = [];
  for (const cell of d.cells) {
    const col = actIndex.get(cell.act);
    const row = rowIndex.get(cell.layer);
    if (col == null || row == null) continue;
    const slot = `${row}:${col}`;
    if (taken.has(slot)) continue;
    taken.add(slot);
    cells.push({ cell, row, col });
  }
  const byId = new Map(cells.map((g) => [g.cell.id, g]));
  const where = (g: GridCell): string => `${g.cell.label} (${d.acts[g.col]!.title}, ${rows[g.row]!.label})`;
  const arrows: GridArrow[] = [];
  for (const a of d.arrows) {
    const from = byId.get(a.from);
    const to = byId.get(a.to);
    if (from == null || to == null || from === to) continue;
    arrows.push({ ...a, text: `${where(from)} to ${where(to)}${a.label != null ? `: ${a.label}` : ''}` });
  }
  return { acts: d.acts, rows, cells, arrows };
}

/** The member a story cell's `pr` ref names ('PR2' → members[1]), or null. */
export function memberForRef(ref: string | null, members: readonly SequenceDiagramMember[]): SequenceDiagramMember | null {
  const m = ref != null ? /^PR(\d+)$/i.exec(ref) : null;
  if (m == null) return null;
  return members[Number(m[1]) - 1] ?? null;
}

/** The short text beside a card's change mark. Unchanged cards carry none. */
export const CHANGE_WORD: Record<DesignCell['change'], string | null> = {
  new: 'New',
  changed: 'Changed',
  unchanged: null,
};

export interface ArrowGeometry {
  d: string;
  // Where the label sits.
  lx: number;
  ly: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One card as drawn: its own box, the padded slot around it, and its 0-based grid position. */
export interface PlacedCard {
  card: Box;
  slot: Box;
  row: number;
  col: number;
}

const right = (b: Box): number => b.x + b.w;
const bottom = (b: Box): number => b.y + b.h;
const midX = (b: Box): number => b.x + b.w / 2;
const midY = (b: Box): number => b.y + b.h / 2;

/**
 * One arrow as a RIGHT-ANGLED line that runs only through the space between cards — the padding
 * around each card and the grid's gaps — so it never passes behind another card:
 *
 *   other column   out of the source's side, along its row, down the column gap beside the target,
 *                  into the target's side; when a card sits between them in the source's row, the line
 *                  first drops to the gap below (or above) the source and runs along that instead.
 *   same column    straight down (or up); when a card sits between them, round the column gap to the
 *                  right of both.
 *
 * Ends stop `end` px short of the card so the arrowhead shows. The label point is the middle of the
 * longest straight run (where the numbered marker sits).
 */
export function routeArrow(
  a: PlacedCard,
  b: PlacedCard,
  occupied: (row: number, col: number) => boolean,
  gapX: number,
  gapY: number,
  end = 3,
): ArrowGeometry {
  return geometryOf(routePoints(a, b, occupied, gapX, gapY, end));
}

/** routeArrow's corner points (cleaned: no zero-length runs, no point mid-way along a straight run). */
export function routePoints(
  a: PlacedCard,
  b: PlacedCard,
  occupied: (row: number, col: number) => boolean,
  gapX: number,
  gapY: number,
  end = 3,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  if (a.col !== b.col) {
    const toRight = b.col > a.col;
    const lo = Math.min(a.col, b.col);
    const hi = Math.max(a.col, b.col);
    const xc = toRight ? b.slot.x - gapX / 2 : right(b.slot) + gapX / 2;
    const yT = midY(b.card);
    const entryX = toRight ? b.card.x - end : right(b.card) + end;
    let rowClear = true;
    for (let c = lo + 1; c < hi; c++) if (occupied(a.row, c)) rowClear = false;
    if (rowClear) {
      const y0 = midY(a.card);
      pts.push([toRight ? right(a.card) : a.card.x, y0], [xc, y0], [xc, yT], [entryX, yT]);
    } else {
      const down = b.row >= a.row;
      const yr = down ? bottom(a.slot) + gapY / 2 : a.slot.y - gapY / 2;
      // Leave three quarters of the way toward the target, not the middle: a straight up/down arrow
      // uses the middle, and two lines sharing it read as one arrow from the wrong card.
      const x0 = a.card.x + a.card.w * (toRight ? 0.75 : 0.25);
      pts.push([x0, down ? bottom(a.card) : a.card.y], [x0, yr], [xc, yr], [xc, yT], [entryX, yT]);
    }
  } else {
    const down = b.row > a.row;
    const lo = Math.min(a.row, b.row);
    const hi = Math.max(a.row, b.row);
    let colClear = true;
    for (let r = lo + 1; r < hi; r++) if (occupied(r, a.col)) colClear = false;
    if (colClear) {
      const x = midX(b.card);
      pts.push([x, down ? bottom(a.card) : a.card.y], [x, down ? b.card.y - end : bottom(b.card) + end]);
    } else {
      const xc = right(a.slot) + gapX / 2;
      pts.push([right(a.card), midY(a.card)], [xc, midY(a.card)], [xc, midY(b.card)], [right(b.card) + end, midY(b.card)]);
    }
  }
  return cleanPoints(pts);
}

function cleanPoints(pts: Array<[number, number]>): Array<[number, number]> {
  // Drop zero-length runs (an elbow whose two ends share a coordinate).
  const dedup = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
  // …and merge a point that sits on a straight line between its neighbours.
  return dedup.filter((p, i) => {
    if (i === 0 || i === dedup.length - 1) return true;
    const [px, py] = dedup[i - 1]!;
    const [nx, ny] = dedup[i + 1]!;
    return !((px === p[0] && p[0] === nx) || (py === p[1] && p[1] === ny));
  });
}

/** A path's `d` and its label point: the middle of its longest straight run. */
export function geometryOf(clean: ReadonlyArray<readonly [number, number]>): ArrowGeometry {
  let best = 0;
  let lx = clean[0]![0];
  let ly = clean[0]![1];
  for (let i = 1; i < clean.length; i++) {
    const [x1, y1] = clean[i - 1]!;
    const [x2, y2] = clean[i]!;
    const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    if (len > best) {
      best = len;
      lx = (x1 + x2) / 2;
      ly = (y1 + y2) / 2;
    }
  }
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  const d = clean.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${r1(x)} ${r1(y)}`).join(' ');
  return { d, lx: r1(lx), ly: r1(ly) };
}

/** How far a numbered marker keeps from every OTHER line and marker, px (its radius is ~8). */
const LABEL_CLEAR_PX = 13;

const distToRoute = (x: number, y: number, pts: ReadonlyArray<readonly [number, number]>): number => {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[i + 1]!;
    const cx = Math.max(Math.min(x1, x2), Math.min(Math.max(x1, x2), x));
    const cy = Math.max(Math.min(y1, y2), Math.min(Math.max(y1, y2), y));
    best = Math.min(best, Math.hypot(x - cx, y - cy));
  }
  return best;
};

/**
 * Where each arrow's numbered marker sits: on its own line, as near the middle of its longest run as
 * it can be while staying clear of every OTHER line (so it never hides another arrow's head or
 * corner) and of the markers placed before it. Runs are tried longest first, positions from the
 * middle out; a line with no clear spot keeps the middle of its longest run. Pure.
 */
export function placeArrowLabels(routes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): Array<[number, number]> {
  const placed: Array<[number, number]> = [];
  const FRACTIONS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];
  routes.forEach((pts, i) => {
    const runs: Array<{ a: readonly [number, number]; b: readonly [number, number]; len: number }> = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      runs.push({ a, b, len: Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) });
    }
    runs.sort((r, s) => s.len - r.len);
    const clear = (x: number, y: number): boolean =>
      routes.every((other, j) => j === i || distToRoute(x, y, other) >= LABEL_CLEAR_PX) &&
      placed.every(([px, py]) => Math.hypot(px - x, py - y) >= 2 * LABEL_CLEAR_PX);
    let at: [number, number] | null = null;
    for (const r of runs) {
      if (r.len < 2 * LABEL_CLEAR_PX) continue;
      for (const f of FRACTIONS) {
        const x = r.a[0] + (r.b[0] - r.a[0]) * f;
        const y = r.a[1] + (r.b[1] - r.a[1]) * f;
        if (clear(x, y)) {
          at = [x, y];
          break;
        }
      }
      if (at != null) break;
    }
    if (at == null) {
      const g = geometryOf(pts);
      at = [g.lx, g.ly];
    }
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    placed.push([r1(at[0]), r1(at[1])]);
  });
  return placed;
}

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** How many times two DIFFERENT arrows cross (a run of one passing through a run of another). */
export function crossings(routes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): number {
  type Seg = { r: number; x1: number; y1: number; x2: number; y2: number };
  const v: Seg[] = [];
  const h: Seg[] = [];
  routes.forEach((pts, r) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[i + 1]!;
      const seg = { r, x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
      if (Math.abs(x1 - x2) < 0.5) v.push(seg);
      else if (Math.abs(y1 - y2) < 0.5) h.push(seg);
    }
  });
  let n = 0;
  for (const a of v) for (const b of h) {
    if (a.r === b.r) continue;
    if (a.x1 > b.x1 + 0.5 && a.x1 < b.x2 - 0.5 && b.y1 > a.y1 + 0.5 && b.y1 < a.y2 - 0.5) n++;
  }
  return n;
}

/** The most room two parallel lines get between them, px. */
export const ARROW_TRACK_PX = 17;

/**
 * NO TWO LINES SHARE A RUN. Routed one at a time, arrows into the same column (or along the same row
 * gap) run down the SAME channel and overlap, and nobody can tell which line goes where. This pass
 * finds every straight run that lies on another arrow's run — same x for an up/down run, same y for a
 * sideways one, ranges overlapping — and gives each arrow in that bundle its own parallel TRACK,
 * spread evenly about the channel's centre (`ARROW_TRACK_PX` apart at most, less when the channel —
 * the gap plus the padding either side, `roomX` / `roomY` — is narrow). Moving a run moves its two corners, so the neighbouring runs stretch to meet it and every
 * line stays right-angled. Runs of ONE arrow never bundle with each other. Pure; input is not mutated.
 */
export function separateArrowRuns(
  routes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  roomX: number,
  roomY: number,
): Array<Array<[number, number]>> {
  const out = routes.map((r) => r.map(([x, y]) => [x, y] as [number, number]));
  const pass = (axis: 0 | 1): void => {
    // axis 0: up/down runs (shared x, spread along x); axis 1: sideways runs (shared y, spread along y).
    const other = axis === 0 ? 1 : 0;
    const room = axis === 0 ? roomX : roomY;
    type Run = { route: number; seg: number; at: number; lo: number; hi: number };
    const runs: Run[] = [];
    out.forEach((pts, route) => {
      for (let seg = 0; seg + 1 < pts.length; seg++) {
        const p = pts[seg]!;
        const q = pts[seg + 1]!;
        if (Math.abs(p[axis] - q[axis]) > 0.5) continue; // not a run along this axis
        runs.push({ route, seg, at: p[axis], lo: Math.min(p[other], q[other]), hi: Math.max(p[other], q[other]) });
      }
    });
    runs.sort((r, s) => r.at - s.at || r.lo - s.lo || r.hi - s.hi || r.route - s.route);
    const used = new Set<Run>();
    for (const r of runs) {
      if (used.has(r)) continue;
      // The bundle: every run on this line that overlaps the bundle so far (a chain of overlaps).
      const bundle: Run[] = [r];
      used.add(r);
      let hi = r.hi;
      for (const s of runs) {
        if (used.has(s) || Math.abs(s.at - r.at) > 0.5) continue;
        if (s.lo < hi - 0.5) {
          bundle.push(s);
          used.add(s);
          hi = Math.max(hi, s.hi);
        }
      }
      const routesIn = [...new Set(bundle.map((b) => b.route))];
      if (routesIn.length < 2) continue;
      const step = Math.min(ARROW_TRACK_PX, room > 0 ? room / (routesIn.length + 1) : ARROW_TRACK_PX);
      const apply = (order: readonly number[], sign: 1 | -1): void =>
        order.forEach((route, k) => {
          const shift = sign * (k - (order.length - 1) / 2) * step;
          if (shift === 0) return;
          for (const b of bundle) {
            if (b.route !== route) continue;
            out[route]![b.seg]![axis] += shift;
            out[route]![b.seg + 1]![axis] += shift;
          }
        });
      // WHICH line takes WHICH track: the order with the FEWEST crossings (lines turning out of a
      // bundle in the wrong order cross each other at the turn, often right at an arrowhead). Small
      // bundles try every order; a big one keeps the sorted order.
      let bestOrder = routesIn;
      if (routesIn.length <= 5) {
        let bestCross = Infinity;
        for (const order of permutations(routesIn)) {
          apply(order, 1);
          const c = crossings(out);
          apply(order, -1);
          if (c < bestCross) {
            bestCross = c;
            bestOrder = order;
          }
        }
      }
      apply(bestOrder, 1);
    }
  };
  pass(0);
  pass(1);
  return out;
}

/**
 * The short PR badge per member: `#498` when every member is in one repo, else the repo's own part of
 * its name (`backend #498`, `harness #170` for bng-metric-backend / bng-metric-harness) — the
 * shared prefix says nothing that tells two cards apart, and the full name wrapped in a narrow card.
 */
export function prBadgeTexts(members: readonly SequenceDiagramMember[]): Map<number, string> {
  const names = members.map((m) => m.repo.split('/').pop() ?? m.repo);
  const out = new Map<number, string>();
  if (new Set(names).size <= 1) {
    for (const m of members) out.set(m.prId, `#${m.number}`);
    return out;
  }
  let prefix = names[0] ?? '';
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = prefix.lastIndexOf('-') + 1; // only cut at a word boundary
  for (const [i, m] of members.entries()) {
    const n = names[i]!;
    const short = n.slice(cut) || n;
    out.set(m.prId, `${short} #${m.number}`);
  }
  return out;
}
