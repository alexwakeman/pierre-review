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

// ---- the signature composition --------------------------------------------

// Neighbouring quarters never share a temperature: warm, cool, warm, cool …
const SPIRAL_RUNS: readonly RunName[] = ['ember', 'dusk', 'dawn', 'bloom', 'meadow'];

/** A golden spiral, portrait (13 × 21 units of `u`), turning clockwise inward. */
export function spiralQuarters(u: number, steps = 7, offset = 0): Quarter[] {
  let x = 0;
  let y = 0;
  let w = 13;
  let h = 21;
  const out: Quarter[] = [];
  for (let i = 0; i < steps; i++) {
    const dir = i % 4; // top, right, bottom, left
    let s: number;
    let cx: number;
    let cy: number;
    let corner: Corner;
    if (dir === 0) {
      s = w;
      [cx, cy, corner] = [x, y + s, 'bl'];
      y += s;
      h -= s;
    } else if (dir === 1) {
      s = h;
      [cx, cy, corner] = [x + w - s, y, 'tl'];
      w -= s;
    } else if (dir === 2) {
      s = w;
      [cx, cy, corner] = [x + s, y + h - s, 'tr'];
      h -= s;
    } else {
      s = h;
      [cx, cy, corner] = [x + s, y + s, 'br'];
      x += s;
      w -= s;
    }
    out.push({
      cx: cx * u,
      cy: cy * u,
      R: s * u,
      corner,
      run: SPIRAL_RUNS[(i + offset) % SPIRAL_RUNS.length] as RunName,
      n: Math.max(3, Math.round(4 + (12 * s) / 13)),
    });
    if (w <= 0 || h <= 0) break;
  }
  return out;
}

