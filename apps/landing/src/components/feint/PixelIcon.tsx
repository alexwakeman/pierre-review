// ---------------------------------------------------------------------------
// Section icons — 8-bit glyphs in the game's visual family.
//
// Each promo-page section opens with one of these: an 11×9 pixel grid drawn in
// ink with a VERY small vermilion accent (1–4 cells). They are deliberately in
// the same register as the arcade sprites and the wordmark — crispEdges SVG,
// integer cells, two colours — but they live in their OWN registry: the game's
// SPRITES table is handoff data with gameplay meaning, and marketing icons
// must be free to change without touching it.
//
// The art is authored as string grids ('.' empty · 'x' ink · 'a' accent) so a
// glyph can be read and edited in place. The parser converts rows to runs at
// module load and THROWS on a malformed grid (wrong row length/count, unknown
// char) — the prerenderer imports this module at build time, so bad art fails
// the build loudly instead of shipping a scrambled icon.
//
// Vermilion discipline: the accent cells mark the one part of each glyph where
// "a human / the signal" lives — the flagged feed item, the stalled bar's tip,
// the check's point of contact. Never more than a whisper.
// ---------------------------------------------------------------------------

const COLS = 11;
const ROWS = 9;

const ICON_ART = {
  /** A changelog-like list; the flagged item's bullet is the accent. */
  feed: [
    '...........',
    '.x.xxxxxxx.',
    '...........',
    '.a.xxxxx...',
    '...........',
    '.x.xxxxxx..',
    '...........',
    '.x.xxxx....',
    '...........',
  ],
  /** A conversation and its reply — the two open points accented. */
  threads: [
    '.xxxxxxx...',
    '.x.....x...',
    '.x.a.a.x...',
    '.x.....x...',
    '.xxxxxxx...',
    '...x.......',
    '......xxxx.',
    '......x..x.',
    '......xxxx.',
  ],
  /** PR bars in lanes; the long bar's stalled tip is the accent. */
  timeline: [
    '...........',
    '.xxxxx.....',
    '...........',
    '.xxxxxxxa..',
    '...........',
    '.xxx.......',
    '...........',
    '.xxxxxx....',
    '...........',
  ],
  /** A console; the prompt block is the accent. */
  console: [
    'xxxxxxxxxxx',
    'x.........x',
    'x.aa......x',
    'x.........x',
    'x.xxxxx...x',
    'x.........x',
    'xxxxxxxxxxx',
    '....xxx....',
    '...xxxxx...',
  ],
  /** A pull request — branch head accented, merging home. */
  pr: [
    '.xx.....aa.',
    '.xx.....aa.',
    '..x......x.',
    '..x......x.',
    '..x.....x..',
    '..x....x...',
    '..x..xxx...',
    '.xxxx......',
    '.xx........',
  ],
  /** The receipt — one line of it is the one that matters. */
  receipt: [
    '.xxxxxxx...',
    '.x.....x...',
    '.x.xxx.x...',
    '.x.....x...',
    '.x.xx..x...',
    '.x.....x...',
    '.x.aa..x...',
    '.x.....x...',
    '.x.x.x.x...',
  ],
  /** A magnifier with a glint. */
  search: [
    '..xxxx.....',
    '.x....x....',
    '.x.a..x....',
    '.x....x....',
    '.x....x....',
    '..xxxx.....',
    '.....xx....',
    '......xx...',
    '.......xx..',
  ],
  /** A bolt; the point of impact is the accent. */
  speed: [
    '.....xxx...',
    '....xxx....',
    '...xxxx....',
    '..xxxxxxx..',
    '.....xxx...',
    '....xxx....',
    '...xxx.....',
    '...xx......',
    '...a.......',
  ],
  /** The model — a chip with a small live core. */
  chip: [
    '..x.x.x.x..',
    '.xxxxxxxxx.',
    '.x.......x.',
    '.x..aa...x.',
    '.x.......x.',
    '.xxxxxxxxx.',
    '..x.x.x.x..',
    '...........',
    '...........',
  ],
  /** The severity mix — one small bar is the one to watch. */
  bars: [
    '...........',
    '...........',
    '........xx.',
    '........xx.',
    '....xx..xx.',
    '.aa.xx..xx.',
    '.aa.xx..xx.',
    '.aa.xx..xx.',
    '...........',
  ],
  /** A coin, cost made visible. */
  coin: [
    '...xxxxx...',
    '..x.....x..',
    '.x...x...x.',
    '.x..xxx..x.',
    '.x...a...x.',
    '.x..xxx..x.',
    '.x...x...x.',
    '..x.....x..',
    '...xxxxx...',
  ],
  /** Noise — the far edge of the wave is where it lands. */
  noise: [
    '...........',
    '....x......',
    '...xx..x...',
    '.xxxx...x..',
    '.xxxx.x..a.',
    '.xxxx...x..',
    '...xx..x...',
    '....x......',
    '...........',
  ],
  /** The verdict — a check, its point of contact accented. */
  verdict: [
    '.xxxxxxxxx.',
    '.x.......x.',
    '.x.....a.x.',
    '.x....x..x.',
    '.x.x.x...x.',
    '.x..x....x.',
    '.x.......x.',
    '.xxxxxxxxx.',
    '...........',
  ],
  /** The digest — one line of the report needs you. */
  digest: [
    '.xxxxxxxx..',
    '.x......x..',
    '.x.xxxx.x..',
    '.x......x..',
    '.x.aa...x..',
    '.x......x..',
    '.x.xxx..x..',
    '.x......x..',
    '.xxxxxxxx..',
  ],
  /** Judgement — scales, one pan carrying the signal. */
  scales: [
    '.....x.....',
    '.xxxxxxxxx.',
    '.x...x...x.',
    'xxx..x..xax',
    '.....x.....',
    '.....x.....',
    '.....x.....',
    '....xxx....',
    '...xxxxx...',
  ],
  /** Themes — the same wave, recurring; one vertex flagged. */
  themes: [
    '...........',
    '.x...x...x.',
    '..x.x.x.x..',
    '...x...x...',
    '...........',
    '.x...x...x.',
    '..x.x.x.x..',
    '...a...x...',
    '...........',
  ],
  /** Chat with charts — the answer as a picture, one bar accented. */
  chat: [
    '.xxxxxxxxx.',
    '.x.......x.',
    '.x.......x.',
    '.x.....x.x.',
    '.x...a.x.x.',
    '.x.x.a.x.x.',
    '.x.x.a.x.x.',
    '.xxxxxxxxx.',
    '..xx.......',
  ],
  /** Red CI — the exclamation is the accent. */
  warning: [
    '.....x.....',
    '....xxx....',
    '....x.x....',
    '...x.a.x...',
    '...x.a.x...',
    '..x..a..x..',
    '..x.....x..',
    '.x...a...x.',
    '.xxxxxxxxx.',
  ],
  /** The reviewer that isn't human — eyes on. */
  robot: [
    '..x.....x..',
    '.xxxxxxxxx.',
    '.x.......x.',
    '.x.a...a.x.',
    '.x.......x.',
    '.x..xxx..x.',
    '.xxxxxxxxx.',
    '...........',
    '...........',
  ],
  /** The fix — a wrench, human hand at the end of it. */
  wrench: [
    '.......xx..',
    '......x..x.',
    '......x..x.',
    '.....xx.xx.',
    '....xx.....',
    '...xx......',
    '..xx.......',
    '.xx........',
    '.a.........',
  ],
  /** Control — a shield with the keyhole yours. */
  shield: [
    '.xxxxxxxxx.',
    '.x.......x.',
    '.x.......x.',
    '.x...a...x.',
    '.x...a...x.',
    '..x.....x..',
    '...x...x...',
    '....x.x....',
    '.....x.....',
  ],
  /** The pipeline — one direction, the tip accented. */
  arrow: [
    '...........',
    '.......x...',
    '.......xx..',
    '.xxxxxxxxa.',
    '.......xx..',
    '.......x...',
    '...........',
    '...........',
    '...........',
  ],
  /** Sync — the cycle, its two leading edges accented. */
  sync: [
    '...xxxx.a..',
    '..x....x...',
    '.x.........',
    '.x.........',
    '.........x.',
    '.........x.',
    '...x....x..',
    '..a.xxxx...',
    '...........',
  ],
  /** Two modes, one link. */
  modes: [
    '...........',
    '.xxxx......',
    '.x..x......',
    '.x..x......',
    '.xxxx......',
    '.....aa....',
    '.......xxxx',
    '.......x..x',
    '.......xxxx',
  ],
  /** The roadmap — a flag planted, its far corner still being sewn. */
  flag: [
    '.x.........',
    '.xxxxxx....',
    '.x....x....',
    '.xxxxxa....',
    '.x.........',
    '.x.........',
    '.x.........',
    '.x.........',
    '.x.........',
  ],
  /** Your key. */
  key: [
    '...........',
    '...........',
    '.xxx.......',
    '.x.x.xxxxx.',
    '.xxx....x.a',
    '...........',
    '...........',
    '...........',
    '...........',
  ],
  /** The question, and its point. */
  question: [
    '...........',
    '..xxxx.....',
    '.x....x....',
    '......x....',
    '.....x.....',
    '....x......',
    '...........',
    '....a......',
    '...........',
  ],
} as const;

export type PixelIconName = keyof typeof ICON_ART;

type Run = { x: number; y: number; w: number; accent: boolean };

/** Parse a grid into horizontal runs, throwing loudly on malformed art. */
function parse(name: string, rows: readonly string[]): Run[] {
  if (rows.length !== ROWS) {
    throw new Error(`PixelIcon '${name}': expected ${ROWS} rows, got ${rows.length}`);
  }
  const runs: Run[] = [];
  rows.forEach((row, y) => {
    if (row.length !== COLS) {
      throw new Error(
        `PixelIcon '${name}' row ${y}: expected ${COLS} chars, got ${row.length}`,
      );
    }
    let x = 0;
    while (x < COLS) {
      const c = row[x];
      if (c === '.') {
        x += 1;
        continue;
      }
      if (c !== 'x' && c !== 'a') {
        throw new Error(`PixelIcon '${name}' row ${y} col ${x}: unknown char '${c}'`);
      }
      let w = 1;
      while (x + w < COLS && row[x + w] === c) w += 1;
      runs.push({ x, y, w, accent: c === 'a' });
      x += w;
    }
  });
  return runs;
}

const ICON_RUNS: Record<PixelIconName, Run[]> = Object.fromEntries(
  (Object.keys(ICON_ART) as PixelIconName[]).map((name) => [
    name,
    parse(name, ICON_ART[name]),
  ]),
) as Record<PixelIconName, Run[]>;

/**
 * A section icon. Ink with a whisper of vermilion; `signal-text` (#C13A20)
 * because the accent cells sit at glyph scale. Decorative — the heading beside
 * it carries the meaning.
 */
export function PixelIcon({
  name,
  cell = 3,
  className = '',
}: {
  name: PixelIconName;
  /** Pixel size of one cell; 3 (33×27) is the section-header size. */
  cell?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      width={COLS * cell}
      height={ROWS * cell}
      viewBox={`0 0 ${COLS} ${ROWS}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {ICON_RUNS[name].map((run) => (
        <rect
          key={`${run.y}-${run.x}`}
          x={run.x}
          y={run.y}
          width={run.w}
          height={1}
          fill={run.accent ? '#C13A20' : '#16161A'}
        />
      ))}
    </svg>
  );
}
