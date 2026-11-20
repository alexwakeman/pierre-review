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
const WARM: ReadonlySet<RunName> = new Set(['ember', 'dawn']);
const MIRROR_CORNER: Record<Corner, Corner> = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' };

/**
 * Colours for a chain that is MIRROR-SYMMETRIC left to right: each link takes the run of
 * its mirror image, so the finished picture is symmetric in colour as well as shape.
 * The links are coloured in chain order from `CHAIN_RUNS`, a link whose mirror is already
 * coloured copies it, and a new colour never shares a temperature with the link before.
 * Null when the chain is not symmetric.
 */
function mirroredRuns(qs: { cx: number; cy: number; corner: Corner }[], width: number): RunName[] | null {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  const partner = qs.map((q) =>
    qs.findIndex((o) => near(o.cx, width - q.cx) && near(o.cy, q.cy) && o.corner === MIRROR_CORNER[q.corner]),
  );
  if (partner.some((j) => j < 0)) return null;
  const runs: RunName[] = [];
  let k = 0;
  qs.forEach((_, i) => {
    const j = partner[i] as number;
    if (j < i) {
      runs[i] = runs[j] as RunName;
      return;
    }
    const prev = runs[i - 1];
    for (let t = 0; t < CHAIN_RUNS.length; t++) {
      const r = CHAIN_RUNS[(k + t) % CHAIN_RUNS.length] as RunName;
      if (prev != null && (r === prev || WARM.has(r) === WARM.has(prev))) continue;
      runs[i] = r;
      k = (k + t + 1) % CHAIN_RUNS.length;
      return;
    }
    runs[i] = CHAIN_RUNS[k++ % CHAIN_RUNS.length] as RunName;
  });
  return runs;
}

/** A fixed number in [0, 1) for link `i`, draw `k`: the same on every load (no Math.random). */
const unit = (i: number, k: number): number => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const CORNER_OF = (sx: number, sy: number): Corner =>
  sx > 0 ? (sy > 0 ? 'tl' : 'bl') : sy > 0 ? 'tr' : 'br';

interface RawLink {
  cx: number;
  cy: number;
  /** The way the quarter reaches from its centre: +1 right / down, −1 left / up. */
  sx: number;
  sy: number;
}

/**
 * Raw links (centres and reach, in chain order) → laid-out quarters: shifted so the box
 * (plus `margin` radii all round) starts at (0, 0), coloured (symmetrically when the
 * shape is mirror-symmetric), each with its assembly offset (see chainQuarters).
 * `spreadX` stretches the crossing starts sideways only: a narrow shape on a wide stage
 * still starts scattered across the screen.
 */
function assemble(
  raw: RawLink[],
  R: number,
  margin: number,
  cross: boolean,
  reach: number,
  scatter: number,
  spreadX = 1,
): { quarters: Quarter[]; width: number; height: number } {
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
  // A symmetric chain is coloured symmetrically; any other cycles CHAIN_RUNS.
  const symmetric = mirroredRuns(
    raw.map((q) => ({ cx: q.cx - x0, cy: q.cy - y0, corner: CORNER_OF(q.sx, q.sy) })),
    w + 2 * m,
  );
  return {
    quarters: raw.map((q, i) => {
      // each link waits OUTWARD from the chain's middle and closes in along that line,
      // so no two links cross on their way home
      const ux = q.cx + (q.sx * R) / 2 - mx;
      const uy = q.cy + (q.sy * R) / 2 - my;
      const len = Math.hypot(ux, uy) || 1;
      // the crossing start (the mirror point × reach), then this link's own turn and stretch
      let sx0 = -2 * reach * ux;
      let sy0 = -2 * reach * uy;
      if (scatter > 0) {
        const turn = (unit(i, 1) - 0.5) * 1.6 * scatter; // up to ±46° at scatter 1
        const stretch = 1 + (unit(i, 2) - 0.45) * 1.1 * scatter;
        // a link near the middle has almost no mirror distance: give it one of its own
        const floor = R * 0.9 * scatter * unit(i, 3);
        const d = Math.max(Math.hypot(sx0, sy0), floor) * stretch;
        const a = Math.atan2(sy0 || unit(i, 4) - 0.5, sx0 || unit(i, 5) - 0.5) + turn;
        sx0 = Math.cos(a) * d;
        sy0 = Math.sin(a) * d;
      }
      return {
        cx: q.cx - x0,
        cy: q.cy - y0,
        R,
        corner: CORNER_OF(q.sx, q.sy),
        run: symmetric?.[i] ?? (CHAIN_RUNS[i % CHAIN_RUNS.length] as RunName),
        // crossing: start at the mirror image, -2u, which the CSS reaches at 1.6 × dx
        dx: Math.round((cross ? (sx0 * spreadX) / 1.6 : (ux / len) * R * 0.16) * 100) / 100,
        dy: Math.round((cross ? sy0 / 1.6 : (uy / len) * R * 0.16) * 100) / 100,
      };
    }),
    width: w + 2 * m,
    height: h + 2 * m,
  };
}

/**
 * A chain of quarters of radius `R`, starting with a quarter centred at the origin and
 * reaching right and down. `steps` holds one letter per link after the first; the
 * chain leaves each quarter across the radius it did not come in by, starting with
 * `first` ('h': the horizontal radius, 'v': the vertical one). Returns the quarters
 * shifted so the chain's box (plus `margin` radii all round) starts at (0, 0), and
 * that box's size.
 *
 * Each quarter's assembly offset (dx, dy) is either OUTWARD from the chain's middle
 * (a short slide home), or, with `cross`, the MIRROR of its place through that middle:
 * every link starts on the far side of the box and travels through the middle, past
 * the others, into place. The mirror of a link lies inside the same box, so a crossing
 * chain needs no margin and fills its tile. `reach` multiplies that start distance: above
 * 1 the links start scattered beyond the box, some of them off screen. `scatter` (0 to
 * 1) breaks the start's symmetry: each link's start is turned and stretched by its own
 * fixed amount (the same on every load, and in the prerendered page), so a symmetric
 * chain starts in disorder and falls into symmetry. The offsets assume the CSS factor
 * of 1.6 that board.css applies to --apart.
 */
export function chainQuarters(
  R: number,
  steps: string,
  first: 'h' | 'v' = 'v',
  margin = 0,
  cross = false,
  reach = 1,
  scatter = 0,
): { quarters: Quarter[]; width: number; height: number } {
  let cx = 0;
  let cy = 0;
  let sx = 1;
  let sy = 1;
  let edge = first;
  const raw: RawLink[] = [{ cx, cy, sx, sy }];
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
  return assemble(raw, R, margin, cross, reach, scatter);
}

/** One band of the RING, cut loose: its own little picture and its own place in 3D space
 *  before the ring assembles. All lengths are in the ring's user units except the start,
 *  which is in BOX WIDTHS (the CSS multiplies by --bw), so it scales with the stage. */
export interface RingLine {
  /** The band's box in user units: x, y, width, height (stroke included). */
  box: [number, number, number, number];
  d: string;
  /** Stroke width. */
  w: number;
  /** Its quarter's gradient line (x1 y1 x2 y2) and colour run. */
  line: [number, number, number, number];
  stops: readonly string[];
  /** The start: a translation in box widths (z toward the reader), and turns in degrees. */
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
  /** Opacity at the start: a line far back is dimmer. */
  o0: number;
  /** When it lands, as a share of the gather (0.6 to 1): the lines settle one by one. */
  e: number;
}

/**
 * THE RING: one whole disc of radius `R` (four quarters round one centre, mirrored left to
 * right in colour like the chain), broken into its single BANDS, 4 × BANDS lines. Each line
 * starts somewhere of its own in 3D space (the same on every load, and in the prerendered
 * page): pushed outward from the ring's centre and turned off its course, nearer or further
 * from the reader, tilted on all three axes. The scroll brings every line home.
 * `spreadX` stretches the starts sideways, since the ring is narrow on a wide screen.
 */
export function ringLines(
  R: number,
  margin = 0,
  scatter = 1,
  spreadX = 1,
): { lines: RingLine[]; width: number; height: number } {
  // the four quarters in pen order (round from the right), coloured as a mirrored chain
  const raw: RawLink[] = [
    { cx: 0, cy: 0, sx: 1, sy: -1 },
    { cx: 0, cy: 0, sx: -1, sy: -1 },
    { cx: 0, cy: 0, sx: -1, sy: 1 },
    { cx: 0, cy: 0, sx: 1, sy: 1 },
  ];
  const { quarters, width, height } = assemble(raw, R, margin, false, 1, 0);
  const lines: RingLine[] = [];
  quarters.forEach((q) => {
    const [bx, by] = BULGE[q.corner];
    const c = (CUT * q.R) / 2;
    const ox = q.cx + bx * c;
    const oy = q.cy + by * c;
    const line = gradientLine(q.cx, q.cy, q.R, q.corner);
    for (const b of bands(q.R - c, q.n, q.inner)) {
      const i = lines.length;
      const h = b.t / 2;
      const x0 = Math.min(ox, ox + bx * b.r) - h;
      const y0 = Math.min(oy, oy + by * b.r) - h;
      // outward from the centre, through the band's middle, then turned off that line
      const ang = Math.atan2(by, bx) + (unit(i, 1) - 0.5) * 2.2 * scatter;
      const dist = (0.22 + 0.7 * unit(i, 2)) * scatter;
      const tz = (unit(i, 3) - 0.62) * 2.2 * scatter; // −1.36 … +0.84 box widths
      const deg = (k: number, max: number): number => round((unit(i, k) - 0.5) * 2 * max * scatter, 10);
      lines.push({
        box: [round(x0), round(y0), round(Math.abs(bx * b.r) + b.t), round(Math.abs(by * b.r) + b.t)],
        d: arcPath(ox, oy, b.r, q.corner),
        w: round(b.t),
        line,
        stops: RUNS[q.run],
        tx: round(Math.cos(ang) * dist * spreadX, 1000),
        ty: round(Math.sin(ang) * dist, 1000),
        tz: round(Math.min(tz, 0.7), 1000),
        rx: deg(4, 80),
        ry: deg(5, 80),
        rz: deg(6, 150),
        // depth cue: far back is dim, at the reader full
        o0: round(Math.min(1, Math.max(0.45, 0.85 + tz * 0.4)), 100),
        // the inner bands land first, the rim last, each a little off the rhythm
        e: round(0.6 + 0.28 * b.k + 0.12 * unit(i, 7), 1000),
      });
    }
  });
  return { lines, width, height };
}

/** The site's big picture: it LANDS AS ONE RING, its 64 band lines scattered through 3D
 *  space when the page opens and travelling home as the reader scrolls. The margin (0.12 of
 *  the radius) keeps the ring off the screen's top and bottom; `spreadX` 1.7 spreads the
 *  starts across a wide screen. */
export const SITE_RING = { margin: 0.12, scatter: 1, spreadX: 1.7 } as const;

/** The wide symmetric arch: the hero's shape before the ring, and still the share
 *  image's (scripts/make-og-image.mjs), whose wide card it fills. */
export const SITE_CHAIN = { steps: 'ABBBABBBA', first: 'v', margin: 0.04, cross: true, reach: 1.35, scatter: 0.8 } as const;
