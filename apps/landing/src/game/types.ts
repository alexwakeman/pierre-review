import type { AlienName } from '../lib/sprites';

// ---------------------------------------------------------------------------
// The engine's data model.
//
// Every type here describes PLAIN DATA. There are no methods, no classes and no
// getters: `World` is a bag of numbers that `tick()` mutates in place and that
// `render.ts` reads without touching. That is deliberate — a fixed-timestep
// simulation that can be stepped in a bare Node process is the only way the
// march can be reasoned about (and, if it ever needs to be, unit-tested) without
// a browser.
//
// Two conventions run through the whole file:
//
//   · POSITIONS ARE FIELD-SPACE LOGICAL UNITS. The origin is the top-left of the
//     play field, +y is DOWN, and one unit is one CSS pixel at the reference
//     width. Nothing here knows about devicePixelRatio, CSS pixels or the DOM.
//
//   · COUNTDOWNS ARE TICKS AND COUNT DOWN TO ZERO. A `…Ticks` field at 0 means
//     "not happening"; every one of them is decremented in exactly one place, so
//     there is never a question about which system owns a timer.
//
// The one field that is not in the published contract is `shotSpeedLatched`, and
// the note on it explains why it has to exist.
// ---------------------------------------------------------------------------

export type Phase = 'attract' | 'playing' | 'waveBreak' | 'gameOver';

/**
 * Raw HELD-key state, sampled by the host once per tick.
 *
 * The engine owns edge detection, not the host: `fire` being true on two
 * consecutive ticks must not fire twice, and that rule belongs next to the
 * shot slot it protects rather than in a keyboard handler that cannot see it.
 */
export type Input = {
  left: boolean;
  right: boolean;
  fire: boolean;
  focus: boolean;
};

export type AlienShotStyle =
  | 'rolling' // the tracker — aims at the player's column
  | 'plunger' // column table; DISABLED entirely when one alien remains
  | 'squiggly' // column table; shares its slot with the bonus
  | 'homing' // fired by an `at`; drifts toward the craft
  | 'meeting' // fired by a `meeting`; FREEZES instead of killing
  | 'decoy'; // a boss comment that is not real

export type Alien = {
  id: number;
  /** row * columns + col. Stable for the life of the wave. */
  slot: number;
  row: number;
  col: number;
  name: AlienName;
  alive: boolean;
  hp: number;
  /**
   * TOP-LEFT of the alien's ALIEN_CELL_W × ALIEN_CELL_H cell — updated ONLY when
   * the march cursor reaches this alien, never from the rack origin directly.
   *
   * The resulting per-alien lag is what produces the visible ripple of the
   * march: with N aliens alive, the alien the cursor is about to reach is a full
   * N ticks behind the one it just left. It is the original's behaviour and the
   * single most recognisable thing about it — it must not be smoothed away.
   */
  x: number;
  y: number;
  /** Animation phase adopted when the cursor last reached it: 0 | 1. */
  frame: 0 | 1;
  /** >0 → draw in the paperHit palette this tick. */
  hitTicks: number;
  /** Tick at which a cleared `ci` attempts its single respawn, or null. */
  ciRespawnAt: number | null;
  ciRespawned: boolean;
};

export type PlayerShot = {
  active: boolean;
  x: number;
  y: number;
  /** >0 while the miss/shield explosion plays out; the slot is HELD, no new fire. */
  blowupTicks: number;
};

export type AlienShot = {
  active: boolean;
  x: number;
  y: number;
  style: AlienShotStyle;
  /** The type that fired it — drives missedByType and the meeting/homing rules. */
  from: AlienName;
  /**
   * Steps taken since launch. THE reload gate reads this, so it must NOT be
   * reset mid-flight: a shot that has travelled far is what permits the next
   * launch, and zeroing it would cluster three shots into one vertical line.
   */
  steps: number;
  /** Ticks since the last advance; the shot advances when this reaches SHOT_MOVE_PERIOD. */
  moveTick: number;
  /** 0..3 sprite animation frame. */
  animFrame: number;
  blowupTicks: number;
};

export type Explosion = {
  x: number;
  y: number;
  ticks: number;
  kind: 'burst' | 'shot';
};

export type Saucer = {
  active: boolean;
  x: number;
  y: number;
  dx: number;
  /** >0 while the award is being shown in place. */
  showHitTicks: number;
  showScore: number;
};

export type Bunker = {
  /** Field-space top-left. */
  x: number;
  y: number;
  cols: number;
  rows: number;
  /** cols*rows, row-major. 1 = solid, 0 = eroded. */
  cells: Uint8Array;
};

/**
 * What the engine says happened this tick.
 *
 * Events are PURE DATA with no side effects attached, because two very different
 * consumers read the same queue: the audio bridge (which turns them into
 * oscillators) and the React layer (which turns some of them into copy). If the
 * engine called `playSound` directly it would need an AudioContext, which would
 * make it unrunnable outside a browser and untestable everywhere.
 */
export type GameEvent =
  | { type: 'fire' }
  | { type: 'alienCleared'; name: AlienName; points: number }
  | { type: 'alienDamaged'; name: AlienName }
  | { type: 'playerHit' }
  | { type: 'playerFrozen' }
  | { type: 'unread'; name: AlienName }
  | { type: 'focusCharging' }
  | { type: 'focusSpent'; column: number; cleared: number }
  | { type: 'focusGained' }
  | { type: 'bunkerHit' }
  | { type: 'saucerSpawn' }
  | { type: 'saucerHit'; points: number }
  | { type: 'saucerGone' }
  | { type: 'extraLife' }
  | { type: 'waveCleared'; wave: number }
  | { type: 'waveStart'; wave: number }
  | { type: 'gameOver'; score: number; cleared: number; unread: number };

/** What the React layer reads. Published at most every 4 ticks (~15 Hz). */
export type HudSnapshot = {
  phase: Phase;
  wave: number;
  score: number;
  cleared: number;
  unread: number;
  lives: number;
  /** 0..5 */
  focus: number;
  focusCharging: boolean;
  /** The craft is in a meeting. Drives the DOM "IN A MEETING" caption. */
  frozen: boolean;
  /** Floating bonus award, in LOGICAL field units, or null. */
  saucerScore: { x: number; y: number; points: number } | null;
  /** Ticks remaining on the wave-break hold; 0 outside `waveBreak`. */
  waveBreakTicks: number;
};

/** The game-over panel's data. `needsYou` is itemised, everything else collapses. */
export type GameSummary = {
  score: number;
  cleared: number;
  unread: number;
  wave: number;
  /** `review` and `at` only, in that order, zero-count entries omitted. */
  needsYou: { name: AlienName; count: number; label: string }[];
  /** Every other missed type, summed. */
  digestible: number;
};

export type WorldOptions = {
  /** Already through `logicalWidth()`. */
  width: number;
  reducedMotion: boolean;
  /** LCG seed for the boss burst spread. Defaults to 0x5EED. */
  seed?: number;
};

export type World = {
  phase: Phase;
  tick: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  reducedMotion: boolean;
  /**
   * The LCG state. The engine NEVER calls Math.random: the only stochastic
   * decision in the whole game (which of a boss burst's six comments is real) is
   * drawn from here, so a session replays identically from its seed and a bug in
   * it is reproducible.
   */
  rng: number;

  wave: number;
  score: number;
  cleared: number;
  unread: number;
  lives: number;
  focus: number;
  extraLifeAwarded: boolean;
  missedByType: Record<AlienName, number>;

  aliens: Alien[];
  liveCount: number;
  marchCursor: number;
  rackX: number;
  rackY: number;
  rackDx: number;
  rackDy: number;
  animPhase: 0 | 1;
  rackLeft: number;
  rackRight: number;
  rackExtentDirty: boolean;
  alienExplodeTicks: number;
  clearsSinceThreadSpawn: number;

  craft: {
    x: number;
    alive: boolean;
    frozenTicks: number;
    deathTicks: number;
    respawnTicks: number;
    beamTicks: number;
    /**
     * Consumes the ONE keypress that started the game, so the same Space does
     * not also launch a shot. Cleared the moment the key is seen released, and
     * never set again — firing itself does NOT set it, because the original
     * polls the fire button every frame and relaunches the instant the shot slot
     * frees. Holding fire therefore auto-repeats, exactly as the arcade does;
     * the single-shot-on-screen rule is what stops it being spray fire (measured
     * ceiling: 99 shots per 90 s held, against 90 tapped).
     */
    fireLatch: boolean;
    /**
     * The same bounce for FOCUS, and it matters more: a segment is the scarcer
     * resource (refilled only by clearing review requests and the bonus), so
     * without this one uninterrupted press of F drains the entire meter.
     */
    focusBounce: boolean;
  };

  playerShot: PlayerShot;
  playerShotCount: number;
  /** Fixed length 3: [rolling, plunger, squiggly]. */
  alienShots: AlienShot[];
  /** Fixed length MAX_BOSS_SHOTS. */
  bossShots: AlienShot[];
  /** 0 | 1 | 2 — which alien-shot slot may LAUNCH this tick. */
  shotSync: 0 | 1 | 2;
  alienFireDelay: number;
  reloadRate: number;
  plungerIndex: number;
  squigglyIndex: number;
  bossFireTimer: number;
  /**
   * NOT IN THE PUBLISHED CONTRACT — additive, and here is why it has to be.
   *
   * The original speeds alien fire up PERMANENTLY once eight or fewer aliens
   * remain, for the rest of the wave. `liveCount` cannot express "permanently",
   * because in this game it can go back UP: a cleared `ci` respawns and a `group`
   * splits into two channel pings. Testing `liveCount <= 8` directly would make
   * the shot speed flicker between 7 and 9 as the rack revives, which is a
   * different (and much worse) mechanic. This latches, and is cleared per wave.
   */
  shotSpeedLatched: boolean;

  explosions: Explosion[];
  saucer: Saucer;
  saucerTimer: number;
  saucerScoreIndex: number;

  bunkers: Bunker[];
  notebook: { x: number; y: number };

  focusHold: number;
  focusColumn: number | null;

  waveBreakTicks: number;

  /** Drained by the host each tick via `drainEvents`. Never read directly. */
  events: GameEvent[];
};
