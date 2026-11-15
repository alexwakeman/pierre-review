// ---------------------------------------------------------------------------
// THE ARC — the site's one motif: a quarter-disc of concentric bands.
//
// Measured from the reference artwork (a 225px quarter, scaled here to R = 100):
//   · 16 bands; the hole in the middle is 12% of R
//   · the bands keep an even PITCH, but their THICKNESS ramps from hairline at the
//     centre (~1% of R) to heavy at the rim (~4% of R), so the gaps shrink outward
//   · two quarters that meet are parted by a CUT of ~2.6% of R
//   · the colour is ONE linear gradient per quarter, running from the quarter's outer
//     pole to its diameter (the cut line). Inner bands therefore sit in the late
//     colours and the rim sweeps the whole run, which is what the artwork does
//     (measured: it is not a conic gradient).
//
// Everything here is pure geometry, shared by every composition and illustration.
// ---------------------------------------------------------------------------

/** Which corner of its box the quarter's CENTRE sits in. 'br' bulges up and left. */
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export const HOLE = 0.12;
export const RIM_T = 0.04;
export const CORE_T = 0.01;
export const CUT = 0.026;
export const BANDS = 16;

export interface Band {
  /** Radius of the band's centre line. */
  r: number;
  /** Stroke width. */
  t: number;
  /** 0 for the innermost band, 1 for the rim. */
  k: number;
}

/** The bands of a quarter of radius R, inner first. */
export function bands(R: number, n: number = BANDS, inner: number = HOLE * R): Band[] {
  const out: Band[] = [];
  const pitch = n > 1 ? (R - inner) / (n - 1) : 0;
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 1;
    const t = (CORE_T + (RIM_T - CORE_T) * k) * R;
    // the outer EDGE of the rim band lands exactly on R
    const r = inner + i * pitch - (i === n - 1 ? t / 2 : 0);
    out.push({ r: Math.max(r, t / 2), t, k });
  }
  return out;
}

/** Unit vectors from the centre to the arc's two ends, for a centre in `corner`. */
const ENDS: Record<Corner, [[number, number], [number, number]]> = {
  // centre at bottom-right: the arc runs from the left end (start) up to the top (end)
  br: [[-1, 0], [0, -1]],
  bl: [[0, -1], [1, 0]],
  tl: [[1, 0], [0, 1]],
  tr: [[0, 1], [-1, 0]],
};

/** An SVG path for one band: a 90° arc around (cx, cy), drawn from the pole end. */
export function arcPath(cx: number, cy: number, r: number, corner: Corner): string {
  const [a, b] = ENDS[corner];
  // draw from the POLE (the end perpendicular to the diameter) toward the diameter
  const [s, e] = corner === 'br' || corner === 'tl' ? [b, a] : [a, b];
  const sweep = corner === 'br' || corner === 'tl' ? 0 : 1;
  const f = (n: number): string => (Math.round(n * 100) / 100).toString();
  return `M${f(cx + s[0] * r)} ${f(cy + s[1] * r)}A${f(r)} ${f(r)} 0 0 ${sweep} ${f(cx + e[0] * r)} ${f(cy + e[1] * r)}`;
}

/**
 * The gradient line for a quarter: from the outer pole, tilted a little toward the
 * arc's far end, to the diameter. Returns x1 y1 x2 y2 in user space.
 */
export function gradientLine(cx: number, cy: number, R: number, corner: Corner): [number, number, number, number] {
  const up = corner === 'br' || corner === 'bl' ? -1 : 1; // pole direction (y)
  const side = corner === 'br' || corner === 'tr' ? -1 : 1; // the side the arc reaches to (x)
  return [cx + side * 0.15 * R, cy + up * R, cx + side * 0.55 * R, cy];
}

/** A quarter as data, before it is drawn. */
export interface Quarter {
  cx: number;
  cy: number;
  R: number;
  corner: Corner;
  run: RunName;
  n?: number;
  /** Where the quarter sits before it assembles, as an offset in user units. */
  dx?: number;
  dy?: number;
  /** Inner radius of the first band (default: the hole, 12% of R). */
  inner?: number;
  /** A player's dot of this radius at the quarter's centre; it moves with the quarter. */
  dot?: number;
  /** Paint the bands as seats (dashes) instead of solid lines. */
  seats?: boolean;
}

// ---- a quarter, laid out ---------------------------------------------------
// The ONE layout both renderers use: <Arcs> (React) and quartersToSvg (a string,
// for the scripts that render the share image).

const BULGE: Record<Corner, [number, number]> = { br: [-1, -1], bl: [1, -1], tl: [1, 1], tr: [-1, 1] };
const round = (n: number, p = 100): number => Math.round(n * p) / p;

export interface LaidOutQuarter {
  /** Gradient line, x1 y1 x2 y2. */
  line: [number, number, number, number];
  stops: readonly string[];
  /** Assembly offset and the transform origin (the cut-adjusted centre). */
  dx: number;
  dy: number;
  ox: number;
  oy: number;
  paths: { d: string; w: number; k: number; dash?: string }[];
  /** The player's dot, at the quarter's true centre, if it has one. */
  dot?: { cx: number; cy: number; r: number };
}

export function layoutQuarter(q: Quarter): LaidOutQuarter {
  const [bx, by] = BULGE[q.corner];
  // the cut: each quarter pulls back from the lines it shares with its neighbours
  const c = (CUT * q.R) / 2;
  const cx = q.cx + bx * c;
  const cy = q.cy + by * c;
  return {
    line: gradientLine(q.cx, q.cy, q.R, q.corner),
    stops: RUNS[q.run],
    dx: q.dx ?? round(bx * q.R * 0.18),
    dy: q.dy ?? round(by * q.R * 0.18),
    ox: round(cx),
    oy: round(cy),
    paths: bands(q.R - c, q.n, q.inner).map((b) => ({
      d: arcPath(cx, cy, b.r, q.corner),
      w: round(b.t),
      k: round(b.k, 1000),
      // seats are dashes in user units (a chair every ~1.4 band widths)
      dash: q.seats ? `${round(b.t * 1.5)} ${round(b.t * 0.9)}` : undefined,
    })),
    dot: q.dot ? { cx: q.cx, cy: q.cy, r: q.dot } : undefined,
  };
}

/** A whole composition as an SVG string (still, finished): for scripts, not pages. */
export function quartersToSvg(viewBox: string, quarters: Quarter[], extra = '', fit = 'xMidYMid meet'): string {
  let defs = '';
  let body = '';
  quarters.forEach((q, i) => {
    const l = layoutQuarter(q);
    const n = l.stops.length;
    defs +=
      `<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${round(l.line[0])}" y1="${round(l.line[1])}" x2="${round(l.line[2])}" y2="${round(l.line[3])}">` +
      l.stops.map((c, j) => `<stop offset="${n > 1 ? j / (n - 1) : 0}" stop-color="${c}"/>`).join('') +
      '</linearGradient>';
    body +=
      `<g fill="none" stroke="url(#g${i})">` +
      l.paths.map((p) => `<path d="${p.d}" stroke-width="${p.w}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ''}/>`).join('') +
      (l.dot ? `<circle cx="${l.dot.cx}" cy="${l.dot.cy}" r="${l.dot.r}" fill="#f1f1ef" stroke="none"/>` : '') +
      '</g>';
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="${fit}"><defs>${defs}</defs>${body}${extra}</svg>`;
}

// ---- the colour runs --------------------------------------------------------
// Sampled from the artwork (the brightest band at each angle), then named. Each run is
// read from the pole to the diameter.

export const SPECTRUM = {
  red: '#f80e0f',
  orange: '#ff6a00',
  amber: '#fe9c00',
  yellow: '#ffcf00',
  lime: '#d6e92b',
  green: '#86c246',
  mint: '#52c395',
  teal: '#3faca9',
  azure: '#4ba0e0',
  indigo: '#5b7cc1',
  violet: '#6f47a7',
  plum: '#883a9f',
  magenta: '#ee0056',
  pink: '#f70e6a',
} as const;

export type RunName = 'ember' | 'dawn' | 'meadow' | 'dusk' | 'bloom';

const S = SPECTRUM;
export const RUNS: Record<RunName, readonly string[]> = {
  ember: [S.red, S.orange, S.amber, S.yellow],
  dawn: [S.teal, S.lime, S.yellow, S.amber],
  meadow: [S.teal, S.mint, S.green, S.lime],
  dusk: [S.plum, S.violet, S.azure, S.mint, S.lime],
  bloom: [S.magenta, S.pink, S.plum, S.azure, S.mint],
};

/** The order compositions cycle through. */
export const RUN_ORDER: readonly RunName[] = ['ember', 'dawn', 'meadow', 'dusk', 'bloom'];

// ---- the signature composition: the CHAIN -----------------------------------
// Quarters linked end to end, each joined to the last along a shared radius, so the
// bands run on from one link into the next like a ribbon. Every link is one of two:
//   'B' (bend)  the next centre is the far end of the shared radius: the ribbon turns
//               the other way, and the rim of one quarter meets the core of the next
//   'A' (arc)   the next quarter shares the centre: two links make a half-disc
// The step string chooses the shape. The site's chain is all bends but one arc, which
// makes it walk down the tile in a zigzag rather than stacking half-discs.

// Neighbouring links never share a temperature: warm, cool, warm, cool …
const CHAIN_RUNS: readonly RunName[] = ['ember', 'dusk', 'dawn', 'bloom', 'meadow', 'dusk', 'ember'];

const CORNER_OF = (sx: number, sy: number): Corner =>
  sx > 0 ? (sy > 0 ? 'tl' : 'bl') : sy > 0 ? 'tr' : 'br';

/**
 * A chain of quarters of radius `R`, starting with a quarter centred at the origin and
 * reaching right and down. `steps` holds one letter per link after the first; the
 * chain leaves each quarter across the radius it did not come in by, starting with
 * `first` ('h': the horizontal radius, 'v': the vertical one). Returns the quarters
 * shifted so the chain's box (plus `margin` radii all round) starts at (0, 0), and
 * that box's size. Each quarter's assembly offset points away from the chain's middle.
 */
export function chainQuarters(
  R: number,
  steps: string,
  first: 'h' | 'v' = 'v',
  margin = 0,
): { quarters: Quarter[]; width: number; height: number } {
  let cx = 0;
  let cy = 0;
  let sx = 1;
  let sy = 1;
  let edge = first;
  const raw: { cx: number; cy: number; sx: number; sy: number }[] = [{ cx, cy, sx, sy }];
  for (const step of steps) {
    if (edge === 'h') {
      if (step === 'B') {
        cx += sx * R;
        sx = -sx;
      }
      sy = -sy;
    } else {
      if (step === 'B') {
        cy += sy * R;
        sy = -sy;
      }
      sx = -sx;
    }
    raw.push({ cx, cy, sx, sy });
    edge = edge === 'h' ? 'v' : 'h';
  }
  const xs = raw.flatMap((q) => [q.cx, q.cx + q.sx * R]);
  const ys = raw.flatMap((q) => [q.cy, q.cy + q.sy * R]);
  // a margin all round, so the links still fit while they are apart
  const m = margin * R;
  const x0 = Math.min(...xs) - m;
  const y0 = Math.min(...ys) - m;
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const mx = Math.min(...xs) + w / 2;
  const my = Math.min(...ys) + h / 2;
  return {
    quarters: raw.map((q, i) => {
      // each link waits OUTWARD from the chain's middle and closes in along that line,
      // so no two links cross on their way home
      const ux = q.cx + (q.sx * R) / 2 - mx;
      const uy = q.cy + (q.sy * R) / 2 - my;
      const len = Math.hypot(ux, uy) || 1;
      return {
        cx: q.cx - x0,
        cy: q.cy - y0,
        R,
        corner: CORNER_OF(q.sx, q.sy),
        run: CHAIN_RUNS[i % CHAIN_RUNS.length] as RunName,
        dx: Math.round((ux / len) * R * 0.16 * 100) / 100,
        dy: Math.round((uy / len) * R * 0.16 * 100) / 100,
      };
    }),
    width: w + 2 * m,
    height: h + 2 * m,
  };
}

/** The site's chain (the hero and the share image): it zigzags down a portrait box of
 *  3 × 4 radii. A chain that stacks half-discs on one centre line is avoided on purpose:
 *  that is the reference artwork's own figure. */
export const SITE_CHAIN = { steps: 'BABBABBA', first: 'h', margin: 0.3 } as const;

/**
 * The QUARTET: four equal quarters centred on the corners of a 100-unit square, facing
 * one centre, each with a player's dot at its corner. Each waits OUTWARD (away from the
 * middle) and closes in. `margin` (in units) is added round the square so the apart
 * state fits; the returned viewBox includes it.
 */
export function quartetQuarters(margin = 0): { quarters: Quarter[]; viewBox: string } {
  const R = 50;
  const away = R * 0.2;
  const q = (cx: number, cy: number, corner: Corner, run: RunName): Quarter => ({
    cx,
    cy,
    R,
    corner,
    run,
    n: 11,
    dot: 3.2,
    dx: cx === 0 ? -away : away,
    dy: cy === 0 ? -away : away,
  });
  return {
    quarters: [q(0, 0, 'tl', 'ember'), q(100, 0, 'tr', 'dawn'), q(100, 100, 'br', 'dusk'), q(0, 100, 'bl', 'bloom')],
    viewBox: `${-margin} ${-margin} ${100 + 2 * margin} ${100 + 2 * margin}`,
  };
}
