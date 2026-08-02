// ---------------------------------------------------------------------------
// The sprite bitmaps, from limn_game_handoff/sprites.json.
//
// Fifteen original bitmaps: the twelve "aliens" (the things that arrive in your
// inbox), the player craft, and the two effect marks. On the site they are drawn
// in ink and vermilion and read as a DIAGRAM; inside the arcade cabinet they are
// the game's entire vocabulary. Same bitmaps, two registers, one source.
//
// Kept as a .ts module rather than importing the .json so the browser bundle and
// the SSR prerender pass resolve it identically — the prerenderer runs a separate
// `vite build --ssr`, and JSON-import behaviour is one more thing that would have
// to agree across two builds for no benefit. It is also why the metadata below
// (rank, points, the one-line behaviour) lives here: the /arcade page prints
// those strings as prose, so they must be in the prerendered HTML, and the game
// scores from the same table the page describes.
//
// ENCODING (from the file's own $meta): rows are strings, one character = one
// cell. 'x' = primary colour, 'a' = accent colour, '.' = transparent. Rows are
// padded to the longest with '.' before rendering; the grids happen to be
// rectangular already but the rule is defensive and is implemented below.
//
// RENDERING: draw at an INTEGER cell size and never anti-alias. The runs below
// are coalesced horizontally at module load (233 runs across all fifteen
// sprites, versus 482 individual cells), which is what a <rect>-per-run SVG and
// a fillRect-per-run canvas both want.
//
// `burst` and `miss` DIFFER BY EXACTLY ONE PIXEL — the centre cell at (2, 2),
// hollow in `burst` and closed in `miss`. That single cell is the whole
// distinction between "you cleared it" and "it got past you"; transcribe it
// carefully if these two are ever touched again.
// ---------------------------------------------------------------------------

/** All fifteen bitmaps. Twelve aliens, the player craft, two effect marks. */
export type SpriteName =
  // rank 1 · Chatter
  | 'channel'
  | 'group'
  | 'bell'
  | 'notebook'
  // rank 2 · Comms & calendar
  | 'email'
  | 'meeting'
  | 'at'
  | 'thread'
  // rank 3 · Engineering
  | 'repo'
  | 'review'
  | 'ci'
  // boss
  | 'bot'
  // player
  | 'craft'
  // fx
  | 'burst'
  | 'miss';

/** The twelve notification types. Excludes the craft and the two fx bitmaps. */
export type AlienName =
  | 'channel'
  | 'group'
  | 'bell'
  | 'notebook'
  | 'email'
  | 'meeting'
  | 'at'
  | 'thread'
  | 'repo'
  | 'review'
  | 'ci'
  | 'bot';

/** A horizontal run of same-coloured cells: `w` cells wide at (x, y). */
export type SpriteRun = { x: number; y: number; w: number; accent: boolean };

export type SpriteData = {
  /** What the sprite depicts — used for alt text / aria-label. */
  label: string;
  cols: number;
  rows: number;
  runs: SpriteRun[];
};

export type SpriteRank = 1 | 2 | 3 | 'boss';

export type AlienMeta = {
  /** The handoff's rank. Drives points and the formation row. */
  rank: SpriteRank;
  /** The brief's scale — 10 / 25 / 50 / 250, NOT the 1978 original's 10/20/30. */
  points: number;
  /** "Channel ping", "Group chat", … — sentence case, from sprites.json. */
  label: string;
  /** "Slack-class", "any app", "pipeline", … — the caption names the source. */
  source: string;
  /** The one-line behaviour string from sprites.json, printed verbatim on /arcade. */
  behaviour: string;
};

export type SpritePaletteName = 'paper' | 'paperHit' | 'game' | 'gameHit';
export type SpritePalette = {
  /** Colour for 'x' cells. */
  fill: string;
  /** Colour for 'a' cells. */
  accent: string;
  /** The surface these two are legible on. Informational. */
  on: string;
};

const SOURCE: Record<SpriteName, { label: string; rows: string[] }> = {
  channel: {
    label: 'Channel ping',
    rows: [
      '.xxxxxxx.',
      'x.......x',
      'x.a.a...x',
      'x.aaaaa.x',
      'x.a.a...x',
      '.xxxxxxx.',
      '..x......',
      '.x.......',
    ],
  },
  group: {
    label: 'Group chat',
    rows: [
      'xxxxxx.....',
      'x.aa.x.....',
      'xxxxxx.....',
      '.x.........',
      '...xxxxxxx.',
      '...x.....x.',
      '...x.aaa.x.',
      '...xxxxxxx.',
      '.....x.....',
    ],
  },
  bell: {
    label: 'Generic alert',
    rows: [
      '...xx...',
      '..xxxx..',
      '.xxxxxx.',
      '.xxxxxx.',
      'xxxxxxxx',
      'xxxxxxxx',
      '..aaaa..',
      '...aa...',
    ],
  },
  notebook: {
    label: 'Notebook scribble',
    rows: [
      'xxxxxxxx',
      'x......x',
      'x.aaa..x',
      'x......x',
      'x.aaaa.x',
      'x......x',
      'x.aa...x',
      'xxxxxxxx',
    ],
  },
  email: {
    label: 'Email',
    rows: [
      'xxxxxxxxxx',
      'xa......ax',
      'x.aa..aa.x',
      'x...aa...x',
      'x........x',
      'x........x',
      'x........x',
      'xxxxxxxxxx',
    ],
  },
  meeting: {
    label: 'Meeting invite',
    rows: [
      'xxxxxxx...',
      'x.....x..x',
      'x.aaa.x.xx',
      'x.aaa.xxxx',
      'x.aaa.x.xx',
      'x.....x..x',
      'xxxxxxx...',
    ],
  },
  at: {
    label: '@-mention',
    rows: [
      '.xxxxxx.',
      'x......x',
      'x.axxa.x',
      'x.x..x.x',
      'x.axxa.x',
      'x......x',
      '.xxxx...',
      '....xxx.',
    ],
  },
  thread: {
    label: 'Thread reply',
    rows: [
      'xxxxxxx..',
      'x.....x..',
      'xxxxxxx..',
      '..x......',
      '..x......',
      '..xxxxxxx',
      '..x.....x',
      '..xxxxxxx',
      '....a....',
    ],
  },
  repo: {
    label: 'Repo event',
    rows: [
      '..a....a..',
      '..x....x..',
      '..x...xx..',
      '..x..xx...',
      '..xxxx....',
      '..x.......',
      '..x.......',
      '..a.......',
    ],
  },
  review: {
    label: 'Review request',
    rows: [
      '..xxxx..',
      '.x....x.',
      'x..aa..x',
      'x.aaaa.x',
      'x..aa..x',
      '.x....x.',
      '..xxxx..',
    ],
  },
  ci: {
    label: 'CI failure',
    rows: [
      'xxxxxxxx',
      'xa....ax',
      'x.a..a.x',
      'x..aa..x',
      'x..aa..x',
      'x.a..a.x',
      'xa....ax',
      'xxxxxxxx',
    ],
  },
  bot: {
    label: 'Review bot',
    rows: [
      '....x....',
      '...xxx...',
      '.xxxxxxx.',
      'x.......x',
      'x.aa.aa.x',
      'x.......x',
      'x.xxxxx.x',
      '.xxxxxxx.',
      '..x...x..',
    ],
  },
  craft: {
    label: 'The triage caret',
    rows: [
      '.....x.....',
      '....xax....',
      '...xaaax...',
      '..xxaaaxx..',
      '.xxxxaxxxx.',
      'xxxxxxxxxxx',
      'x.xx...xx.x',
      'a..a...a..a',
    ],
  },
  burst: {
    label: 'Cleared',
    rows: ['a...a', '.a.a.', '.....', '.a.a.', 'a...a'],
  },
  miss: {
    label: 'Missed',
    rows: ['a...a', '.a.a.', '..a..', '.a.a.', 'a...a'],
  },
};

/** Coalesce each row's consecutive same-colour cells into horizontal runs. */
function decode(rows: string[]): { cols: number; rows: number; runs: SpriteRun[] } {
  const cols = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const runs: SpriteRun[] = [];

  rows.forEach((raw, y) => {
    const row = raw.padEnd(cols, '.');
    let x = 0;
    while (x < cols) {
      const ch = row[x];
      if (ch !== 'x' && ch !== 'a') {
        x += 1;
        continue;
      }
      let w = 1;
      while (x + w < cols && row[x + w] === ch) w += 1;
      runs.push({ x, y, w, accent: ch === 'a' });
      x += w;
    }
  });

  return { cols, rows: rows.length, runs };
}

export const SPRITES: Record<SpriteName, SpriteData> = Object.fromEntries(
  Object.entries(SOURCE).map(([name, { label, rows }]) => [name, { label, ...decode(rows) }]),
) as Record<SpriteName, SpriteData>;

/**
 * The twelve aliens in the handoff's own order — rank 1 first, the boss last.
 * The player craft and the two effect marks are deliberately excluded: this is
 * the list of things that arrive at you, which is what both the site figure and
 * the /arcade rack table enumerate.
 */
export const ALIEN_NAMES: readonly AlienName[] = [
  'channel',
  'group',
  'bell',
  'notebook',
  'email',
  'meeting',
  'at',
  'thread',
  'repo',
  'review',
  'ci',
  'bot',
];

/** Points by rank. Every `ALIEN_META` entry scores its rank's value, no exceptions. */
export const RANK_POINTS: Record<SpriteRank, number> = {
  1: 10,
  2: 25,
  3: 50,
  boss: 250,
};

/**
 * Per-type metadata — the single source of truth for points and for the /arcade
 * page's twelve-row table. `behaviour` is quoted verbatim from sprites.json; the
 * engine implements it, the page prints it, and the two must not drift.
 *
 * ONE DELIBERATE NARROWING. `channel` drops sprites.json's leading "Drifts
 * sideways." — the rack is ONE uniform grid stepped a single alien per tick, so
 * there is no per-type horizontal offset for that sentence to describe, and
 * inventing one would take an alien off the grid the march, the column-fire table
 * and the FOCUS column-clear all depend on. The page must not print a mechanic
 * the engine does not have; the handoff file itself is a design source and is
 * left untouched (the bitmaps are machine-verified against it).
 */
export const ALIEN_META: Record<AlienName, AlienMeta> = {
  channel: {
    rank: 1,
    points: RANK_POINTS[1],
    label: 'Channel ping',
    source: 'Slack-class',
    behaviour: 'Harmless alone, arrives in fives.',
  },
  group: {
    rank: 1,
    points: RANK_POINTS[1],
    label: 'Group chat',
    source: 'Teams-class',
    behaviour: 'Splits into two channel pings when cleared.',
  },
  bell: {
    rank: 1,
    points: RANK_POINTS[1],
    label: 'Generic alert',
    source: 'any app',
    behaviour: 'The filler. Cheap points, infinite supply.',
  },
  notebook: {
    rank: 1,
    points: RANK_POINTS[1],
    label: 'Notebook scribble',
    source: 'analogue',
    behaviour: 'Does not descend. Sits at the edge of the field and never goes away.',
  },
  email: {
    rank: 2,
    points: RANK_POINTS[2],
    label: 'Email',
    source: 'mail-class',
    behaviour: 'Slow, heavy, takes two hits. Stacks if ignored.',
  },
  meeting: {
    rank: 2,
    points: RANK_POINTS[2],
    label: 'Meeting invite',
    source: 'Meet / calendar-class',
    behaviour: 'Freezes the player craft for one beat when it lands.',
  },
  at: {
    rank: 2,
    points: RANK_POINTS[2],
    label: '@-mention',
    source: 'any app',
    behaviour: "Homes toward the player. The one you can't ignore.",
  },
  thread: {
    rank: 2,
    points: RANK_POINTS[2],
    label: 'Thread reply',
    source: 'any app',
    behaviour: 'Spawns behind a cleared sprite. The reply-all tax.',
  },
  repo: {
    rank: 3,
    points: RANK_POINTS[3],
    label: 'Repo event',
    source: 'GitHub-class',
    behaviour: 'Push / branch. Fast, low value, constant.',
  },
  review: {
    rank: 3,
    points: RANK_POINTS[3],
    label: 'Review request',
    source: 'GitHub-class',
    behaviour:
      'High value. Clearing it is what THREADS CLEARED counts, and the only thing that refills FOCUS.',
  },
  ci: {
    rank: 3,
    points: RANK_POINTS[3],
    label: 'CI failure',
    source: 'pipeline',
    behaviour: 'Re-spawns once unless the whole column is cleared.',
  },
  bot: {
    rank: 'boss',
    points: RANK_POINTS.boss,
    label: 'Review bot',
    source: 'CodeRabbit-class',
    behaviour: 'Fires forty comments; three are real. Shoot the three.',
  },
};

/**
 * The four palettes, verbatim from sprites.json's $meta.
 *
 * `paper` / `paperHit` are the site and the Inked cabinet; `game` / `gameHit`
 * are the inverted dark register. `on` records the surface each pair was
 * contrast-checked against and is informational — recolouring a sprite is a
 * palette swap and nothing else.
 */
export const SPRITE_PALETTES: Record<SpritePaletteName, SpritePalette> = {
  paper: { fill: '#2A2A2E', accent: '#C13A20', on: '#FAFAF8' },
  paperHit: { fill: '#C13A20', accent: '#E2492C', on: '#FAFAF8' },
  game: { fill: '#F5F5F2', accent: '#E2492C', on: '#16161A' },
  gameHit: { fill: '#F26B4E', accent: '#FBD5CC', on: '#16161A' },
};
