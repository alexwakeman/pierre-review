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
  // Drop zero-length runs (an elbow whose two ends share a coordinate).
  const dedup = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
  // …and merge a point that sits on a straight line between its neighbours.
  const clean = dedup.filter((p, i) => {
    if (i === 0 || i === dedup.length - 1) return true;
    const [px, py] = dedup[i - 1]!;
    const [nx, ny] = dedup[i + 1]!;
    return !((px === p[0] && p[0] === nx) || (py === p[1] && p[1] === ny));
  });
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
