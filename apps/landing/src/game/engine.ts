import { ALIEN_META, ALIEN_NAMES, SPRITES } from '../lib/sprites';
import type { AlienName } from '../lib/sprites';
import { bunkerHits, createBunkers, erodeBunker, eraseBunkerRect, resetBunkers } from './bunkers';
import {
  ALIEN_CELL,
  ALIEN_CELL_H,
  ALIEN_CELL_W,
  ALIEN_EXPLODE_TICKS,
  ALIEN_FIRE_DELAY_AFTER_DEATH,
  ALIEN_HIT_FLASH_TICKS,
  ALIEN_SHOT_BLOWUP_TICKS,
  ALIEN_SHOT_H,
  ALIEN_SHOT_SPEEDUP_AT,
  ALIEN_SHOT_STEP,
  ALIEN_SHOT_STEP_FAST,
  ALIEN_SHOT_W,
  AT_HOME_STEP,
  BEAM_FLASH_TICKS,
  BOSS_BURST,
  BOSS_FIRE_PERIOD,
  BOSS_HP,
  BOSS_REAL_PER_BURST,
  CI_RESPAWN_TICKS,
  COLUMN_FIRE_TABLE,
  CRAFT_H,
  CRAFT_MIN_X,
  CRAFT_W,
  CRAFT_Y,
  EDGE_MARGIN,
  EMAIL_HP,
  EROSION_ALIEN,
  EROSION_PLAYER,
  EXTRA_LIFE_SCORE,
  FIELD_H,
  FOCUS_HOLD_TICKS,
  FOCUS_MAX,
  FOCUS_START,
  GROUND_Y,
  INVASION_Y,
  LIVES_START,
  MAX_ALIEN_SHOTS,
  MAX_BOSS_SHOTS,
  MEETING_FREEZE_TICKS,
  NOTEBOOK_X,
  NOTEBOOK_Y,
  PLAYER_DEATH_TICKS,
  PLAYER_KILL_BAND,
  PLAYER_RESPAWN_TICKS,
  PLAYER_SHOT_DX,
  PLAYER_SHOT_H,
  PLAYER_SHOT_SPEED,
  PLAYER_SHOT_TOP_Y,
  PLAYER_SHOT_W,
  PLUNGER_RANGE,
  RACK_DROP,
  RACK_START_Y,
  RACK_STEP_X,
  RACK_STEP_X_LAST,
  RELOAD_RATES,
  ROWS,
  SAUCER_CELL,
  SAUCER_LANE_Y,
  SAUCER_MIN_ALIENS,
  SAUCER_SCORES,
  SAUCER_SCORE_WRAP,
  SAUCER_SHOW_HIT_TICKS,
  SAUCER_SPRITE,
  SAUCER_TIMER,
  SHOT_BLOWUP_TICKS,
  SHOT_MOVE_PERIOD,
  SQUIGGLY_RANGE,
  THREAD_SPAWN_EVERY,
  WAVE_BREAK_TICKS,
  alienTypeAt,
  bossColumns,
  bunkerX,
  columnsFor,
  craftMaxX,
  playerSpeed,
  rackStartX,
  reloadRateFor,
  saucerSpeed,
} from './constants';
import type {
  Alien,
  AlienShot,
  AlienShotStyle,
  GameEvent,
  GameSummary,
  HudSnapshot,
  Input,
  World,
  WorldOptions,
} from './types';

// ---------------------------------------------------------------------------
// The simulation.
//
// No React, no DOM, no timers, no audio, no Math.random. `tick()` is a pure
// transition on a `World` — the same input sequence and the same seed always
// produce the same game, which is the only way a bug in something this stateful
// is reproducible.
//
// =====================================================================
// THE ONE MECHANIC EVERYTHING ELSE HANGS OFF
// =====================================================================
//
// EXACTLY ONE LIVE ALIEN IS ADVANCED PER TICK, in a fixed order, and the rack
// origin moves ONLY when the cursor wraps. Therefore the period of one rack step
// is exactly N ticks for N live aliens — 68 ticks (1.1 s) at full strength,
// ONE tick (16 ms) on the last survivor. That is the entire difficulty curve of
// the 1978 original, and it is an emergent property of the loop rather than a
// tuned parameter: there is no speed variable in this file, no `marchInterval`,
// and nothing anywhere that shortens a timer as the rack thins.
//
// Three things follow, and all three are behaviour rather than accident:
//
//   · an alien that the cursor has not yet reached is still drawn at the OLD
//     origin, so the rack visibly ripples as the step travels through it. Do not
//     interpolate it away; the ripple IS the march;
//   · anything that RAISES the live count (a `ci` respawning, a `group`
//     splitting) genuinely slows the rack back down, which is correct and falls
//     out of the same rule;
//   · the rack freezes completely for the sixteen ticks of every kill
//     explosion, so a fast player holds it still.
//
// =====================================================================
// TICK ORDER — FIXED AND LOAD-BEARING
// =====================================================================
//
//   1  tick++
//   2  phase gates (wave-break countdown; return unless `playing`)
//   3  craft input
//   4  player shot
//   5  alien + boss shots
//   6  march cursor (ONE live alien) + bump test + invasion test
//   7  alien fire
//   8  bonus
//   9  timers (ci respawn, hit flash, explosions)
//  10  wave-clear test
//  11  reload rate + extra life
//
// Movement precedes firing so a shot never moves on the tick it launches, and
// the march runs after all the shots so a rack step cannot teleport an alien
// past a shot that was about to hit it.
// ---------------------------------------------------------------------------

const DEFAULT_SEED = 0x5eed;

/** The offsets of a boss burst, in rack columns either side of the bot. */
const BOSS_BURST_OFFSETS: readonly number[] = [-3, -2, -1, 1, 2, 3];

// ---- determinism ------------------------------------------------------------

/**
 * A 32-bit LCG (Numerical Recipes constants), carried on the world.
 *
 * The engine has exactly ONE stochastic decision — which of a boss burst's six
 * comments is the real one — and it draws from here rather than Math.random so
 * that a session is a pure function of (seed, input sequence). A "the boss
 * killed me unfairly" report is then reproducible from two numbers.
 */
function nextRandom(w: World): number {
  w.rng = (Math.imul(w.rng, 1664525) + 1013904223) >>> 0;
  return w.rng / 0x100000000;
}

function rngInt(w: World, n: number): number {
  return Math.min(n - 1, Math.floor(nextRandom(w) * n));
}

// ---- geometry ---------------------------------------------------------------

export type SpriteBox = { dx: number; dy: number; w: number; h: number };

const SPRITE_BOX_CACHE = new Map<AlienName, SpriteBox>();

/**
 * Where an alien's SPRITE sits inside its rack cell, and how big it is.
 *
 * Exported (additively — it is not in the module contract) because collision and
 * painting must agree to the pixel: the engine decides a shot missed, the
 * renderer decides where the silhouette was, and if those two disagree the game
 * feels broken in a way that is very hard to see in a screenshot. The sprites
 * differ in size (8×7 through 11×9 cells), so each is CENTRED in the uniform
 * 60 × 42 cell rather than corner-aligned.
 */
export function alienSpriteBox(name: AlienName): SpriteBox {
  const cached = SPRITE_BOX_CACHE.get(name);
  if (cached) return cached;
  const data = SPRITES[name];
  const w = data.cols * ALIEN_CELL;
  const h = data.rows * ALIEN_CELL;
  const box: SpriteBox = {
    dx: Math.round((ALIEN_CELL_W - w) / 2),
    dy: Math.round((ALIEN_CELL_H - h) / 2),
    w,
    h,
  };
  SPRITE_BOX_CACHE.set(name, box);
  return box;
}

/** The bonus is the `review` sprite at cell 4 — 32 × 28. */
export const SAUCER_W = SPRITES[SAUCER_SPRITE].cols * SAUCER_CELL;
export const SAUCER_H = SPRITES[SAUCER_SPRITE].rows * SAUCER_CELL;

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// ---- construction -----------------------------------------------------------

function emptyMissedByType(): Record<AlienName, number> {
  const out = {} as Record<AlienName, number>;
  for (const name of ALIEN_NAMES) out[name] = 0;
  return out;
}

function idleShot(): AlienShot {
  return {
    active: false,
    x: 0,
    y: 0,
    style: 'rolling',
    from: 'bell',
    steps: 0,
    moveTick: 0,
    animFrame: 0,
    blowupTicks: 0,
  };
}

function startingHp(name: AlienName): number {
  if (name === 'email') return EMAIL_HP;
  if (name === 'bot') return BOSS_HP;
  return 1;
}

/**
 * A world in `attract` phase with an EMPTY rack.
 *
 * Attract simulates nothing at all (the brief's "~2 % CPU while attracting"), so
 * there is nothing to march and building sixty-eight aliens nobody will see would
 * be waste. `startGame` lays the first wave.
 */
export function createWorld(opts: WorldOptions): World {
  const width = opts.width;
  const columns = columnsFor(width);
  const alienShots: AlienShot[] = [];
  for (let i = 0; i < MAX_ALIEN_SHOTS; i += 1) alienShots.push(idleShot());
  const bossShots: AlienShot[] = [];
  for (let i = 0; i < MAX_BOSS_SHOTS; i += 1) bossShots.push(idleShot());

  return {
    phase: 'attract',
    tick: 0,
    width,
    height: FIELD_H,
    columns,
    rows: ROWS,
    reducedMotion: opts.reducedMotion,
    rng: (opts.seed ?? DEFAULT_SEED) >>> 0,

    wave: 1,
    score: 0,
    cleared: 0,
    unread: 0,
    lives: LIVES_START,
    focus: FOCUS_START,
    extraLifeAwarded: false,
    missedByType: emptyMissedByType(),

    aliens: [],
    liveCount: 0,
    marchCursor: -1,
    rackX: rackStartX(width, columns),
    rackY: RACK_START_Y[0] ?? 96,
    rackDx: RACK_STEP_X,
    rackDy: 0,
    animPhase: 0,
    rackLeft: 0,
    rackRight: 0,
    rackExtentDirty: true,
    alienExplodeTicks: 0,
    clearsSinceThreadSpawn: 0,

    craft: {
      x: CRAFT_MIN_X,
      alive: true,
      frozenTicks: 0,
      deathTicks: 0,
      respawnTicks: 0,
      beamTicks: 0,
      fireLatch: false,
      focusBounce: false,
    },

    playerShot: { active: false, x: 0, y: 0, blowupTicks: 0 },
    playerShotCount: 0,
    alienShots,
    bossShots,
    shotSync: 0,
    alienFireDelay: 0,
    reloadRate: RELOAD_RATES[0] ?? 48,
    plungerIndex: PLUNGER_RANGE[0],
    squigglyIndex: SQUIGGLY_RANGE[0],
    bossFireTimer: BOSS_FIRE_PERIOD,
    shotSpeedLatched: false,

    explosions: [],
    saucer: { active: false, x: 0, y: SAUCER_LANE_Y, dx: 0, showHitTicks: 0, showScore: 0 },
    saucerTimer: SAUCER_TIMER,
    saucerScoreIndex: 0,

    bunkers: createBunkers(width),
    notebook: { x: NOTEBOOK_X, y: NOTEBOOK_Y },

    focusHold: 0,
    focusColumn: null,

    waveBreakTicks: 0,

    events: [],
  };
}

/**
 * Lay a fresh rack for `wave`.
 *
 * The column count is re-read HERE and nowhere else, because N — the live alien
 * count — is the march period, and changing it mid-wave would change the game's
 * clock underneath the player.
 */
function buildWave(w: World, wave: number): void {
  w.wave = wave;
  w.columns = columnsFor(w.width);
  const columns = w.columns;
  const bosses = new Set(bossColumns(wave, columns));

  w.rackX = rackStartX(w.width, columns);
  w.rackY = RACK_START_Y[(wave - 1) & 7] ?? 96;
  w.rackDx = RACK_STEP_X;
  w.rackDy = 0;
  w.animPhase = 0;

  const aliens: Alien[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const name: AlienName = row === 0 && bosses.has(col) ? 'bot' : alienTypeAt(row, col);
      aliens.push({
        id: row * columns + col,
        slot: row * columns + col,
        row,
        col,
        name,
        alive: true,
        hp: startingHp(name),
        x: w.rackX + col * ALIEN_CELL_W,
        y: w.rackY + row * ALIEN_CELL_H,
        frame: 0,
        hitTicks: 0,
        ciRespawnAt: null,
        ciRespawned: false,
      });
    }
  }

  w.aliens = aliens;
  w.liveCount = aliens.length;
  w.marchCursor = -1;
  w.rackExtentDirty = true;
  w.alienExplodeTicks = 0;
  w.clearsSinceThreadSpawn = 0;

  w.playerShot.active = false;
  w.playerShot.blowupTicks = 0;
  for (const s of w.alienShots) deactivateShot(s);
  for (const s of w.bossShots) deactivateShot(s);
  w.shotSync = 0;
  w.alienFireDelay = 0;
  w.reloadRate = reloadRateFor(w.score);
  w.plungerIndex = PLUNGER_RANGE[0];
  w.squigglyIndex = SQUIGGLY_RANGE[0];
  w.bossFireTimer = BOSS_FIRE_PERIOD;
  w.shotSpeedLatched = false;

  w.explosions.length = 0;
  w.saucer.active = false;
  w.saucer.showHitTicks = 0;
  w.saucer.showScore = 0;
  w.saucerTimer = SAUCER_TIMER;
  w.saucerScoreIndex = 0;

  // Bunkers are rebuilt per wave and PERSIST ACROSS DEATHS — losing a life with
  // your shields already gone is the position the original leaves you in.
  resetBunkers(w.bunkers);

  w.craft.alive = true;
  w.craft.deathTicks = 0;
  w.craft.respawnTicks = 0;
  w.craft.frozenTicks = 0;
  w.craft.beamTicks = 0;
  w.craft.x = Math.min(craftMaxX(w.width), Math.max(CRAFT_MIN_X, w.craft.x));

  w.focusHold = 0;
  w.focusColumn = null;
  w.waveBreakTicks = 0;

  w.events.push({ type: 'waveStart', wave });
}

// ---- public transitions -----------------------------------------------------

/**
 * Re-lay the world for a new logical width.
 *
 * THE COLUMN COUNT IS FROZEN FOR THE LIFE OF A WAVE: during play this rescales
 * positions only. Adding or removing aliens mid-wave would change N, and N is
 * the march period — a player who drags a window edge would find the rack
 * abruptly faster or slower. A new column count is taken at the next wave.
 */
export function resizeWorld(w: World, width: number): void {
  if (width === w.width || width <= 0 || w.width <= 0) return;
  const ratio = width / w.width;
  const columns = w.columns;
  const spanOld = w.width - columns * ALIEN_CELL_W;
  const spanNew = width - columns * ALIEN_CELL_W;

  w.width = width;

  // The rack keeps its margin RATIO rather than its margin, so a rack that was
  // about to bump is still about to bump. If the new width cannot hold the rack
  // at all (the window was dragged narrow mid-wave, and the column count is
  // frozen for the life of the wave) there is no ratio to keep and the rack is
  // simply centred on the overflow; `bumpTest` then declines to reverse it,
  // rather than ping-ponging it into the player's lap for the crime of resizing.
  if (spanNew <= 0) w.rackX = Math.round(spanNew / 2);
  else if (spanOld > 0) w.rackX = Math.round((w.rackX * spanNew) / spanOld);
  else w.rackX = Math.round(w.rackX * ratio);
  for (const a of w.aliens) {
    a.x = w.rackX + a.col * ALIEN_CELL_W;
    a.y = w.rackY + a.row * ALIEN_CELL_H;
  }
  w.rackExtentDirty = true;

  w.craft.x = Math.min(craftMaxX(width), Math.max(CRAFT_MIN_X, w.craft.x * ratio));

  w.playerShot.x *= ratio;
  for (const s of w.alienShots) s.x *= ratio;
  for (const s of w.bossShots) s.x *= ratio;
  for (const e of w.explosions) e.x *= ratio;

  w.saucer.x *= ratio;
  if (w.saucer.dx !== 0) {
    w.saucer.dx = Math.sign(w.saucer.dx) * saucerSpeed(width);
  }

  // The bunkers keep their EROSION and take new positions; rebuilding them on a
  // resize would hand the player four fresh shields for free.
  for (let i = 0; i < w.bunkers.length; i += 1) {
    const b = w.bunkers[i];
    if (b) b.x = bunkerX(width, i);
  }
}

export function setReducedMotion(w: World, on: boolean): void {
  w.reducedMotion = on;
  if (on) w.explosions.length = 0;
}

/** attract | gameOver -> playing, wave 1, lives reset, counters zeroed. No-op while playing. */
export function startGame(w: World): void {
  if (w.phase === 'playing' || w.phase === 'waveBreak') return;
  w.tick = 0;
  w.score = 0;
  w.cleared = 0;
  w.unread = 0;
  w.lives = LIVES_START;
  w.focus = FOCUS_START;
  w.extraLifeAwarded = false;
  w.missedByType = emptyMissedByType();
  w.playerShotCount = 0;
  w.craft.x = CRAFT_MIN_X;
  w.craft.fireLatch = true; // the Space that started the game must not also fire
  w.events.length = 0;
  w.phase = 'playing';
  buildWave(w, 1);
}

/** waveBreak -> playing immediately. No-op in any other phase. */
export function skipWaveBreak(w: World): void {
  if (w.phase !== 'waveBreak') return;
  advanceWave(w);
}

function advanceWave(w: World): void {
  w.phase = 'playing';
  buildWave(w, w.wave + 1);
}

/** Returns and CLEARS the event queue. Call once per tick or the queue grows unbounded. */
export function drainEvents(w: World): GameEvent[] {
  if (w.events.length === 0) return [];
  const out = w.events;
  w.events = [];
  return out;
}

export function hudOf(w: Readonly<World>): HudSnapshot {
  return {
    phase: w.phase,
    wave: w.wave,
    score: w.score,
    cleared: w.cleared,
    unread: w.unread,
    lives: w.lives,
    focus: w.focus,
    focusCharging: w.focusHold > 0,
    frozen: w.craft.frozenTicks > 0,
    saucerScore:
      w.saucer.showHitTicks > 0
        ? { x: w.saucer.x, y: w.saucer.y, points: w.saucer.showScore }
        : null,
    waveBreakTicks: w.phase === 'waveBreak' ? w.waveBreakTicks : 0,
  };
}

/**
 * The game-over panel's data — the product performing its own behaviour on the
 * mess the player just made.
 *
 * `review` and `at` are the two types the dashboard would surface as YOUR TURN,
 * so they are itemised in that order; everything else collapses into one
 * "digestible" number. That split is the whole argument of the closing panel.
 */
export function summarise(w: Readonly<World>): GameSummary {
  const needsYou: GameSummary['needsYou'] = [];
  for (const name of ['review', 'at'] as const) {
    const count = w.missedByType[name];
    if (count > 0) needsYou.push({ name, count, label: ALIEN_META[name].label });
  }
  let digestible = 0;
  for (const name of ALIEN_NAMES) {
    if (name === 'review' || name === 'at') continue;
    digestible += w.missedByType[name];
  }
  return {
    score: w.score,
    cleared: w.cleared,
    unread: w.unread,
    wave: w.wave,
    needsYou,
    digestible,
  };
}

/** A frozen all-false input. Use while paused rather than allocating. */
export const EMPTY_INPUT: Readonly<Input> = Object.freeze({
  left: false,
  right: false,
  fire: false,
  focus: false,
  pointerX: null,
});

// ---- the tick ---------------------------------------------------------------

export function tick(w: World, input: Readonly<Input>): void {
  w.tick += 1;

  if (w.phase === 'waveBreak') {
    if (w.waveBreakTicks > 0) w.waveBreakTicks -= 1;
    if (w.waveBreakTicks === 0) advanceWave(w);
    return;
  }
  if (w.phase !== 'playing') return;

  stepCraft(w, input);
  if (w.phase !== 'playing') return; // the last life ran out mid-step

  stepPlayerShot(w);
  stepAlienShots(w);
  tickMarch(w);
  if (w.phase !== 'playing') return; // the rack landed

  alienFire(w);
  bossFire(w);
  tickSaucer(w);
  tickTimers(w);

  if (w.liveCount === 0) {
    endWave(w);
    return;
  }

  if (!w.shotSpeedLatched && w.liveCount <= ALIEN_SHOT_SPEEDUP_AT) w.shotSpeedLatched = true;
  w.reloadRate = reloadRateFor(w.score);
  if (!w.extraLifeAwarded && w.score >= EXTRA_LIFE_SCORE) {
    w.extraLifeAwarded = true;
    w.lives += 1;
    w.events.push({ type: 'extraLife' });
  }
}

// ---- 3 · the craft ----------------------------------------------------------

function stepCraft(w: World, input: Readonly<Input>): void {
  const c = w.craft;
  if (c.beamTicks > 0) c.beamTicks -= 1;

  // FIRE AND FOCUS ARE DELIBERATELY ASYMMETRIC, and the asymmetry is the whole
  // point of these two lines.
  //
  // Fire AUTO-REPEATS. The original polls the fire button every frame and
  // launches whenever the shot slot is free — there is no edge detection in the
  // ROM — so holding fire keeps firing. That is not spray fire: the
  // one-shot-on-screen rule is the real limiter, and the measured ceiling over a
  // 90-second game is 99 shots held against 90 tapped. `fireLatch` therefore
  // consumes only the single press that STARTED the game (set in startGame) and
  // is never re-armed by firing.
  //
  // FOCUS does not. A segment is the scarcer resource — refilled only by
  // clearing review requests and the bonus — so one press must spend exactly one
  // segment however long F is held.
  if (!input.fire) c.fireLatch = false;
  if (!input.focus) c.focusBounce = false;

  if (!c.alive) {
    if (c.deathTicks > 0) {
      c.deathTicks -= 1;
      if (c.deathTicks === 0) finishDeath(w);
    }
    w.focusHold = 0;
    w.focusColumn = null;
    return;
  }

  if (c.respawnTicks > 0) c.respawnTicks -= 1;
  if (c.frozenTicks > 0) c.frozenTicks -= 1;

  // ONLY `frozenTicks` TAKES THE CONTROLS AWAY. `respawnTicks` is the re-entry
  // GRACE — alien fire lands on nothing while it runs (see the guard in
  // stepAlienShots) — and it used to return here too, which meant that after
  // every death the craft sat at the left edge for 128 ticks (2.1 s) ignoring
  // the player while the rack kept marching and the aliens resumed firing at
  // tick 48. Invulnerability and paralysis are different things, and the ROM's
  // hold is a pause of the whole game, not a live ship that will not answer.
  // The meeting invite's freeze is the one deliberate loss of control, so it
  // keeps the early return.
  if (c.frozenTicks > 0) {
    w.focusHold = 0;
    w.focusColumn = null;
    return;
  }

  // KEYS BEAT THE POINTER. Both are live at once — a mouse player may still hit
  // F or Space — but if a movement key is down it wins outright, so the two
  // cannot drag the craft in opposite directions. (useGame also drops pointerX
  // the moment a movement key goes down, so this is belt and braces.)
  const speed = playerSpeed(w.width);
  if (input.left && !input.right) c.x -= speed;
  else if (input.right && !input.left) c.x += speed;
  else if (input.pointerX !== null) {
    // Steer toward the pointer at the craft's own speed, and SNAP when the gap
    // is smaller than one step — without that the craft oscillates around the
    // target forever, one step either side of it.
    const delta = input.pointerX - CRAFT_W / 2 - c.x;
    c.x += Math.abs(delta) <= speed ? delta : Math.sign(delta) * speed;
  }
  c.x = Math.min(craftMaxX(w.width), Math.max(CRAFT_MIN_X, c.x));

  const shot = w.playerShot;
  if (input.fire && !c.fireLatch && !shot.active && shot.blowupTicks === 0) {
    shot.active = true;
    shot.x = c.x + PLAYER_SHOT_DX;
    shot.y = CRAFT_Y - PLAYER_SHOT_H;
    shot.blowupTicks = 0;
    c.beamTicks = BEAM_FLASH_TICKS;
    w.playerShotCount += 1;
    w.events.push({ type: 'fire' });
  }

  stepFocus(w, input);
}

function craftColumn(w: World): number {
  const centre = w.craft.x + CRAFT_W / 2;
  const raw = Math.floor((centre - w.rackX) / ALIEN_CELL_W);
  return Math.min(w.columns - 1, Math.max(0, raw));
}

/**
 * FOCUS — the batch-triage move, and the only moment the game offers relief.
 *
 * Holding F for half a second spends ONE segment and clears the whole rack
 * column the craft is under. Releasing early cancels and spends nothing, so it
 * is a decision rather than a twitch. Segments are refilled ONLY by clearing
 * review requests (and the bonus, which is one): calm is earned by doing the
 * work that mattered.
 *
 * ONE PRESS, ONE SEGMENT. `focusBounce` is real edge detection, and unlike fire
 * — which auto-repeats, as the ROM's polled fire button does — it is
 * load-bearing rather than merely tidy: without it a still-held F restarts the
 * charge the instant a segment lands, and 2.5 s of leaning on the key silently
 * empties the whole meter.
 */
function stepFocus(w: World, input: Readonly<Input>): void {
  if (!input.focus || w.focus <= 0 || w.craft.focusBounce) {
    w.focusHold = 0;
    w.focusColumn = null;
    return;
  }
  if (w.focusHold === 0) w.events.push({ type: 'focusCharging' });
  w.focusHold += 1;
  w.focusColumn = craftColumn(w);
  if (w.focusHold >= FOCUS_HOLD_TICKS) spendFocus(w);
}

function spendFocus(w: World): void {
  const col = w.focusColumn;
  w.focusHold = 0;
  w.focusColumn = null;
  w.craft.focusBounce = true;
  if (col === null) return;
  w.focus -= 1;

  // Snapshot first: a `group` in this column revives its own slot as a channel
  // ping mid-loop, and clearing that revival too would make FOCUS silently
  // stronger against groups than against anything else.
  const targets = w.aliens.filter((a) => a.alive && a.col === col);
  let cleared = 0;
  for (const a of targets) {
    if (!a.alive) continue;
    clearAlien(w, a);
    cleared += 1;
  }
  w.events.push({ type: 'focusSpent', column: col, cleared });
}

function finishDeath(w: World): void {
  if (w.lives <= 0) {
    endGame(w);
    return;
  }
  w.craft.alive = true;
  w.craft.x = CRAFT_MIN_X;
  w.craft.respawnTicks = PLAYER_RESPAWN_TICKS;
  w.craft.frozenTicks = 0;
}

function killCraft(w: World): void {
  const c = w.craft;
  c.alive = false;
  c.deathTicks = PLAYER_DEATH_TICKS;
  c.frozenTicks = 0;
  c.beamTicks = 0;
  w.lives -= 1;
  w.alienFireDelay = ALIEN_FIRE_DELAY_AFTER_DEATH;
  w.focusHold = 0;
  w.focusColumn = null;

  // The player's shot is CLEARED, not "removed": the saucer award index only
  // advances on a hit, a miss or a shot leaving the top, and dying is none of
  // those. Advancing it here would let a player farm the 300 by dying.
  w.playerShot.active = false;
  w.playerShot.blowupTicks = 0;
  for (const s of w.alienShots) deactivateShot(s);
  for (const s of w.bossShots) deactivateShot(s);

  w.events.push({ type: 'playerHit' });
}

function endGame(w: World): void {
  w.phase = 'gameOver';
  w.focusHold = 0;
  w.focusColumn = null;
  w.events.push({ type: 'gameOver', score: w.score, cleared: w.cleared, unread: w.unread });
}

// ---- 4 · the player's shot --------------------------------------------------

/**
 * Advance the shot the player HAS. There is only ever one, and its slot stays
 * occupied for the sixteen ticks of a miss explosion — that lockout is what
 * makes a wasted shot cost something, and it is the original's number.
 */
function stepPlayerShot(w: World): void {
  const s = w.playerShot;
  if (s.blowupTicks > 0) {
    s.blowupTicks -= 1;
    return;
  }
  if (!s.active) return;

  s.y -= PLAYER_SHOT_SPEED;

  if (hitAlienShot(w, s.x, s.y)) return;
  if (hitBunker(w, s.x, s.y)) return;
  if (hitAlien(w, s.x, s.y)) return;
  if (hitSaucer(w, s.x, s.y)) return;

  if (s.y <= PLAYER_SHOT_TOP_Y) {
    s.y = PLAYER_SHOT_TOP_Y;
    blowUpPlayerShot(w);
  }

  // The parked notebook is deliberately absent from this list. It cannot be
  // cleared and the shot passes THROUGH it without being consumed — a clearable
  // notebook would delete the joke, and a notebook that ate shots would punish
  // the player for the joke.
}

/**
 * Remove the shot without an explosion — the target's own blast carries it.
 *
 * THE SLOT IS STILL HELD, and for LONGER than a miss holds it. The original
 * spends two states on a kill (16 frames of alien explosion, then 16 of shot
 * cleanup) against one on a miss, and refuses to fire in either — so a kill costs
 * 32 frames of lockout, not zero. Freeing the slot here made the clear rate
 * roughly 2.6× the original's, and combined with the 16-tick rack freeze every
 * kill buys it let a player empty shots into a rack that could not move out of
 * the way. No explosion is pushed: `blowUpPlayerShot` owns the miss sprite, and
 * the alien's own burst is already on screen.
 */
function consumePlayerShot(w: World): void {
  w.playerShot.active = false;
  w.playerShot.blowupTicks = ALIEN_EXPLODE_TICKS + SHOT_BLOWUP_TICKS;
  advanceSaucerScoreIndex(w);
}

/** Remove the shot WITH its miss explosion, holding the slot for the lockout. */
function blowUpPlayerShot(w: World): void {
  const s = w.playerShot;
  s.active = false;
  s.blowupTicks = SHOT_BLOWUP_TICKS;
  if (!w.reducedMotion) {
    w.explosions.push({
      x: s.x + PLAYER_SHOT_W / 2,
      y: s.y,
      ticks: SHOT_BLOWUP_TICKS,
      kind: 'shot',
    });
  }
  advanceSaucerScoreIndex(w);
}

/**
 * The ROM's off-by-one, preserved: the index wraps at 15, not 16, so only
 * fifteen of the sixteen awards ever cycle and the single 300 lands on the 23rd
 * shot and every 15th after it. Counting your shots is the mechanic.
 */
function advanceSaucerScoreIndex(w: World): void {
  w.saucerScoreIndex = (w.saucerScoreIndex + 1) % SAUCER_SCORE_WRAP;
}

function hitAlienShot(w: World, x: number, y: number): boolean {
  for (const pool of [w.alienShots, w.bossShots]) {
    for (const s of pool) {
      if (!s.active) continue;
      if (!overlaps(x, y, PLAYER_SHOT_W, PLAYER_SHOT_H, s.x, s.y, ALIEN_SHOT_W, ALIEN_SHOT_H))
        continue;
      // A decoy is destroyed for zero points and still costs the shot. That tax
      // is the whole point of the boss.
      blowUpAlienShot(s);
      blowUpPlayerShot(w);
      return true;
    }
  }
  return false;
}

/**
 * The player's own fire eats the shields from beneath, with a WIDER hole than
 * alien fire makes. The shield is not "yours" — it is in the way of both sides,
 * and shooting through your own filter is how you end up standing in the open.
 */
function hitBunker(w: World, x: number, y: number): boolean {
  for (const b of w.bunkers) {
    if (!bunkerHits(b, x, y, PLAYER_SHOT_W, PLAYER_SHOT_H)) continue;
    erodeBunker(b, x + PLAYER_SHOT_W / 2, y, EROSION_PLAYER.rx, EROSION_PLAYER.ry);
    w.events.push({ type: 'bunkerHit' });
    blowUpPlayerShot(w);
    return true;
  }
  return false;
}

function hitAlien(w: World, x: number, y: number): boolean {
  for (const a of w.aliens) {
    if (!a.alive) continue;
    const box = alienSpriteBox(a.name);
    if (
      !overlaps(x, y, PLAYER_SHOT_W, PLAYER_SHOT_H, a.x + box.dx, a.y + box.dy, box.w, box.h)
    )
      continue;
    consumePlayerShot(w);
    damageAlien(w, a);
    return true;
  }
  return false;
}

function hitSaucer(w: World, x: number, y: number): boolean {
  const s = w.saucer;
  if (!s.active || s.showHitTicks > 0) return false;
  if (!overlaps(x, y, PLAYER_SHOT_W, PLAYER_SHOT_H, s.x, s.y, SAUCER_W, SAUCER_H)) return false;

  // ORDER IS LOAD-BEARING. Landing on the bonus IS a removal, so the index
  // advances first and the award is read from the count INCLUDING this shot.
  // That is what puts the single 300 on the 23rd shot and every 15th after it
  // (23 mod 15 = 8, the table's 300); reading before the advance puts it on the
  // 24th, and the whole point of the quirk is that it is countable.
  consumePlayerShot(w);
  const points = SAUCER_SCORES[w.saucerScoreIndex] ?? 100;

  w.score += points;
  s.showHitTicks = SAUCER_SHOW_HIT_TICKS;
  s.showScore = points;
  s.dx = 0;
  w.events.push({ type: 'saucerHit', points });
  gainFocus(w); // it is a review request, and review requests are what refill FOCUS
  return true;
}

// ---- clearing an alien, and the twelve behaviours ---------------------------

function damageAlien(w: World, a: Alien): void {
  if (a.hp > 1) {
    a.hp -= 1;
    a.hitTicks = ALIEN_HIT_FLASH_TICKS;
    w.events.push({ type: 'alienDamaged', name: a.name });
    return;
  }
  clearAlien(w, a);
}

function clearAlien(w: World, a: Alien): void {
  if (!a.alive) return;
  a.alive = false;
  a.hitTicks = 0;
  a.hp = 0;
  w.liveCount -= 1;
  w.rackExtentDirty = true;

  const meta = ALIEN_META[a.name];
  w.score += meta.points;
  w.cleared += 1;

  // The rack FREEZES for the whole explosion — the original's behaviour, and the
  // reason a fast player can hold a wave still.
  w.alienExplodeTicks = ALIEN_EXPLODE_TICKS;

  if (!w.reducedMotion) {
    const box = alienSpriteBox(a.name);
    w.explosions.push({
      x: a.x + ALIEN_CELL_W / 2,
      y: a.y + box.dy + box.h / 2,
      ticks: ALIEN_EXPLODE_TICKS,
      kind: 'burst',
    });
  }
  w.events.push({ type: 'alienCleared', name: a.name, points: meta.points });

  onCleared(w, a);
}

/**
 * The per-type on-clear hooks.
 *
 * Every one of them operates INSIDE A SLOT: none may touch rackX, rackY, the
 * cursor rate or the grid, because all four are the march and the march is the
 * game. Reviving a slot is legal (it raises N, which slows the rack — correct);
 * moving one is not.
 */
function onCleared(w: World, a: Alien): void {
  if (a.name === 'review') gainFocus(w);
  else if (a.name === 'group') splitGroup(w, a);
  else if (a.name === 'ci' && !a.ciRespawned) a.ciRespawnAt = w.tick + CI_RESPAWN_TICKS;

  w.clearsSinceThreadSpawn += 1;
  if (w.clearsSinceThreadSpawn >= THREAD_SPAWN_EVERY) {
    w.clearsSinceThreadSpawn = 0;
    spawnThreadBehind(w, a);
  }
}

function gainFocus(w: World): void {
  if (w.focus >= FOCUS_MAX) return;
  w.focus += 1;
  w.events.push({ type: 'focusGained' });
}

function reviveSlot(w: World, a: Alien, name: AlienName, hp: number): void {
  if (a.alive) return;
  a.name = name;
  a.hp = hp;
  a.alive = true;
  a.hitTicks = 0;
  a.ciRespawnAt = null;
  a.x = w.rackX + a.col * ALIEN_CELL_W;
  a.y = w.rackY + a.row * ALIEN_CELL_H;
  a.frame = w.animPhase;
  w.liveCount += 1;
  w.rackExtentDirty = true;
}

function slotAt(w: World, row: number, col: number): Alien | null {
  if (row < 0 || row >= w.rows || col < 0 || col >= w.columns) return null;
  return w.aliens[row * w.columns + col] ?? null;
}

/** Nearest dead slot in `row` to `col`, |Δcol| ascending, ties LEFT-first. */
function nearestDeadInRow(w: World, row: number, col: number): Alien | null {
  for (let d = 0; d <= w.columns; d += 1) {
    const candidates = d === 0 ? [col] : [col - d, col + d];
    for (const c of candidates) {
      const s = slotAt(w, row, c);
      if (s && !s.alive) return s;
    }
  }
  return null;
}

/**
 * A group chat becomes two channel pings — the split that makes clearing it feel
 * like a loss even though it scores.
 *
 * The same slot revives as a channel ping and one more goes into the nearest
 * empty slot in the row (then the row below, then above). Channel pings never
 * split, so the chain terminates: the group is the producer and the ping is the
 * product.
 */
function splitGroup(w: World, a: Alien): void {
  reviveSlot(w, a, 'channel', 1);
  const sibling =
    nearestDeadInRow(w, a.row, a.col) ??
    nearestDeadInRow(w, a.row + 1, a.col) ??
    nearestDeadInRow(w, a.row - 1, a.col);
  if (sibling) reviveSlot(w, sibling, 'channel', 1);
}

/** "Behind" is one row FURTHER FROM THE PLAYER — the reply lands above the gap. */
function spawnThreadBehind(w: World, a: Alien): void {
  if (a.row !== 1 && a.row !== 2) return;
  const above = slotAt(w, a.row - 1, a.col);
  if (!above || above.alive) return;
  reviveSlot(w, above, 'thread', 1);
}

function columnHasLive(w: World, col: number): boolean {
  for (let row = 0; row < w.rows; row += 1) {
    const s = slotAt(w, row, col);
    if (s && s.alive) return true;
  }
  return false;
}

// ---- 5 · alien and boss shots -----------------------------------------------

function deactivateShot(s: AlienShot): void {
  s.active = false;
  s.blowupTicks = 0;
  s.steps = 0;
  s.moveTick = 0;
  s.animFrame = 0;
}

/**
 * MODE-INDEPENDENT ON PURPOSE. `blowupTicks` is not a visual budget — it is how
 * long the slot stays occupied, and the reload gate reads it, so shortening it
 * under reduced motion measurably RAISED the alien fire rate (+9 % over a minute
 * of wave 1) while the player's own lockout stayed fixed. Reduced motion is a
 * first-class mode, never a harder one. Nothing is drawn during these ticks
 * anyway: `drawAlienShot` already skips a shot with `blowupTicks > 0`, and no
 * explosion sprite is pushed here in either mode.
 */
function blowUpAlienShot(s: AlienShot): void {
  s.active = false;
  s.blowupTicks = ALIEN_SHOT_BLOWUP_TICKS;
}

function stepAlienShots(w: World): void {
  for (const s of w.alienShots) stepAlienShot(w, s);
  for (const s of w.bossShots) stepAlienShot(w, s);
}

function stepAlienShot(w: World, s: AlienShot): void {
  if (s.blowupTicks > 0) {
    s.blowupTicks -= 1;
    // `steps` is only zeroed once the slot is genuinely free, because the reload
    // gate reads it: a slot mid-explosion must not read as "ready".
    if (s.blowupTicks === 0) deactivateShot(s);
    return;
  }
  if (!s.active) return;

  s.moveTick += 1;
  if (s.moveTick < SHOT_MOVE_PERIOD) return;
  s.moveTick = 0;

  // One advance every SHOT_MOVE_PERIOD ticks reproduces the original, which
  // services one of its three shot slots per frame. `steps` counts advances, not
  // ticks, because the reload gate is expressed in the original's step counts.
  s.steps += 1;
  s.animFrame = (s.animFrame + 1) & 3;
  s.y += w.shotSpeedLatched ? ALIEN_SHOT_STEP_FAST : ALIEN_SHOT_STEP;

  if (s.style === 'homing') {
    // The @-MENTION homes; the alien that sent it does not. An alien that left
    // its slot would break the grid, and the grid is the march.
    const target = w.craft.x + CRAFT_W / 2 - ALIEN_SHOT_W / 2;
    const delta = target - s.x;
    if (Math.abs(delta) <= AT_HOME_STEP) s.x = target;
    else s.x += Math.sign(delta) * AT_HOME_STEP;
    s.x = Math.min(w.width - ALIEN_SHOT_W, Math.max(0, s.x));
  }

  const decoy = s.style === 'decoy';

  if (!decoy) {
    for (const b of w.bunkers) {
      if (!bunkerHits(b, s.x, s.y, ALIEN_SHOT_W, ALIEN_SHOT_H)) continue;
      erodeBunker(
        b,
        s.x + ALIEN_SHOT_W / 2,
        s.y + ALIEN_SHOT_H,
        EROSION_ALIEN.rx,
        EROSION_ALIEN.ry,
      );
      // A shot the FILTER caught is not unread. That is what the bunkers are for.
      w.events.push({ type: 'bunkerHit' });
      blowUpAlienShot(s);
      return;
    }
  }

  const nose = s.y + ALIEN_SHOT_H;

  if (!decoy && nose >= PLAYER_KILL_BAND[0] && nose <= PLAYER_KILL_BAND[1]) {
    const c = w.craft;
    const hit =
      c.alive &&
      c.deathTicks === 0 &&
      overlaps(s.x, s.y, ALIEN_SHOT_W, ALIEN_SHOT_H, c.x, CRAFT_Y, CRAFT_W, CRAFT_H);
    if (hit) {
      blowUpAlienShot(s);
      if (c.respawnTicks > 0) return; // re-entry grace: it lands on nothing

      // It reached you, so it counts as unread either way — what differs is
      // whether it costs a life.
      w.unread += 1;
      w.missedByType[s.from] += 1;
      w.events.push({ type: 'unread', name: s.from });

      if (s.style === 'meeting') {
        c.frozenTicks = MEETING_FREEZE_TICKS;
        w.events.push({ type: 'playerFrozen' });
      } else {
        killCraft(w);
      }
      return;
    }
  }

  if (nose >= GROUND_Y) {
    if (decoy) {
      // A comment that was never real cannot be left unread.
      deactivateShot(s);
      return;
    }
    s.y = GROUND_Y - ALIEN_SHOT_H;
    w.unread += 1;
    w.missedByType[s.from] += 1;
    w.events.push({ type: 'unread', name: s.from });
    blowUpAlienShot(s);
  }
}

// ---- 6 · the march ----------------------------------------------------------

function refreshRackExtent(w: World): void {
  if (!w.rackExtentDirty) return;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const a of w.aliens) {
    if (!a.alive) continue;
    const box = alienSpriteBox(a.name);
    const l = a.x + box.dx;
    if (l < left) left = l;
    const r = l + box.w;
    if (r > right) right = r;
  }
  if (!Number.isFinite(left)) {
    left = w.rackX;
    right = w.rackX;
  }
  w.rackLeft = left;
  w.rackRight = right;
  w.rackExtentDirty = false;
}

/**
 * Reverse-and-drop, tested against the LIVE SPRITE EXTENT rather than a fixed
 * coordinate — which is why the last few survivors roam almost the whole field.
 *
 * DECLARED DIVERGENCE: the original scans two sentinel COLUMNS of its
 * framebuffer, so a stray explosion pixel in those columns also triggers a bump
 * (the famous "shoot your own bunker to steer the last alien" alias). We test
 * sprites. The property that matters — the extent shrinks as columns die — is
 * exact; the alias bug is not reproduced.
 */
function bumpTest(w: World): void {
  if (w.rackDy !== 0) return; // a reversal is already queued for the next step
  refreshRackExtent(w);
  if (w.liveCount === 0) return;

  // A rack WIDER than the field it is in satisfies both tests at once and would
  // reverse on every single step, dropping 16 units each time — twenty seconds
  // to a guaranteed loss. It is only reachable by narrowing the window mid-wave,
  // since the column count is frozen until the next one. The mirror-image test
  // is used instead (reverse when the TRAILING edge reaches the far margin), so
  // the overhang sweeps across once per reversal rather than per step, and the
  // normal test resumes the moment enough columns are cleared to fit.
  if (w.rackRight - w.rackLeft >= w.width - 2 * EDGE_MARGIN) {
    if (w.rackDx > 0 && w.rackLeft >= EDGE_MARGIN) {
      w.rackDx = -RACK_STEP_X;
      w.rackDy = RACK_DROP;
    } else if (w.rackDx < 0 && w.rackRight <= w.width - EDGE_MARGIN) {
      w.rackDx = RACK_STEP_X;
      w.rackDy = RACK_DROP;
    }
    return;
  }

  if (w.rackDx > 0 && w.rackRight >= w.width - EDGE_MARGIN) {
    w.rackDx = -RACK_STEP_X;
    w.rackDy = RACK_DROP;
  } else if (w.rackDx < 0 && w.rackLeft <= EDGE_MARGIN) {
    // The last survivor is faster going RIGHT than left (12 against 8). That
    // asymmetry is the original's deliberate anti-aim measure; copying only half
    // of it would remove it.
    w.rackDx = w.liveCount === 1 ? RACK_STEP_X_LAST : RACK_STEP_X;
    w.rackDy = RACK_DROP;
  }
}

/** The ONLY place rackX / rackY ever change. */
function applyRackStep(w: World): void {
  w.rackX += w.rackDx;
  w.rackY += w.rackDy;
  const dropped = w.rackDy !== 0;
  w.rackDy = 0;
  w.animPhase = w.animPhase === 0 ? 1 : 0;
  w.rackExtentDirty = true;
  if (dropped) eatBunkersUnderRack(w);
}

function eatBunkersUnderRack(w: World): void {
  for (const a of w.aliens) {
    if (!a.alive) continue;
    for (const b of w.bunkers) {
      eraseBunkerRect(b, a.x, a.y, ALIEN_CELL_W, ALIEN_CELL_H);
    }
  }
}

function tickMarch(w: World): void {
  if (w.alienExplodeTicks > 0) {
    w.alienExplodeTicks -= 1;
    return;
  }
  if (w.craft.deathTicks > 0) return;

  const n = w.aliens.length;
  if (n === 0) return;

  for (let guard = 0; guard <= n; guard += 1) {
    w.marchCursor += 1;
    if (w.marchCursor >= n) {
      w.marchCursor = 0;
      applyRackStep(w);
    }
    const a = w.aliens[w.marchCursor];
    if (!a || !a.alive) continue;

    // The alien "steps" by ADOPTING the current origin. Everything ahead of the
    // cursor is still at the previous one — that lag is the ripple.
    a.x = w.rackX + a.col * ALIEN_CELL_W;
    a.y = w.rackY + a.row * ALIEN_CELL_H;
    a.frame = w.animPhase;
    w.rackExtentDirty = true;

    if (a.y + ALIEN_CELL_H >= INVASION_Y) {
      invade(w);
      return;
    }
    bumpTest(w);
    return; // EXACTLY ONE live alien per tick
  }
}

/**
 * The rack reached the player's row: the game ends immediately, and every alien
 * still alive lands in the gutter at once.
 *
 * That dump is what makes the closing panel land — you do not lose slowly, you
 * lose everything you had not read. No per-alien `unread` event is emitted (the
 * audio bridge would machine-gun sixty of them); `gameOver` carries the total.
 */
function invade(w: World): void {
  for (const a of w.aliens) {
    if (!a.alive) continue;
    a.alive = false;
    w.unread += 1;
    w.missedByType[a.name] += 1;
  }
  w.liveCount = 0;
  w.rackExtentDirty = true;
  w.lives = 0;
  endGame(w);
}

// ---- 7 · alien fire ---------------------------------------------------------

function lowestLiveInColumn(w: World, col: number): Alien | null {
  for (let row = w.rows - 1; row >= 0; row -= 1) {
    const s = slotAt(w, row, col);
    if (s && s.alive) return s;
  }
  return null;
}

/**
 * THE RELOAD GATE, exactly as the original spells it.
 *
 * A new shot may launch only if BOTH other slots have either taken no steps
 * (inactive) or MORE steps than the current reload rate. That is what spaces
 * alien fire vertically instead of clustering three shots into one line, and it
 * is why the game gets harder as the score climbs: the rate falls 48 → 7, so
 * shots are permitted to overlap ever more closely. It is not a cooldown and
 * must not be replaced by one.
 */
function reloadGateOpen(w: World, slot: number): boolean {
  for (let i = 0; i < w.alienShots.length; i += 1) {
    if (i === slot) continue;
    const other = w.alienShots[i];
    if (!other) continue;
    if (other.steps !== 0 && other.steps <= w.reloadRate) return false;
  }
  return true;
}

function alienFire(w: World): void {
  const slot = w.shotSync;
  w.shotSync = ((slot + 1) % 3) as 0 | 1 | 2;

  // ORDER MATTERS: the delay counts down only once the player object is running
  // again, which is the ROM's rule. Decrementing it first spent all 48 ticks
  // inside the 60-tick death animation, so the "silence after you die" was over
  // before the craft came back and the constant did nothing at all.
  if (!w.craft.alive || w.craft.deathTicks > 0) return;
  if (w.alienFireDelay > 0) {
    w.alienFireDelay -= 1;
    return;
  }
  if (w.liveCount === 0) return;

  const shotSlot = w.alienShots[slot];
  if (!shotSlot || shotSlot.active || shotSlot.blowupTicks > 0) return;

  // The plunger is suppressed entirely on the last alien (the original drops to
  // two shots), and the squiggly SHARES ITS SLOT WITH THE BONUS — while a review
  // request is crossing the top, that slot is busy.
  if (slot === 1 && w.liveCount === 1) return;
  if (slot === 2 && w.saucer.active) return;
  if (!reloadGateOpen(w, slot)) return;

  // AN EMPTY COLUMN DOES NOT FIRE, and nothing is redirected to a neighbour.
  // Two behaviours rest on that. The tracker genuinely cannot reach a player
  // standing under a cleared column, which is a learnable safe spot rather than a
  // gap in the code; and the table's misses are the original's natural late-wave
  // rate limiter — as columns die, more attempts produce no shot at all, so fire
  // thins WITH the rack instead of intensifying as it thins.
  let column: number;
  if (slot === 0) {
    // The tracker: it aims at the column you are standing in, and only there.
    column = craftColumn(w);
  } else {
    const index = slot === 1 ? w.plungerIndex : w.squigglyIndex;
    const raw = COLUMN_FIRE_TABLE[index % COLUMN_FIRE_TABLE.length] ?? 1;
    column = (raw - 1) % w.columns;
    // The pointer walks per ATTEMPT, exactly as the ROM's does — an attempt that
    // lands on an empty column still consumes its table entry, which is what
    // keeps the sequence a fixed, learnable order rather than a queue of hits.
    if (slot === 1) {
      w.plungerIndex = w.plungerIndex >= PLUNGER_RANGE[1] ? PLUNGER_RANGE[0] : w.plungerIndex + 1;
    } else {
      w.squigglyIndex =
        w.squigglyIndex >= SQUIGGLY_RANGE[1] ? SQUIGGLY_RANGE[0] : w.squigglyIndex + 1;
    }
  }

  const shooter = lowestLiveInColumn(w, column);
  if (!shooter) return;

  const base: AlienShotStyle = slot === 0 ? 'rolling' : slot === 1 ? 'plunger' : 'squiggly';
  const style: AlienShotStyle =
    shooter.name === 'at' ? 'homing' : shooter.name === 'meeting' ? 'meeting' : base;

  launchShot(
    shotSlot,
    shooter.x + ALIEN_CELL_W / 2 - ALIEN_SHOT_W / 2,
    shooter.y + ALIEN_CELL_H,
    style,
    shooter.name,
  );
}

function launchShot(
  s: AlienShot,
  x: number,
  y: number,
  style: AlienShotStyle,
  from: AlienName,
): void {
  s.active = true;
  s.x = x;
  s.y = y;
  s.style = style;
  s.from = from;
  // ONE, NOT ZERO. `steps` is the reload gate's occupancy signal and `0` means
  // "this slot is free" (see `reloadGateOpen` / `deactivateShot`). Starting at 0
  // made a just-launched shot read as free for the SHOT_MOVE_PERIOD ticks before
  // its first advance, which opened the gate for the other two slots on the next
  // two ticks — the three-shots-in-one-line volley the gate exists to prevent.
  // The ROM counts a shot from its first frame; so do we.
  s.steps = 1;
  s.moveTick = 0;
  s.animFrame = 0;
  s.blowupTicks = 0;
}

/**
 * The review bot: forty comments, three are real.
 *
 * It fires on its OWN timer into its OWN pool, so it never competes with the
 * rack's three slots and never trips the reload gate — the boss is an extra
 * pressure, not a redistribution of the existing one. Six comments per burst,
 * exactly one of them live, and the live one is drawn from the seeded LCG so the
 * burst is reproducible. Decoys are told apart by SHAPE (two units wide, dashed)
 * and never by colour, per the accessibility rule.
 */
function bossFire(w: World): void {
  const bots: Alien[] = [];
  for (const a of w.aliens) if (a.alive && a.name === 'bot') bots.push(a);
  if (bots.length === 0) {
    w.bossFireTimer = BOSS_FIRE_PERIOD;
    return;
  }
  if (w.bossFireTimer > 0) {
    w.bossFireTimer -= 1;
    return;
  }
  w.bossFireTimer = BOSS_FIRE_PERIOD;
  if (!w.craft.alive || w.craft.deathTicks > 0 || w.alienFireDelay > 0) return;

  const bot = bots[Math.floor(w.tick / BOSS_FIRE_PERIOD) % bots.length];
  if (!bot) return;

  const realIndex = rngInt(w, BOSS_BURST);
  let fired = 0;
  let real = 0;
  for (let k = 0; k < BOSS_BURST; k += 1) {
    const free = w.bossShots.find((s) => !s.active && s.blowupTicks === 0);
    if (!free) break;
    const offset = BOSS_BURST_OFFSETS[k % BOSS_BURST_OFFSETS.length] ?? 0;
    const x = Math.min(
      w.width - ALIEN_SHOT_W,
      Math.max(0, bot.x + offset * ALIEN_CELL_W + ALIEN_CELL_W / 2 - ALIEN_SHOT_W / 2),
    );
    const isReal = k === realIndex && real < BOSS_REAL_PER_BURST;
    if (isReal) real += 1;
    launchShot(free, x, bot.y + ALIEN_CELL_H, isReal ? 'rolling' : 'decoy', 'bot');
    fired += 1;
  }
  if (fired === 0) w.bossFireTimer = BOSS_FIRE_PERIOD;
}

// ---- 8 · the bonus ----------------------------------------------------------

function tickSaucer(w: World): void {
  const s = w.saucer;

  if (s.showHitTicks > 0) {
    s.showHitTicks -= 1;
    if (s.showHitTicks === 0) {
      s.active = false;
      s.showScore = 0;
    }
    return;
  }

  if (s.active) {
    s.x += s.dx;
    if (s.x + SAUCER_W < 0 || s.x > w.width) {
      s.active = false;
      w.events.push({ type: 'saucerGone' });
    }
    return;
  }

  // The timer only runs once the rack has dropped at least once, so the bonus
  // cannot appear in the first seconds of a wave.
  const startY = RACK_START_Y[(w.wave - 1) & 7] ?? 96;
  if (w.rackY <= startY) return;

  if (w.saucerTimer > 0) {
    w.saucerTimer -= 1;
    return;
  }

  // THE OTHER HALF OF THE SHARED SLOT. `alienFire` already refuses to launch a
  // squiggly while the bonus is up; the exclusion has to hold in this direction
  // too or a shot launched on tick T and a bonus spawned on T+1 are both live,
  // which the original cannot produce. The timer is deliberately NOT reset here:
  // the bonus waits for the slot and launches the moment it frees, rather than
  // being sent to the back of another 1536-tick queue.
  const squiggly = w.alienShots[2];
  if (squiggly && (squiggly.active || squiggly.blowupTicks > 0)) return;

  w.saucerTimer = SAUCER_TIMER;
  if (w.liveCount < SAUCER_MIN_ALIENS) return;
  if (!w.craft.alive) return;

  // Direction from the shot count's low bit — odd enters from the left. The
  // original does exactly this, which is why the bonus is predictable to anyone
  // who is already counting shots for the 300.
  const fromLeft = (w.playerShotCount & 1) === 1;
  const speed = saucerSpeed(w.width);
  s.active = true;
  s.y = SAUCER_LANE_Y;
  s.showHitTicks = 0;
  s.showScore = 0;
  s.x = fromLeft ? -SAUCER_W : w.width;
  s.dx = fromLeft ? speed : -speed;
  w.events.push({ type: 'saucerSpawn' });
}

// ---- 9 · timers -------------------------------------------------------------

function tickTimers(w: World): void {
  for (let i = w.explosions.length - 1; i >= 0; i -= 1) {
    const e = w.explosions[i];
    if (!e) continue;
    e.ticks -= 1;
    if (e.ticks <= 0) w.explosions.splice(i, 1);
  }

  for (const a of w.aliens) {
    if (a.hitTicks > 0) a.hitTicks -= 1;
    if (a.ciRespawnAt === null || w.tick < a.ciRespawnAt) continue;
    a.ciRespawnAt = null;
    if (a.alive || a.ciRespawned) continue;
    // A CI failure comes back ONCE — but only if its column is still alive.
    // Clearing the whole column (with FOCUS, say) is what makes it stay dead,
    // and that reward falls out of this rule rather than being special-cased.
    if (!columnHasLive(w, a.col)) continue;
    reviveSlot(w, a, 'ci', 1);
    a.ciRespawned = true;
  }
}

// ---- 10 · the wave ----------------------------------------------------------

function endWave(w: World): void {
  w.phase = 'waveBreak';
  w.waveBreakTicks = WAVE_BREAK_TICKS;
  w.playerShot.active = false;
  w.playerShot.blowupTicks = 0;
  for (const s of w.alienShots) deactivateShot(s);
  for (const s of w.bossShots) deactivateShot(s);
  w.saucer.active = false;
  w.saucer.showHitTicks = 0;
  w.focusHold = 0;
  w.focusColumn = null;
  w.events.push({ type: 'waveCleared', wave: w.wave });
}
