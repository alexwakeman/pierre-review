// A log-scale y-axis with NAMED ticks (1m, 10m, 1h …) rather than bare decades. Pure, so the
// tick choice has a test; `LineChart`'s `logScale` prop draws it.

export interface LogTick {
  value: number;
  label: string;
}

export interface LogAxis {
  /** The plotted domain, both ends > 0. */
  lo: number;
  hi: number;
  /** The candidate ticks inside [lo, hi], ascending. */
  ticks: LogTick[];
}

/**
 * The domain and the ticks for `values` on a log scale.
 *
 * - `null` values are gaps and take no part. A value under `floor` (a zero included — log has no 0)
 *   counts as `floor`, the same clamp the renderer applies when it draws the point.
 * - The domain widens to the nearest candidate tick at or below the smallest value and at or above
 *   the largest, so each end of the axis carries a label. Past the last candidate the data's own
 *   end is the edge.
 * - Only candidates inside that domain are returned.
 *
 * `ticks` must be ascending. Returns null when there is no value to scale.
 */
export function logAxis(
  values: readonly (number | null)[],
  ticks: readonly LogTick[],
  floor: number,
): LogAxis | null {
  const vs = values
    .filter((v): v is number => v != null && Number.isFinite(v))
    .map((v) => Math.max(v, floor));
  if (vs.length === 0) return null;
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  let lo = [...ticks].reverse().find((t) => t.value <= min)?.value ?? min;
  let hi = ticks.find((t) => t.value >= max)?.value ?? max;
  if (hi <= lo) {
    // Every value sits on one tick: open the domain to the next tick up (else the one below).
    const up = ticks.find((t) => t.value > lo);
    const down = [...ticks].reverse().find((t) => t.value < lo);
    if (up) hi = up.value;
    else if (down) lo = down.value;
    else hi = lo * 10;
  }
  const eps = 1e-9;
  return {
    lo,
    hi,
    ticks: ticks.filter((t) => t.value >= lo * (1 - eps) && t.value <= hi * (1 + eps)),
  };
}

/** Time-to-first-review ticks, in HOURS. */
export const HOUR_TICKS: readonly LogTick[] = [
  { value: 1 / 60, label: '1m' },
  { value: 10 / 60, label: '10m' },
  { value: 1, label: '1h' },
  { value: 6, label: '6h' },
  { value: 24, label: '1d' },
  { value: 72, label: '3d' },
  { value: 168, label: '1w' },
  { value: 672, label: '4w' },
];

/** The lowest value an hours axis draws: 1 minute. A shorter median sits on this line. */
export const HOUR_FLOOR = 1 / 60;
