// ---------------------------------------------------------------------------
// THE ENSEMBLE MARK — one banded quarter-circle in the ember run.
//
// The ONE definition of the logo. Three consumers draw it from here:
//   · apps/frontend Wordmark.tsx       (the app's header and sign-in gate)
//   · scripts/make-favicons.mjs        (every favicon, the app icons and the
//                                       landing's transparent /mark.svg, which
//                                       the landing header shows)
// The landing shares no runtime code with the app, so it takes the mark as that
// generated file rather than importing this module.
//
// The geometry is the landing's arc (apps/landing/src/components/arcs/geometry.ts)
// redrawn for a 16-unit box: the centre sits at the bottom-left, the bands bulge
// up and to the right, each thicker than the one inside it, and ONE linear run
// goes from the pole (the top) to the diameter (the right end). The colours are
// that file's EMBER run (red → orange → amber → yellow): a narrow, warm range,
// not the whole spectrum, so the mark reads as one colour family even at 16px.
// Keep the two in step.
//
// Only erasable TypeScript here: the favicon script imports this file with Node's
// type stripping.
// ---------------------------------------------------------------------------

export const BRAND_RUN = [
  '#f80e0f', // red
  '#ff6a00', // orange
  '#fe9c00', // amber
  '#ffcf00', // yellow
] as const;

/** The page ground the opaque icons sit on (the landing's --bg). */
export const BRAND_GROUND = '#0f1012';

export interface BrandMarkBand {
  d: string;
  width: number;
}

export interface BrandMarkGeometry {
  viewBox: string;
  /** Gradient line in user space: x1, y1, x2, y2. */
  line: [number, number, number, number];
  stops: { offset: number; color: string }[];
  bands: BrandMarkBand[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The mark in a 16 × 16 box. `bands` trades detail for legibility: 3 for a 16px
 * tab icon, 4 for the app header, 6 or more for large icons.
 */
export function brandMark(bands = 4): BrandMarkGeometry {
  const cx = 2;
  const cy = 14;
  const R = 12;
  const n = Math.max(2, Math.round(bands));
  const inner = R * 0.22;
  const tIn = R * (n <= 3 ? 0.12 : 0.07);
  const tOut = R * (n <= 3 ? 0.2 : 0.16);
  const pitch = (R - inner) / (n - 1);
  const out: BrandMarkBand[] = [];
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const t = tIn + (tOut - tIn) * k;
    // centre line, with the rim band's outer edge landing on R
    const r = Math.max(inner + i * pitch - (i === n - 1 ? t / 2 : 0), t / 2);
    out.push({ d: `M${r2(cx)} ${r2(cy - r)}A${r2(r)} ${r2(r)} 0 0 1 ${r2(cx + r)} ${r2(cy)}`, width: r2(t) });
  }
  const last = BRAND_RUN.length - 1;
  return {
    viewBox: '0 0 16 16',
    line: [r2(cx + 0.15 * R), r2(cy - R), r2(cx + 0.55 * R), cy],
    stops: BRAND_RUN.map((color, i) => ({ offset: r2(i / last), color })),
    bands: out,
  };
}

/** The mark as a standalone SVG document; `ground` paints an opaque square behind it. */
export function brandMarkSvg(bands = 4, ground?: string, id = 'ensemble-mark'): string {
  const m = brandMark(bands);
  const [x1, y1, x2, y2] = m.line;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${m.viewBox}">`,
    ground ? `<rect width="16" height="16" fill="${ground}"/>` : '',
    `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">`,
    ...m.stops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`),
    `</linearGradient></defs>`,
    `<g fill="none" stroke="url(#${id})">`,
    ...m.bands.map((b) => `<path d="${b.d}" stroke-width="${b.width}"/>`),
    `</g></svg>`,
    '',
  ].join('');
}
