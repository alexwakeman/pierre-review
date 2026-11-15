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
