import { SPRITES, ALIEN_NAMES } from '../../lib/sprites';
import type { SpriteName } from '../../lib/sprites';

// ---------------------------------------------------------------------------
// Pixel sprites, rendered as inline SVG.
//
// Inline SVG rather than image files for three reasons: the landing CSP is
// `img-src 'self' data:` (no external hosts), the handoff explicitly says no
// image files are needed, and the sprites must recolour per instance — the
// signal figure below needs a single flat colour plus an alpha, which is none of
// the three {x, a} palettes in sprites.json.
//
// The viewBox is expressed in CELLS (1 unit = 1 cell) and the rendered size is
// cells × cell, so every rect lands on an integer boundary. `shapeRendering=
// "crispEdges"` is the SVG spelling of the brief's "never anti-alias".
//
// Deliberately NOT following icons.tsx's conventions (currentColor, a shared
// 24×24 viewBox, the `Stroke` wrapper): a sprite needs two independent literal
// colours, which `currentColor` cannot express, and each has its own grid.
// ---------------------------------------------------------------------------

type SpriteProps = {
  name: SpriteName;
  /** Pixel size of one cell. The design specifies 2 (site figure) and 3 (game bar). */
  cell: number;
  /** Colour for 'x' cells. */
  fill: string;
  /** Colour for 'a' cells. Defaults to `fill` — a flat, single-colour render. */
  accent?: string;
  /** Applied to the whole sprite, not per cell. */
  opacity?: number;
  className?: string;
};

export function Sprite({
  name,
  cell,
  fill,
  accent,
  opacity,
  className = '',
}: SpriteProps): JSX.Element {
  const sprite = SPRITES[name];
  const accentFill = accent ?? fill;

  return (
    <svg
      width={sprite.cols * cell}
      height={sprite.rows * cell}
      viewBox={`0 0 ${sprite.cols} ${sprite.rows}`}
      shapeRendering="crispEdges"
      // Decorative in every current use — the adjacent label carries the meaning.
      aria-hidden="true"
      focusable="false"
      className={className}
      style={opacity === undefined ? undefined : { opacity }}
    >
      {sprite.runs.map((run) => (
        <rect
          key={`${run.y}-${run.x}`}
          x={run.x}
          y={run.y}
          width={run.w}
          height={1}
          fill={run.accent ? accentFill : fill}
        />
      ))}
    </svg>
  );
}

// The three palettes from sprites.json's $meta. `hit` (the one-frame impact
// colour) belongs to the game and is not used on the site.
export const SPRITE_PALETTE = {
  onPaper: { fill: '#2A2A2E', accent: '#C13A20' },
  inGame: { fill: '#F5F5F2', accent: '#E2492C' },
} as const;

// ---------------------------------------------------------------------------
// The signal figure — the only figure on the page.
//
// 32 sprites: 3 in vermilion at full opacity, 29 in ink at 0.4. It is the whole
// argument of the site rendered as a picture: three hundred signals arrive, three
// of them need a human. Vermilion means exactly that and nothing else.
//
// The three highlighted positions are FIXED CONSTANTS, not random. The page is
// prerendered to static HTML at build time and then re-rendered fresh in the
// browser (createRoot, not hydrateRoot), so anything random here would produce a
// visible reshuffle on load.
// ---------------------------------------------------------------------------

const FIGURE_COUNT = 32;
const SIGNAL_POSITIONS = new Set([4, 17, 26]);

export function SignalFigure(): JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-[10px]">
      {Array.from({ length: FIGURE_COUNT }, (_, i) => {
        const needsHuman = SIGNAL_POSITIONS.has(i);
        return (
          <Sprite
            key={i}
            // Cycle the eight aliens so the swarm is varied but deterministic.
            name={ALIEN_NAMES[i % ALIEN_NAMES.length] as SpriteName}
            cell={2}
            fill={needsHuman ? '#C13A20' : '#2A2A2E'}
            opacity={needsHuman ? 1 : 0.4}
          />
        );
      })}
    </div>
  );
}
