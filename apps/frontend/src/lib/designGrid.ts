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

/**
 * One arrow's path between two card rectangles (relative to the grid): horizontal when the cards are
 * side by side, vertical when stacked, a gentle S-curve otherwise. Ends stop a few pixels short of the
 * card so the arrowhead shows.
 */
export function arrowPath(a: Box, b: Box, gap = 3): ArrowGeometry {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const sideBySide = a.x + a.w <= b.x || b.x + b.w <= a.x;
  if (sideBySide) {
    const right = bcx > acx;
    const x1 = right ? a.x + a.w : a.x;
    const x2 = right ? b.x - gap : b.x + b.w + gap;
    const y1 = acy;
    const y2 = bcy;
    const mx = (x1 + x2) / 2;
    return { d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, lx: mx, ly: (y1 + y2) / 2 };
  }
  const down = bcy > acy;
  const y1 = down ? a.y + a.h : a.y;
  const y2 = down ? b.y - gap : b.y + b.h + gap;
  const x1 = acx;
  const x2 = bcx;
  const my = (y1 + y2) / 2;
  return { d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: my };
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
