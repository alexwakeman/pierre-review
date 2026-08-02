import { SPRITES } from '../lib/sprites';
import type { SpriteData } from '../lib/sprites';
import type { Alien, AlienShot, Bunker, World } from './types';
import {
  ALIEN_CELL,
  ALIEN_CELL_H,
  ALIEN_CELL_W,
  ALIEN_SHOT_H,
  ALIEN_SHOT_W,
  BEAM_FLASH_H,
  BUNKER_CELL,
  CRAFT_CELL,
  CRAFT_Y,
  DECOY_W,
  GROUND_Y,
  GUTTER_H,
  GUTTER_MARK_CELL,
  GUTTER_MARK_GAP,
  GUTTER_MAX_MARKS,
  GUTTER_PAD_X,
  NOTEBOOK_OPACITY,
  PLAYER_SHOT_H,
  PLAYER_SHOT_W,
  SAUCER_CELL,
  SAUCER_SPRITE,
} from './constants';

// ---------------------------------------------------------------------------
// The play-field painter — Inked register.
//
// This module is a PURE FUNCTION OF THE WORLD. It never mutates, never reads a
// clock, never touches the DOM beyond the 2D context it is handed, and — the one
// rule worth stating twice — IT NEVER DRAWS TEXT. Every word in the cabinet is a
// real DOM node so it is selectable, translatable, reachable by a screen reader
// and present in the prerendered HTML. A canvas renders as nothing to all four.
//
// THE CANVAS IS TRANSPARENT. paintField() opens with clearRect, never a paper
// fill, because the field's diagonal hatch is a CSS background-image on the div
// underneath (repeating-linear-gradient(135deg, #F4F4EF 0 6px, #FAFAF8 6px 12px)).
// Painting paper here would erase it.
//
// NO SCANLINE OVERLAY. Scanlines belong to the black cabinet (toolkit layouts A
// and C); layout B has no such element and the hatch IS its texture. Do not add
// one "for consistency".
//
// PIXEL DISCIPLINE. Sprites are blitted as one fillRect per coalesced horizontal
// run at an INTEGER cell size, with every origin rounded to a whole logical unit
// (craft.x is fractional — playerSpeed is width/180 — so rounding is not
// optional). imageSmoothingEnabled is switched off; the caller has already
// applied setTransform(dpr,0,0,dpr,0,0), so one logical unit is one CSS pixel
// here and the backing store is an integer multiple of it.
//
// EFFECTS BUDGET IS FOUR, TOTAL: the hit-palette swap, the burst bitmap, the
// one-tick beam flash, and the focus-charge rules. No particles, no bloom, no
// screen shake, no trails.
//
// STATE IS NEVER SIGNALLED BY COLOUR ALONE. A damaged email loses its lid row
// (silhouette); boss decoys are half-width and dashed (silhouette); the focus
// target is marked by two rules at a POSITION. The hit palette is a one-frame
// temporal event, not a state read.
// ---------------------------------------------------------------------------

/** The Inked register, for the canvas only. DOM colours come from Tailwind tokens. */
export const FIELD_COLOURS = {
  ink: '#2A2A2E',
  signalText: '#C13A20',
  signalFill: '#E2492C',
  secondary: '#6A6A65',
  rule: '#E2E2DC',
} as const;

// The two palettes layout B is allowed to select. `game`/`gameHit` exist in the
// sprite module because the same bitmaps are drawn on black elsewhere on the
// site; the arcade route never reaches for them.
const PAPER = { fill: FIELD_COLOURS.ink, accent: FIELD_COLOURS.signalText } as const;
const PAPER_HIT = { fill: FIELD_COLOURS.signalText, accent: FIELD_COLOURS.signalFill } as const;

/**
 * Where a sprite sits inside its 60x42 rack cell: CENTRED on both axes.
 *
 * The cell was sized as "widest sprite + column gap" / "tallest sprite + rank
 * gap", so anchoring top-left would leave every narrow sprite hard against the
 * left edge of its cell and make the rack read as ragged rather than as ranks.
 * Centring also matches the mock, whose ranks are `justify-content: center`
 * flex rows.
 */
function offsetX(data: SpriteData): number {
  return Math.round((ALIEN_CELL_W - data.cols * ALIEN_CELL) / 2);
}

function offsetY(data: SpriteData): number {
  return Math.round((ALIEN_CELL_H - data.rows * ALIEN_CELL) / 2);
}

/**
 * Blit one bitmap. `skipTopRow` drops every run on row 0 — that is how a damaged
 * email loses its lid, and the only per-sprite variation this painter has.
 */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  data: SpriteData,
  x: number,
  y: number,
  cell: number,
  fill: string,
  accent: string,
  skipTopRow = false,
): void {
  const ox = Math.round(x);
  const oy = Math.round(y);
  let current = '';

  for (const run of data.runs) {
    if (skipTopRow && run.y === 0) continue;
    const colour = run.accent ? accent : fill;
    if (colour !== current) {
      ctx.fillStyle = colour;
      current = colour;
    }
    ctx.fillRect(ox + run.x * cell, oy + run.y * cell, run.w * cell, cell);
  }
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/* ------------------------------------------------------------ layers ------- */

function drawNotebook(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  const data = SPRITES.notebook;
  ctx.globalAlpha = NOTEBOOK_OPACITY;
  drawSprite(ctx, data, world.notebook.x, world.notebook.y, ALIEN_CELL, PAPER.fill, PAPER.accent);
  ctx.globalAlpha = 1;
}

/**
 * Bunkers, straight off the erosion grid. Erosion is the REMOVAL of cells and
 * never a colour change, so a half-eaten filter reads as damage at a glance and
 * to a colour-blind player identically.
 *
 * Solid cells are coalesced into horizontal runs per row before filling — a
 * pristine bunker is 28x8 = 224 cells but only ~8 rects.
 */
function drawBunker(ctx: CanvasRenderingContext2D, b: Readonly<Bunker>): void {
  ctx.fillStyle = FIELD_COLOURS.ink;
  for (let row = 0; row < b.rows; row += 1) {
    let col = 0;
    while (col < b.cols) {
      if (b.cells[row * b.cols + col] !== 1) {
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < b.cols && b.cells[row * b.cols + col + run] === 1) run += 1;
      ctx.fillRect(
        b.x + col * BUNKER_CELL,
        b.y + row * BUNKER_CELL,
        run * BUNKER_CELL,
        BUNKER_CELL,
      );
      col += run;
    }
  }
}

function drawAlien(ctx: CanvasRenderingContext2D, a: Readonly<Alien>): void {
  const data = SPRITES[a.name];
  const palette = a.hitTicks > 0 ? PAPER_HIT : PAPER;
  // An email at hp 1 has taken one hit and lost its lid. Damage is silhouette;
  // the hit palette is a one-frame flash and cannot carry a persistent state.
  const damaged = a.name === 'email' && a.hp === 1;

  drawSprite(
    ctx,
    data,
    a.x + offsetX(data),
    a.y + offsetY(data),
    ALIEN_CELL,
    palette.fill,
    palette.accent,
    damaged,
  );
}

function drawSaucer(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  const { saucer } = world;
  if (!saucer.active) return;
  // While the award is being shown in place the DOM overlay carries the number,
  // and the bonus itself is gone — the same beat the original holds.
  if (saucer.showHitTicks > 0) return;

  const data = SPRITES[SAUCER_SPRITE];
  drawSprite(ctx, data, saucer.x, saucer.y, SAUCER_CELL, PAPER.fill, PAPER.accent);
}

function drawCraft(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  const { craft } = world;
  const dying = craft.deathTicks > 0;
  if (!craft.alive && !dying) return;

  const palette = dying ? PAPER_HIT : PAPER;
  // Frozen by a meeting invite: still there, still yours, just not answering.
  // The DOM caption above it says so in words; the alpha says so at a glance.
  if (craft.frozenTicks > 0) ctx.globalAlpha = 0.45;
  drawSprite(ctx, SPRITES.craft, craft.x, CRAFT_Y, CRAFT_CELL, palette.fill, palette.accent);
  ctx.globalAlpha = 1;
}

function drawPlayerShot(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  const shot = world.playerShot;
  ctx.fillStyle = FIELD_COLOURS.signalText;

  // The mock's beam: 4 x 58 with its foot at `bottom: 74` (= 396 in a 470-tall
  // field, ten units clear of the craft's top edge). One tick on fire, then the
  // travelling shot takes over.
  if (world.craft.beamTicks > 0) {
    bar(
      ctx,
      world.craft.x + 14,
      CRAFT_Y - 10 - BEAM_FLASH_H,
      PLAYER_SHOT_W,
      BEAM_FLASH_H,
    );
  }

  if (!shot.active) return;
  if (shot.blowupTicks > 0) return; // the explosion layer owns this frame
  bar(ctx, shot.x, shot.y, PLAYER_SHOT_W, PLAYER_SHOT_H);
}

/**
 * Alien fire. All of it is the same neutral grey (#6A6A65) — the six kinds are
 * told apart by SILHOUETTE, which is the rule the whole game is built on:
 *
 *   rolling  solid bar          — the tracker, the one aiming at you
 *   plunger  banded screw       — wide/narrow alternating
 *   squiggly zigzag column      — a 2-wide stripe stepping side to side
 *   homing   bar with an arrow  — the @-mention, widening at the head
 *   meeting  hollow outline     — an empty invite; it freezes, it does not kill
 *   decoy    half-width, dashed — a boss comment that is not real
 *
 * The animFrame (0..3) phases the banded forms so they read as travelling.
 */
function drawAlienShot(ctx: CanvasRenderingContext2D, s: Readonly<AlienShot>): void {
  if (!s.active || s.blowupTicks > 0) return;

  const x = Math.round(s.x);
  const y = Math.round(s.y);
  const w = s.style === 'decoy' ? DECOY_W : ALIEN_SHOT_W;
  const h = ALIEN_SHOT_H;
  const phase = s.animFrame & 3;

  ctx.fillStyle = FIELD_COLOURS.secondary;

  switch (s.style) {
    case 'plunger': {
      for (let band = 0; band < h; band += 2) {
        const wide = ((band >> 1) + phase) % 2 === 0;
        if (wide) ctx.fillRect(x, y + band, w, 2);
        else ctx.fillRect(x + 1, y + band, w - 2, 2);
      }
      break;
    }
    case 'squiggly': {
      for (let band = 0; band < h; band += 2) {
        const left = ((band >> 1) + phase) % 2 === 0;
        ctx.fillRect(x + (left ? 0 : 2), y + band, 2, 2);
      }
      break;
    }
    case 'homing': {
      ctx.fillRect(x, y, w, h - 3);
      // The head: eight wide, so a mention reads as pointed even at a glance.
      ctx.fillRect(x - 2, y + h - 3, w + 4, 3);
      break;
    }
    case 'meeting': {
      // Hollow: a 1-unit outline around a 2-unit void. Nothing else on the
      // field is empty in the middle.
      ctx.fillRect(x, y, w, 1);
      ctx.fillRect(x, y + h - 1, w, 1);
      ctx.fillRect(x, y, 1, h);
      ctx.fillRect(x + w - 1, y, 1, h);
      break;
    }
    case 'decoy': {
      for (let band = 0; band < h; band += 5) {
        ctx.fillRect(x, y + band, w, 2);
      }
      break;
    }
    case 'rolling':
    default:
      ctx.fillRect(x, y, w, h);
      break;
  }
}

function drawExplosions(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  const data = SPRITES.burst;
  for (const e of world.explosions) {
    if (e.ticks <= 0) continue;
    const cell = e.kind === 'burst' ? 3 : 2;
    drawSprite(
      ctx,
      data,
      e.x - (data.cols * cell) / 2,
      e.y - (data.rows * cell) / 2,
      cell,
      FIELD_COLOURS.signalFill,
      FIELD_COLOURS.signalFill,
    );
  }
}

/**
 * The focus charge: two 1-unit ink rules down both edges of the targeted rack
 * column, running the full height of the field.
 *
 * Position, not colour, and not a blink — so it is legible under reduced motion
 * and to a colour-blind player, and it says exactly which column is about to go.
 */
function drawFocusCharge(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  if (world.focusColumn === null || world.focusHold <= 0) return;
  const left = world.rackX + world.focusColumn * ALIEN_CELL_W;
  ctx.fillStyle = FIELD_COLOURS.ink;
  bar(ctx, left, 0, 1, GROUND_Y);
  bar(ctx, left + ALIEN_CELL_W - 1, 0, 1, GROUND_Y);
}

/**
 * The gutter: the ground rule plus one cross per notification that reached the
 * player's row unread. It only ever grows.
 *
 * The crosses are `miss` at cell 2 (10 x 10) with a 14-unit gap, exactly as the
 * mock lays them out. They wrap: at the reference width 47 fit on a line, and
 * the 28-unit strip takes two lines of them at a 3-unit rhythm — which is where
 * the 96-mark draw cap comes from. The HUD number keeps counting past the cap.
 */
function drawGutter(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  ctx.fillStyle = FIELD_COLOURS.rule;
  ctx.fillRect(0, GROUND_Y, world.width, 1);

  if (world.unread <= 0) return;

  const size = 5 * GUTTER_MARK_CELL;
  const step = size + GUTTER_MARK_GAP;
  const usable = world.width - GUTTER_PAD_X * 2;
  const perRow = Math.max(1, Math.floor((usable + GUTTER_MARK_GAP) / step));
  const count = Math.min(world.unread, GUTTER_MAX_MARKS, perRow * 2);
  const twoRows = count > perRow;

  const data = SPRITES.miss;
  for (let i = 0; i < count; i += 1) {
    const row = twoRows ? Math.floor(i / perRow) : 0;
    const col = twoRows ? i % perRow : i;
    const y = twoRows
      ? GROUND_Y + 3 + row * (size + 3)
      : GROUND_Y + Math.round((GUTTER_H - size) / 2);
    drawSprite(
      ctx,
      data,
      GUTTER_PAD_X + col * step,
      y,
      GUTTER_MARK_CELL,
      FIELD_COLOURS.signalFill,
      FIELD_COLOURS.signalFill,
    );
  }
}

/* ------------------------------------------------------------- entry ------- */

/**
 * Paint one frame of the PLAYING field.
 *
 * Preconditions the caller guarantees: the transform is already
 * setTransform(dpr,0,0,dpr,0,0), and the backing store is world.width x
 * world.height logical units.
 *
 * The z-order below is fixed and load-bearing — the parked notebook must sit
 * behind everything (it is scenery), the craft must sit above the bunkers it
 * hides behind, and the gutter must sit above the field so a mark is never
 * covered by a shot exploding on the ground line.
 */
export function paintField(ctx: CanvasRenderingContext2D, world: Readonly<World>): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, world.width, world.height);

  drawNotebook(ctx, world);

  for (const b of world.bunkers) drawBunker(ctx, b);

  for (const a of world.aliens) {
    if (a.alive) drawAlien(ctx, a);
  }

  drawSaucer(ctx, world);
  drawCraft(ctx, world);
  drawPlayerShot(ctx, world);

  for (const s of world.alienShots) drawAlienShot(ctx, s);
  for (const s of world.bossShots) drawAlienShot(ctx, s);

  drawExplosions(ctx, world);
  drawFocusCharge(ctx, world);
  drawGutter(ctx, world);
}

/** Clear the whole field. Called once when the phase leaves `playing`. */
export function clearField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
}
