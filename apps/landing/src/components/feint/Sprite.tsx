import { SPRITES, ALIEN_NAMES, SPRITE_PALETTES } from '../../lib/sprites';
import type { AlienName, SpriteName } from '../../lib/sprites';

// ---------------------------------------------------------------------------
// Pixel sprites, rendered as inline SVG.
//
// Inline SVG rather than image files for three reasons: the landing CSP is
// `img-src 'self' data:` (no external hosts), the handoff explicitly says no
// image files are needed, and the sprites must recolour per instance — the
// signal figure below needs a single flat colour plus an alpha, which is none of
// the four {fill, accent} palettes in sprites.json.
//
// The viewBox is expressed in CELLS (1 unit = 1 cell) and the rendered size is
// cells × cell, so every rect lands on an integer boundary. `shapeRendering=
// "crispEdges"` is the SVG spelling of the brief's "never anti-alias".
//
// SVG is the right medium HERE and the wrong one inside the cabinet: the DOM
// cost is one <rect> per run per instance, which is free for the handful of
// sprites the marketing pages draw and ruinous for a rack of sixty-eight redrawn
// sixty times a second. The game paints the same run data to a canvas instead.
//
// Deliberately NOT following icons.tsx's conventions (currentColor, a shared
// 24×24 viewBox, the `Stroke` wrapper): a sprite needs two independent literal
// colours, which `currentColor` cannot express, and each has its own grid.
// ---------------------------------------------------------------------------

export type SpriteProps = {
  name: SpriteName;
  /** Pixel size of one cell. The design uses 2 (UI), 3 (play), 4 (attract), 6 (sheet). */
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

// The resting palettes, in the exact `{fill, accent}` shape <Sprite> takes, so
// a call site can spread one straight into the props. Deliberately NOT a
// re-export of SPRITE_PALETTES: those entries carry a third `on` key (the
// surface they were contrast-checked against) which <Sprite> has no prop for,
// and these are written as literals so the two colours stay narrowly typed.
// They are `paper` and `game` from sprites.json's $meta and nothing else.
export const SPRITE_PALETTE = {
  onPaper: { fill: '#2A2A2E', accent: '#C13A20' },
  inGame: { fill: '#F5F5F2', accent: '#E2492C' },
} as const;

// The impact palettes — `paperHit` and `gameHit`. Drawn for a single frame when
// a sprite is hit and then dropped; the cabinet's damage states are silhouette
// changes, so this is a flash, never a status colour.
export const SPRITE_PALETTE_HIT = {
  onPaper: { fill: '#C13A20', accent: '#E2492C' },
  inGame: { fill: '#F26B4E', accent: '#FBD5CC' },
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
// visible reshuffle on load. The same applies to the type cycle: `i % 12` walks
// the twelve types in the handoff's own order, which is stable across both
// passes and happens to put a different type under each highlight.
// ---------------------------------------------------------------------------

const FIGURE_COUNT = 32;
const SIGNAL_POSITIONS = new Set([4, 17, 26]);

export function SignalFigure(): JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-[10px]">
      {Array.from({ length: FIGURE_COUNT }, (_, i) => {
        const needsHuman = SIGNAL_POSITIONS.has(i);
        // ALIEN_NAMES is a fixed twelve-entry list and `i` is bounded by the
        // modulo, but noUncheckedIndexedAccess cannot see that; the fallback is
        // unreachable and exists only to keep the union honest.
        const name: AlienName = ALIEN_NAMES[i % ALIEN_NAMES.length] ?? 'bell';
        return (
          <Sprite
            key={i}
            name={name}
            cell={2}
            fill={needsHuman ? SPRITE_PALETTES.paper.accent : SPRITE_PALETTES.paper.fill}
            opacity={needsHuman ? 1 : 0.4}
          />
        );
      })}
    </div>
  );
}
