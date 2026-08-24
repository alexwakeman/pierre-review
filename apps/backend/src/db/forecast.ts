// Next-period forecast over a short metric series — the CORE estimator behind the period
// report's forecast band. Same shape and the same discipline as db/changepoint.ts: NO db
// imports, NO I/O, not async, plain arrays in and out, robust estimators only. Unit-tested
// directly with literal arrays (forecast.test.ts) because that is the whole point of keeping
// it pure — the numbers layer has to be checkable without a fixture DB.
//
// ⚠ THEIL–SEN, NEVER LEAST SQUARES. A period series is 4–8 points long, so ONE chaotic sprint
// is 12–25% of the sample and OLS follows it. Measured on the test fixture: [10, 12, 900, 16,
// 18] — a single wild period in the MIDDLE, where its leverage on the SLOPE is zero — still
// drags the OLS intercept to 187.2 and forecasts 197.2, while the true line forecasts 20.
// Move that outlier to the END and OLS forecasts 725.6. Theil–Sen answers 20 in both cases,
// which is the same answer it gives for the clean series. The band is MAD-derived for exactly
// the same reason: a standard deviation would let one spike manufacture a plausible-looking
// interval around a number that is already wrong.
//
// ⚠ NULLS ARE SKIPPED, NEVER IMPUTED, AND THE X AXIS IS THE ARRAY INDEX. A period with no data
// is not a period with zero — imputing a 0 invents a crash that did not happen, and compacting
// the indices invents a cadence that does not exist. Keeping x = the original index means a gap
// stays a gap: [10, null, 30, null, 50, null, 70] forecasts 80 (slope 10 per period), not the
// 90 that compaction would produce.
//
// ⚠ IT REFUSES RATHER THAN GUESSES. Both refusals are NAMED and travel to the UI as
// `PeriodRefusalReason`, because a blank band and a confident band around noise are the same
// pixel to a reader. Nothing here ever fabricates a number to fill the slot.

/** Fewer real points than this and "the trend" is not yet a thing that exists. Matches
 *  changepoint.ts's MIN_BASELINE_POINTS deliberately — the same judgement about the same kind
 *  of short, bursty series. */
export const MIN_FORECAST_POINTS = 4;

export interface ForecastResult {
  point: number;
  low: number;
  high: number;
  /** A short human string naming the estimator and the band, rendered beside the number. A
   *  forecast whose method is invisible is a number the reader has to take on faith. */
  basis: string;
  /** How many NON-NULL periods went in — not `values.length`. */
  periodsUsed: number;
}

export type ForecastRefusal = { refused: 'insufficient_history' | 'too_volatile' };

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 2dp — these are display figures; an unrounded 19.999999999999996 in a band reads as noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Forecast the period AFTER `values` (oldest-first, one slot per period, `null` = no data).
 *
 * The prediction is made at x = `values.length`, i.e. the slot immediately after the array —
 * so a TRAILING null (a period that happened but produced nothing) still consumes its slot and
 * is not silently skipped over.
 */
export interface ForecastOptions {
  /** A DECLARED ceiling for the metric, clamped exactly like the 0 floor below.
   *
   *  ⚠ It must be DECLARED by the caller and never inferred from the data, which is the difference
   *  between this and the non-negative floor. Three of the twelve period metrics are percentages
   *  on a 0–100 scale, and a rising percentage series happily extrapolates past 100 — "CI success
   *  next period ≈ 104% (98–110%)" is not a bold prediction, it is a number that cannot exist.
   *  Inferring the ceiling from "every observed value is ≤ 100" would cap `median_pr_size_lines`
   *  on any workspace whose PRs happen to be small, which is a real forecast silently truncated. */
  max?: number;
}

export function forecastNext(
  values: (number | null)[],
  opts: ForecastOptions = {},
): ForecastResult | ForecastRefusal {
  // `Number.isFinite` and not just a null check: a NaN or an Infinity arriving from a division
  // upstream would poison every median silently, and a poisoned median still looks like a number.
  const points: { x: number; y: number }[] = [];
  for (const [x, v] of values.entries()) {
    if (v != null && Number.isFinite(v)) points.push({ x, y: v });
  }
  if (points.length < MIN_FORECAST_POINTS) return { refused: 'insufficient_history' };

  // Theil–Sen: the median of every pairwise slope. O(n²) is free at n ≤ 8.
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      // x is the array index, so dx is never 0 — the guard is here so a future caller that
      // supplies its own x values cannot divide by zero into an Infinity slope.
      if (b.x === a.x) continue;
      slopes.push((b.y - a.y) / (b.x - a.x));
    }
  }
  const slope = medianOf(slopes) ?? 0;
  // The intercept is the MEDIAN residual against that slope, not a mean — pairing a robust
  // slope with a least-squares intercept is the failure the header describes (the outlier
  // series above has the CORRECT slope under OLS and still forecasts 197.2).
  const intercept = medianOf(points.map((p) => p.y - slope * p.x))!;

  const at = values.length;
  const raw = intercept + slope * at;
  const residuals = points.map((p) => Math.abs(p.y - (intercept + slope * p.x)));
  const mad = medianOf(residuals)!;
  // 1.4826 converts a MAD to a normal-consistent sigma (the changepoint.ts constant); ×2 makes
  // it a ~2σ band. Named in `basis` as "±2 MAD" so the reader knows what the edges mean.
  const half = 1.4826 * mad * 2;
  const rawLow = raw - half;
  const rawHigh = raw + half;

  // ⚠ THE VOLATILITY TEST RUNS ON THE **RAW** BAND, BEFORE any clamping. Clamping first would
  // narrow the interval and let a genuinely chaotic series slip through as a confident forecast.
  if (rawHigh - rawLow > 2 * Math.abs(raw)) return { refused: 'too_volatile' };

  // COUNT-LIKE CLAMP. This function sees plain numbers and is not told whether the metric is a
  // count, so it reads the only signal it has: a series in which every observed value is ≥ 0.
  // A declining count then forecasts 0 rather than −9.4 ("we expect it to bottom out"), and the
  // clamp is stated in `basis` because a 0 the reader cannot distinguish from a fitted 0 is a
  // different claim. All three bounds move together — clamping only the point would leave
  // `high` below it and render as an inverted band.
  const nonNegative = points.every((p) => p.y >= 0);
  const clamped = nonNegative && (raw < 0 || rawLow < 0 || rawHigh < 0);
  let point = clamped ? Math.max(0, raw) : raw;
  let low = clamped ? Math.max(0, rawLow) : rawLow;
  let high = clamped ? Math.max(0, rawHigh) : rawHigh;

  // The DECLARED ceiling, applied the same way: all three bounds together, so the band can never
  // come back inverted, and named in `basis` so a reader can tell a clamped 100 from a fitted one.
  const ceiling = opts.max;
  const cappedAbove =
    ceiling != null && (point > ceiling || low > ceiling || high > ceiling);
  if (cappedAbove) {
    point = Math.min(point, ceiling!);
    low = Math.min(low, ceiling!);
    high = Math.min(high, ceiling!);
  }

  const notes = [
    clamped ? 'clamped at 0 (the series is non-negative)' : null,
    cappedAbove ? `clamped at ${ceiling}` : null,
  ].filter(Boolean);

  return {
    point: round2(point),
    low: round2(low),
    high: round2(high),
    basis:
      `Theil–Sen over ${points.length} periods; band = ±2 MAD` +
      (notes.length > 0 ? `; ${notes.join('; ')}` : ''),
    periodsUsed: points.length,
  };
}
