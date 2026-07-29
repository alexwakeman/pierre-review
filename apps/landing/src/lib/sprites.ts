// ---------------------------------------------------------------------------
// The sprite bitmaps, from design_handoff_feint/sprites.json.
//
// Nine original bitmaps: eight "aliens" (the things that arrive in your inbox)
// plus the player craft. On the site they are drawn in ink and vermilion and
// read as a DIAGRAM; inside the arcade game they invert onto black and read as
// a threat. Same bitmaps, two registers.
//
// Kept as a .ts module rather than importing the .json so the browser bundle and
// the SSR prerender pass resolve it identically — the prerenderer runs a separate
// `vite build --ssr`, and JSON-import behaviour is one more thing that would have
// to agree across two builds for no benefit.
//
// ENCODING (from the file's own $meta): rows are strings, one character = one
// cell. 'x' = primary colour, 'a' = accent colour, '.' = transparent. Rows are
// padded to the longest with '.' before rendering; the grids happen to be
// rectangular already but the rule is defensive and is implemented below.
//
// RENDERING: draw at an INTEGER cell size and never anti-alias. The runs below
// are coalesced horizontally at module load (143 runs across all nine sprites,
// versus 246 individual cells), which is what a <rect>-per-run SVG needs.
// ---------------------------------------------------------------------------

export type SpriteName =
  | 'bell'
  | 'chat'
  | 'repo'
  | 'bot'
  | 'thread'
  | 'ci'
  | 'review'
  | 'at'
  | 'craft';

/** A horizontal run of same-coloured cells: `w` cells wide at (x, y). */
export type SpriteRun = { x: number; y: number; w: number; accent: boolean };

export type SpriteData = {
  /** What the sprite depicts — used for alt text / aria-label. */
  label: string;
  cols: number;
  rows: number;
  runs: SpriteRun[];
};

const SOURCE: Record<SpriteName, { label: string; rows: string[] }> = {
  bell: {
    label: 'Generic notification',
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
  chat: {
    label: 'Chat / message ping',
    rows: [
      '.xxxxxxx.',
      'x.......x',
      'x.a.a.a.x',
      'x.......x',
      '.xxxxxxx.',
      '..x......',
      '.x.......',
    ],
  },
  repo: {
    label: 'Repo event (branch / push)',
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
  bot: {
    label: 'AI review bot',
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
  thread: {
    label: 'Thread reply / nested mention',
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

/** Every alien, in the file's own order. The player craft is deliberately excluded. */
export const ALIEN_NAMES: SpriteName[] = [
  'bell',
  'chat',
  'repo',
  'bot',
  'thread',
  'ci',
  'review',
  'at',
];
