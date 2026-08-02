import {
  BUNKER_BITMAP,
  BUNKER_CELL,
  BUNKER_COLS,
  BUNKER_COUNT,
  BUNKER_ROWS,
  BUNKER_TOP_Y,
  bunkerX,
} from './constants';
import type { Bunker } from './types';

// ---------------------------------------------------------------------------
// The four bunkers — "filters", in the game's own vocabulary.
//
// THE ORIGINAL HAS NO BUNKER OBJECT. Its framebuffer IS the bunker: the shields
// are just pixels, and a hole is the explosion sprite AND-NOTed out of them.
// Three consequences fall out of that, and all three are gameplay rather than
// decoration, so all three are reproduced here explicitly:
//
//   1. the player's own fire destroys the shields from beneath — the shield is
//      not "yours", it is in the way of both sides;
//   2. the two hole shapes DIFFER, because the two explosion sprites differ;
//   3. the descending rack ERASES shield material, because aliens are blitted
//      with STORE rather than OR. That is why a wave you fail to clear eventually
//      has nothing left to hide behind.
//
// We keep an explicit cell grid instead of a 1-bit framebuffer (the game draws to
// a scaled canvas that render.ts owns, and reading pixels back would couple the
// simulation to the painter). A cell is BUNKER_CELL units square, so a bunker is
// 28 × 8 cells = 112 × 32 units, and erosion is the clearing of cells inside an
// ellipse rather than the subtraction of a sprite. The observable behaviour —
// holes that widen from the middle, an arch that collapses, a shield that
// eventually reads as rubble — is the same.
//
// The grid is a Uint8Array rather than booleans because it is rewritten in place
// on every wave and read on every frame; row-major, 1 = solid, 0 = eroded.
// ---------------------------------------------------------------------------

/** Write the pristine bitmap into an existing cell buffer. */
function paintPristine(b: Bunker): void {
  for (let cy = 0; cy < b.rows; cy += 1) {
    const row = BUNKER_BITMAP[cy] ?? '';
    for (let cx = 0; cx < b.cols; cx += 1) {
      b.cells[cy * b.cols + cx] = row[cx] === 'x' ? 1 : 0;
    }
  }
}

/** Four pristine bunkers positioned for a world of `width`. */
export function createBunkers(width: number): Bunker[] {
  const out: Bunker[] = [];
  for (let i = 0; i < BUNKER_COUNT; i += 1) {
    const b: Bunker = {
      x: bunkerX(width, i),
      y: BUNKER_TOP_Y,
      cols: BUNKER_COLS,
      rows: BUNKER_ROWS,
      cells: new Uint8Array(BUNKER_COLS * BUNKER_ROWS),
    };
    paintPristine(b);
    out.push(b);
  }
  return out;
}

/**
 * Restore every cell of every bunker, in place.
 *
 * Called at the START OF EVERY WAVE and at no other time. Bunkers deliberately
 * PERSIST ACROSS DEATHS: losing a life while your shields are gone is the
 * position the original puts you in, and rebuilding them on respawn would remove
 * the cost of having shot through them yourself.
 */
export function resetBunkers(bunkers: Bunker[]): void {
  for (const b of bunkers) paintPristine(b);
}

/** Inclusive cell index range of `[lo, hi)` in field units along one axis. */
function cellSpan(origin: number, lo: number, hi: number, count: number): [number, number] {
  const first = Math.floor((lo - origin) / BUNKER_CELL);
  const last = Math.ceil((hi - origin) / BUNKER_CELL) - 1;
  return [Math.max(0, first), Math.min(count - 1, last)];
}

/** Is any solid cell of `b` inside the axis-aligned rect? Cheap, no allocation. */
export function bunkerHits(b: Bunker, x: number, y: number, w: number, h: number): boolean {
  const [cx0, cx1] = cellSpan(b.x, x, x + w, b.cols);
  const [cy0, cy1] = cellSpan(b.y, y, y + h, b.rows);
  for (let cy = cy0; cy <= cy1; cy += 1) {
    const base = cy * b.cols;
    for (let cx = cx0; cx <= cx1; cx += 1) {
      if (b.cells[base + cx]) return true;
    }
  }
  return false;
}

/**
 * Clear an ellipse of cells centred on the FIELD-space point (x, y).
 *
 * `rx` / `ry` are radii in CELLS, not units — EROSION_PLAYER for the player's own
 * fire, EROSION_ALIEN for theirs. Returns the number of cells actually removed,
 * which is how the caller tells "I hit shield" from "I hit a hole in the shield"
 * without a second query.
 */
export function erodeBunker(b: Bunker, x: number, y: number, rx: number, ry: number): number {
  const cx0 = (x - b.x) / BUNKER_CELL;
  const cy0 = (y - b.y) / BUNKER_CELL;
  const first = Math.max(0, Math.floor(cx0 - rx));
  const last = Math.min(b.cols - 1, Math.ceil(cx0 + rx));
  const top = Math.max(0, Math.floor(cy0 - ry));
  const bottom = Math.min(b.rows - 1, Math.ceil(cy0 + ry));

  let removed = 0;
  for (let cy = top; cy <= bottom; cy += 1) {
    const dy = (cy + 0.5 - cy0) / ry;
    const base = cy * b.cols;
    for (let cx = first; cx <= last; cx += 1) {
      const dx = (cx + 0.5 - cx0) / rx;
      if (dx * dx + dy * dy > 1) continue;
      if (b.cells[base + cx]) {
        b.cells[base + cx] = 0;
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * "Aliens are blitted with STORE, not OR" — clear every bunker cell whose CENTRE
 * lies inside the rect.
 *
 * Called for each live alien's rack cell after a rack drop. This is not a
 * special case bolted on for drama: it is the direct translation of the
 * original's blit, and it is the reason a wave that outlives your fire ends with
 * you standing in the open.
 */
export function eraseBunkerRect(b: Bunker, x: number, y: number, w: number, h: number): void {
  const [cx0, cx1] = cellSpan(b.x, x, x + w, b.cols);
  const [cy0, cy1] = cellSpan(b.y, y, y + h, b.rows);
  for (let cy = cy0; cy <= cy1; cy += 1) {
    const centreY = b.y + cy * BUNKER_CELL + BUNKER_CELL / 2;
    if (centreY < y || centreY >= y + h) continue;
    const base = cy * b.cols;
    for (let cx = cx0; cx <= cx1; cx += 1) {
      const centreX = b.x + cx * BUNKER_CELL + BUNKER_CELL / 2;
      if (centreX < x || centreX >= x + w) continue;
      b.cells[base + cx] = 0;
    }
  }
}
