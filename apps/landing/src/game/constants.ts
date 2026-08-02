import type { AlienName } from '../lib/sprites';

// ---------------------------------------------------------------------------
// Every tuning number in the game, and the arithmetic that produced it.
//
// This file is a TRANSLATION TABLE, not a set of preferences. The 1978 arcade
// original runs in a 224 × 256 framebuffer at 60 Hz; the Inked cabinet's play
// field is 470 units tall and as wide as the page canvas (1166 on desktop).
// Every constant below is either the original's value verbatim, or the
// original's value put through one of two documented rescalings — and each one
// carries the original in its comment so a reviewer can check the arithmetic
// rather than take it on trust.
//
// THE TWO SCALE FACTORS
//
//   k_y = 470 / 256 = 1.836      applied to VERTICAL quantities
//   k_x = W / 224                NOT applied to horizontal quantities
//
// Vertical distances mean the same thing in both games, so they scale. Our field
// is 2.5× wider in aspect than the original's, so scaling horizontal speeds by
// k_x (5.21 at W = 1166) would hold traversal TIME constant while making
// everything look frantic. Horizontal quantities therefore preserve the
// RELATIONSHIP they encode instead of the number:
//
//   · the player preserves time-to-cross the field (W/180 ≈ 3.0 s, against the
//     original's 3.7 s — deliberately retuned a little faster);
//   · the rack preserves the fraction of the field it occupies (≈ 87 %, against
//     79 %) and the number of steps in a sweep (9 against 7);
//   · the bonus preserves its crossing time exactly (5.6 s).
//
// There are exactly FIVE quantities that must track the field width, and they
// are all declared as functions of it: columnsFor, rackStartX, playerSpeed,
// saucerSpeed, bunkerX. Everything else is a fixed number.
//
// PURITY: this module imports nothing but a type. It must stay runnable in a
// bare Node process with no DOM, because the engine that depends on it is.
// ---------------------------------------------------------------------------

// ---- simulation clock -------------------------------------------------------

/** The original's frame rate. Its ROM assumes 60 Hz throughout; so do we. */
export const TICK_HZ = 60;
export const TICK_MS = 1000 / 60;

/**
 * Ticks a single rAF callback may simulate before the accumulator is dropped.
 * A stall (a tab restored after ten seconds) must not spiral into a six-hundred
 * tick catch-up that lands the rack on the player's head.
 */
export const MAX_CATCH_UP = 5;

// ---- the logical space ------------------------------------------------------
//
// Origin = top-left of the play field. +y is DOWN. 1 unit = 1 CSS px at the
// reference width. Height is ALWAYS 470 (the mock's literal `height: 470px`);
// width is the measured field width, clamped.

export const FIELD_H = 470;
export const FIELD_MIN_W = 560;
export const FIELD_MAX_W = 1400;

/** clamp(round(cssWidth), FIELD_MIN_W, FIELD_MAX_W). The ONLY way a world width is chosen. */
export function logicalWidth(cssWidth: number): number {
  const w = Math.round(cssWidth);
  if (!Number.isFinite(w)) return FIELD_MIN_W;
  return Math.min(FIELD_MAX_W, Math.max(FIELD_MIN_W, w));
}

/**
 * CSS height of the field box for a given measured width — `470` at any measured
 * width from 560 up.
 *
 * Below 560 the world clamps to 560 units and the whole field is UNIFORMLY
 * downscaled, so the box gets shorter and the sprites stay square. That is the
 * only way to honour "full canvas width, do not letterbox a 224 × 256 field"
 * without a non-uniform stretch, which would distort pixel art.
 */
export function fieldCssHeight(cssWidth: number): number {
  return Math.round(FIELD_H * Math.min(1, cssWidth / logicalWidth(cssWidth)));
}

/** CSS px per logical unit — `cssWidth / logicalWidth(cssWidth)`. Positions DOM overlays. */
export function fieldScale(cssWidth: number): number {
  return cssWidth / logicalWidth(cssWidth);
}

/** Mock: the field's `padding: 30px 0 0`. */
export const FIELD_TOP_PAD = 30;
/** Mock: the gutter strip's `height: 28px`. */
export const GUTTER_H = 28;
/** 470 − 28. The gutter's top rule IS the ground line — original Yr 16. */
export const GROUND_Y = 442;
/** Crosses drawn; the HUD number keeps counting past this. */
export const GUTTER_MAX_MARKS = 96;
/** `miss` bitmap at cell 2 → 10 × 10, per the mock. */
export const GUTTER_MARK_CELL = 2;
/** Mock: the gutter list's `gap: 14px`. */
export const GUTTER_MARK_GAP = 14;
/** Mock: the gutter strip's `padding: 0 22px`. */
export const GUTTER_PAD_X = 22;

// ---- the craft --------------------------------------------------------------

/** `--cab-cell-play`. */
export const CRAFT_CELL = 3;
/** The craft bitmap is 11 × 8 cells; at cell 3 that is 33 × 24 (original 16 × 8). */
export const CRAFT_W = 33;
export const CRAFT_H = 24;
/** Mock: `bottom: 40` → 470 − 40 − 24. Original Yr 32. */
export const CRAFT_Y = 406;
/** Original Xr 16, direct — the margins are a fraction, not a distance. */
export const CRAFT_MIN_X = 16;

/** Mirror of the left margin. Original Xr 185. */
export function craftMaxX(width: number): number {
  return width - CRAFT_MIN_X - CRAFT_W;
}

/**
 * Units per tick. The original moves 1 px/frame across 224 − 32 = 192 px of
 * travel, i.e. 3.2 s end to end. `W/180` crosses ours in 3.0 s — the same
 * feel, marginally quicker because the field is visually much wider and a
 * slower crossing reads as sluggish.
 */
export function playerSpeed(width: number): number {
  return width / 180;
}

/** The death animation, original 60 frames. */
export const PLAYER_DEATH_TICKS = 60;
/** The re-entry hold before control returns, original 128 frames. */
export const PLAYER_RESPAWN_TICKS = 128;
export const LIVES_START = 3;
/**
 * Original 1500, awarded once. Ours is 3000 because our scoring scale is the
 * handoff's 10/25/50/250 rather than the original's 10/20/30, so points accrue
 * roughly twice as fast for the same play.
 */
export const EXTRA_LIFE_SCORE = 3000;
/** 1.5 s. The meeting invite's freeze — the brief's "one beat". */
export const MEETING_FREEZE_TICKS = 90;

// ---- the rack ---------------------------------------------------------------

/** The brief's four ranks (original: five rows). */
export const ROWS = 4;
/** Widest sprite 33 (11 cells × 3) + the mock's 27px column gap. Original 16. */
export const ALIEN_CELL_W = 60;
/** Tallest sprite 27 (9 cells × 3) + the mock's 15px rank gap. Original 16. */
export const ALIEN_CELL_H = 42;
/** Sprite cell size inside a rack cell — `--cab-cell-play`. */
export const ALIEN_CELL = 3;
/** Clearance either side, used only to derive the column count. */
export const RACK_MARGIN = 44;

/**
 * clamp(floor((width − 2·RACK_MARGIN) / ALIEN_CELL_W), 6, 18).
 * 17 at width 1166 → 68 aliens (original 11 columns, 55 aliens).
 */
export function columnsFor(width: number): number {
  const raw = Math.floor((width - 2 * RACK_MARGIN) / ALIEN_CELL_W);
  return Math.min(18, Math.max(6, raw));
}

/** round((width − columns·60) / 2) — 73 at width 1166. Centred, as the original is. */
export function rackStartX(width: number, columns: number): number {
  return Math.round((width - columns * ALIEN_CELL_W) / 2);
}

/** Original 2 px on a 224-wide field (0.89 %); 8 is 0.69 % of 1166, and the mock's `limnStep`. */
export const RACK_STEP_X = 8;
/**
 * The right-hand step when exactly one alien remains — original 3 px against its
 * usual 2. The LEFT step is never widened: the asymmetry is the original's
 * deliberate anti-aim measure and copying only half of it would remove it.
 */
export const RACK_STEP_X_LAST = 12;
/** Original 8 px = 3.1 % of 256; 16 is 3.4 % of 470. */
export const RACK_DROP = 16;
/** Reverse when the LIVE sprite extent crosses this. Original Xr 9 / 213. */
export const EDGE_MARGIN = 12;

/**
 * Starting rack Y, indexed by `(wave − 1) & 7`.
 *
 * The original's table (Yr 120, 96, 80, 72, 72, 72, 64, 64, 64) counts UP from
 * the bottom, so it starts each successive wave lower and floors after a few.
 * The arithmetic, in full, because the whole point of this file is that it can be
 * checked rather than trusted:
 *
 *   descent from wave 1, in original px   0  24  40  48  48  48  56  56  56
 *   × k_y (1.836)                         0  44  73  88  88  88 103 103 103
 *   + our wave-1 start of 96             96 140 169 184 184 184 199 199 199
 *
 * The first EIGHT of those are the table below; the ninth would repeat at wave 9
 * as the original repeats at wave 10, and an 8-slot cycle is what `& 7` and
 * WAVE_LINES already use.
 *
 * CROSS-CHECK — drops to invasion, which is what a start Y actually buys the
 * player (`ceil((234 − startY) / RACK_DROP)`, 234 being the rackY at which the
 * bottom rank's cell reaches INVASION_Y): 9, 6, 5, 4, 4, 4, 3, 3 against the
 * original's 10, 7, 5, 4, 4, 4, 3, 3. Exact from wave 3 on, one drop kinder in
 * the two opening waves, and it keeps the original's SHAPE — two plateaus rather
 * than a smooth ramp.
 */
export const RACK_START_Y: readonly number[] = [96, 140, 169, 184, 184, 184, 199, 199];

/**
 * The rack has landed. Original Yr 40 — four units above the craft's top edge,
 * so the test fires when the bottom rank's CELL reaches the craft's row.
 */
export const INVASION_Y = 402;
/** Original 16 frames. The whole rack freezes for the duration of every kill. */
export const ALIEN_EXPLODE_TICKS = 16;

/**
 * Ticks a struck-but-not-cleared sprite is drawn in the hit palette.
 *
 * The handoff says "one frame". Its frame is the 2.4 s step beat of the mock's
 * still-image formation, not a 60 Hz simulation tick — one tick is 16 ms and is
 * literally invisible. Six ticks (100 ms) is the shortest flash that reads as an
 * event. It stays an EVENT and never a state: `email`'s damage is carried by its
 * silhouette (the lid row is dropped), never by this colour.
 */
export const ALIEN_HIT_FLASH_TICKS = 6;

/**
 * Row → the type cycle for that row, TOP row first (row 0 is furthest from the
 * player and worth the most, exactly as the original's top rank is).
 *
 * Rows 1 and 2 are the same rank with OFFSET cycles, so the middle of the rack
 * is visually mixed rather than striped. `notebook` is never in the rack (it
 * does not descend — that is its entire joke) and `bot` appears only as the boss.
 */
export const ROW_TYPES: readonly (readonly AlienName[])[] = [
  ['repo', 'review', 'ci'], // rank 3 · Engineering — 50 pts
  ['email', 'meeting', 'at', 'thread'], // rank 2 · Comms & calendar — 25 pts
  ['thread', 'at', 'meeting', 'email'], // rank 2, offset cycle
  ['channel', 'group', 'bell'], // rank 1 · Chatter — 10 pts
];

export function alienTypeAt(row: number, col: number): AlienName {
  const cycle = ROW_TYPES[((row % ROWS) + ROWS) % ROWS];
  if (!cycle || cycle.length === 0) return 'bell';
  return cycle[((col % cycle.length) + cycle.length) % cycle.length] ?? 'bell';
}

// ---- shots ------------------------------------------------------------------

/** Original 4 px/frame × k_y = 7.3. */
export const PLAYER_SHOT_SPEED = 7;
/** The handoff's beam is 4 wide (original 1 × 4). */
export const PLAYER_SHOT_W = 4;
export const PLAYER_SHOT_H = 16;
/** Spawn x = craft.x + 14 — centred on a 33-wide craft (original craft.x + 8 on 16). */
export const PLAYER_SHOT_DX = 14;
/** Original Yr 216: the shot dies just ABOVE the bonus lane, so a bonus can be missed. */
export const PLAYER_SHOT_TOP_Y = 36;
/** Original 16 frames — this is the fire lockout, not a cosmetic. */
export const SHOT_BLOWUP_TICKS = 16;
/** The mock's 4 × 58 beam, drawn for one tick on fire. */
export const BEAM_FLASH_TICKS = 1;
export const BEAM_FLASH_H = 58;

/** Original 3 (the plunger is suppressed entirely when one alien remains). */
export const MAX_ALIEN_SHOTS = 3;
/** Original: one shot slot is serviced per frame, so each shot advances every 3rd. */
export const SHOT_MOVE_PERIOD = 3;
/** Original 4 px per move × k_y. */
export const ALIEN_SHOT_STEP = 7;
/** Original 5 px per move × k_y. */
export const ALIEN_SHOT_STEP_FAST = 9;
/** Permanent once liveCount ≤ 8, for the rest of the wave. Original: identical. */
export const ALIEN_SHOT_SPEEDUP_AT = 8;
export const ALIEN_SHOT_W = 4;
export const ALIEN_SHOT_H = 14;
/** Original ~9 frames. */
export const ALIEN_SHOT_BLOWUP_TICKS = 9;
/** Original 48 frames of silence after the player dies. */
export const ALIEN_FIRE_DELAY_AFTER_DEATH = 48;

/**
 * A shot kills the craft ONLY inside this band; anywhere else it merely
 * explodes. Original Yr [30, 38] — it is what stops a shot that has already
 * passed the craft's row from killing on the way to the floor.
 */
export const PLAYER_KILL_BAND = [402, 430] as const;

/** Units the @-mention's shot drifts toward the craft's centre per move step. */
export const AT_HOME_STEP = 4;

/** Score bands. `RELOAD_RATES[i]` applies while score ≤ RELOAD_THRESHOLDS[i]. */
export const RELOAD_THRESHOLDS: readonly number[] = [200, 1000, 2000, 3000];
/**
 * The original's table verbatim, and deliberately UNSCALED: these are STEP
 * COUNTS in the reload gate, not distances, so k_y does not apply to them.
 */
export const RELOAD_RATES: readonly number[] = [48, 16, 11, 8, 7];

export function reloadRateFor(score: number): number {
  for (let i = 0; i < RELOAD_THRESHOLDS.length; i += 1) {
    const threshold = RELOAD_THRESHOLDS[i];
    if (threshold !== undefined && score <= threshold) return RELOAD_RATES[i] ?? 48;
  }
  return RELOAD_RATES[RELOAD_RATES.length - 1] ?? 7;
}

/**
 * The ROM's 32-byte column table, verbatim. Values are 1-BASED columns and are
 * taken modulo the live column count, so the same table drives an 11-column rack
 * and our 17-column one without becoming a different distribution — it is a
 * pseudo-random-looking but fixed order, and that fixedness is why the original
 * is learnable.
 */
export const COLUMN_FIRE_TABLE: readonly number[] = [
  1, 7, 1, 1, 1, 4, 11, 1, 6, 3, 1, 1, 11, 9, 2, 8, 2, 11, 4, 7, 10, 5, 2, 5, 4, 6, 7, 8, 10, 6,
  10, 3,
];

/** The plunger walks table indices 0..15; the squiggly walks 6..20. Original. */
export const PLUNGER_RANGE = [0, 15] as const;
export const SQUIGGLY_RANGE = [6, 20] as const;

// ---- boss -------------------------------------------------------------------

export const BOSS_FROM_WAVE = 3;
/** "Fires forty comments; three are real." Three hits to clear it. */
export const BOSS_HP = 3;
/** 2.5 s between bursts, independent of the three ordinary shot slots. */
export const BOSS_FIRE_PERIOD = 150;
export const BOSS_BURST = 6;
export const BOSS_REAL_PER_BURST = 1;
export const MAX_BOSS_SHOTS = 12;
/** Decoys are 2 units wide and dashed — told apart by SHAPE, never by colour. */
export const DECOY_W = 2;

/** min(3, wave − 2) columns in row 0, at round((k+1)·columns/(bossCount+1)). */
export function bossColumns(wave: number, columns: number): number[] {
  if (wave < BOSS_FROM_WAVE || columns <= 0) return [];
  const count = Math.min(3, wave - 2);
  const out: number[] = [];
  for (let k = 0; k < count; k += 1) {
    const raw = Math.round(((k + 1) * columns) / (count + 1));
    const col = Math.min(columns - 1, Math.max(0, raw));
    if (!out.includes(col)) out.push(col);
  }
  return out;
}

// ---- per-type behaviour -----------------------------------------------------

/** The email takes two hits. Its lid row is dropped at hp 1 — silhouette, not colour. */
export const EMAIL_HP = 2;
/** 4 s. A cleared CI failure comes back once, if its column is still alive. */
export const CI_RESPAWN_TICKS = 240;
/** Every 7th clear may spawn a thread reply behind it. */
export const THREAD_SPAWN_EVERY = 7;

/** Mock §A.7: `left: 30px; top: 40px`, cell 3, opacity 0.75, forever. */
export const NOTEBOOK_X = 30;
export const NOTEBOOK_Y = 40;
export const NOTEBOOK_OPACITY = 0.75;

// ---- focus ------------------------------------------------------------------

export const FOCUS_MAX = 5;
export const FOCUS_START = 2;
/** 0.5 s hold. Long enough to be deliberate, short enough to be a move. */
export const FOCUS_HOLD_TICKS = 30;

// ---- bunkers ("filters") ----------------------------------------------------
//
// The original's bunker is 22 × 16 in a 224 × 256 field — 9.8 % wide, 6.3 %
// tall, and a SILHOUETTE of aspect 1.375:1.
//
// THE ONE PLACE THE FIELD-FRACTION RULE IS DELIBERATELY BROKEN. Applying it on
// both axes (9.6 % of W = 112, 6.8 % of H = 32) is arithmetically faithful and
// visually wrong: at 3.5:1 the shield reads as a lintel rather than as something
// to shelter behind, and — worse — eight cell-rows of depth against an erosion
// radius of ry = 2 means two hits punch clean through, where the original's
// sixteen rows absorb several. The SHAPE is what carries both the read and the
// erosion budget, so the silhouette wins: 20 × 14 cells = 80 × 56 units, aspect
// 1.43:1, within 4 % of the original's.
//
// What that costs, stated plainly: cover drops from 38 % of the field width to
// 27 % (the original's is 39 %). Narrower but far deeper — you have less shield
// to stand behind and it lasts much longer once you are behind it.
//
// Vertical placement still follows the original exactly: its bunkers sit at
// y = 192 of 256 (75 % down), and 75 % of 470 is 352 — which is where the BOTTOM
// edge now sits minus its height, so the bunker line has not moved relative to
// the craft.

export const BUNKER_COUNT = 4;
/** Logical units per erosion cell. */
export const BUNKER_CELL = 4;
export const BUNKER_COLS = 20;
export const BUNKER_ROWS = 14;
/** Bottom stays at 384; the craft's top edge is at 406. */
export const BUNKER_TOP_Y = 328;
export const BUNKER_W = 80;
export const BUNKER_H = 56;

/** round((index + 0.5)·width/4 − 40) → 106, 397, 688, 979 at width 1166. */
export function bunkerX(width: number, index: number): number {
  return Math.round(((index + 0.5) * width) / BUNKER_COUNT - BUNKER_W / 2);
}

/**
 * The original's structure at 20 × 14: three rows of bevelled top corners, seven
 * rows of solid body, four rows of the arch cut out of the bottom centre — the
 * same 3 : 7 : 4 proportion as the ROM's 4 : 8 : 4 over sixteen rows.
 */
export const BUNKER_BITMAP: readonly string[] = [
  '...xxxxxxxxxxxxxx...',
  '..xxxxxxxxxxxxxxxx..',
  '.xxxxxxxxxxxxxxxxxx.',
  'xxxxxxxxxxxxxxxxxxxx',
  'xxxxxxxxxxxxxxxxxxxx',
  'xxxxxxxxxxxxxxxxxxxx',
  'xxxxxxxxxxxxxxxxxxxx',
  'xxxxxxxxxxxxxxxxxxxx',
  'xxxxxxxxxxxxxxxxxxxx',
  'xxxxxxxxxxxxxxxxxxxx',
  'xxxxxxxx....xxxxxxxx',
  'xxxxxxx......xxxxxxx',
  'xxxxxx........xxxxxx',
  'xxxxxx........xxxxxx',
];

/**
 * Hole radii in CELLS. The original has no bunker object at all — the
 * framebuffer IS the bunker and a hole is the explosion sprite AND-NOTed out, so
 * the player's own fire chews through the shield from beneath exactly as alien
 * fire chews through it from above. Both paths are wired here; the player's hole
 * is the wider of the two, proportionally matching the original's 8 px bite out
 * of a 22-wide bunker.
 */
export const EROSION_PLAYER = { rx: 4, ry: 2 } as const;
export const EROSION_ALIEN = { rx: 3, ry: 2 } as const;

// ---- the bonus (a review request crossing the top) --------------------------
//
// The handoff ships no saucer bitmap, so the bonus IS the `review` sprite at
// cell 4, in its own lane, at its own speed, in its own direction —
// unmistakable against the rack, and thematically exact: the high-value thing
// that appears occasionally, and catching it is what earns calm.

export const SAUCER_SPRITE = 'review';
export const SAUCER_CELL = 4;
/** Original Yr 208 — the same distance from the top edge, unscaled. */
export const SAUCER_LANE_Y = 40;
/** Original 1536 frames = 25.6 s. */
export const SAUCER_TIMER = 1536;
/** Original: no bonus once eight or fewer aliens remain. */
export const SAUCER_MIN_ALIENS = 8;

/** Original 0.67 px/frame; `W/336` gives the identical 5.6 s crossing. */
export function saucerSpeed(width: number): number {
  return width / 336;
}

/** Original 32 frames of the award held in place where it was hit. */
export const SAUCER_SHOW_HIT_TICKS = 32;

/** The ROM's award table × 10, matching the handoff's 10/25/50/250 point scale. */
export const SAUCER_SCORES: readonly number[] = [
  100, 50, 50, 100, 150, 100, 100, 50, 300, 100, 100, 100, 50, 150, 100, 50,
];

/**
 * THE ROM'S OFF-BY-ONE, PRESERVED. The index wraps at 15 rather than 16, so only
 * fifteen of the sixteen entries ever cycle: the single 300 lands on the 23rd
 * shot and every 15th thereafter. It advances every time the PLAYER'S SHOT IS
 * REMOVED (hit, miss, or leaving the top), not when the bonus appears, and it
 * resets to 0 at the start of each wave. Counting your shots is the mechanic;
 * "fixing" the wrap would delete it.
 */
export const SAUCER_SCORE_WRAP = 15;

// ---- waves ------------------------------------------------------------------

/** 2 s, skippable with Space. */
export const WAVE_BREAK_TICKS = 120;

/** The "next wave" line, indexed by `(wave − 1) & 7`. */
export const WAVE_LINES: readonly string[] = [
  'the review bot ships a nightly schedule',
  'someone adds you to four more channels',
  'the review bot ships a nightly schedule',
  'a calendar invite arrives with no agenda',
  'a thread you muted gets forty replies',
  'CI goes red on main, twice',
  'a group chat becomes three group chats',
  'everything, all of it, again',
];

// ---- the fleet-tempo tables (the accelerating bass loop) --------------------
//
// ROM 0x1A11 / 0x1A21, verbatim and paired index-for-index. The first FLEET_COUNTS
// entry that is ≤ the live count wins, and its FLEET_DELAYS twin is the number of
// ticks between the four descending bass notes.
//
// These are deliberately NOT synchronised to the march. The original's tempo
// table is a separate clock from its one-alien-per-frame cursor, which is
// exactly why the two drift against each other and why the loop feels like
// pressure rather than a metronome for the rack.

export const FLEET_COUNTS: readonly number[] = [
  50, 43, 36, 28, 22, 17, 13, 10, 8, 7, 6, 5, 4, 3, 2, 1,
];

export const FLEET_DELAYS: readonly number[] = [
  52, 46, 39, 34, 28, 24, 21, 19, 16, 14, 13, 12, 11, 9, 7, 5,
];
