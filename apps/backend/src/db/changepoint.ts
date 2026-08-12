// Pure changepoint detection over a weekly series — the unattributed half of the advisor's
// verification loop ("something changed around the 3rd, cause unknown"). Same robust idiom as
// weeklyAnomalies (queries.ts): medians + MAD, never means — a bot's weekly volume is bursty
// and a single spike must not manufacture a "change". No DB, no I/O, CI-tested directly.
//
// Semantics: a candidate split at index i compares values[0..i) against values[i..n). Both
// segments need MIN_BASELINE_POINTS non-null points or the split is unjudgeable (thin data →
// no claim, never a guess). The score is a robust z: |medianAfter − medianBefore| divided by
// the MAD-derived sigma of the POOLED residuals (each value against its own segment's
// median), floored at `minScale` so a near-constant series can't divide by ~0 into
// significance. Nulls (no-data weeks — the null-vs-zero policy) are skipped, not imputed.

export const CHANGEPOINT_Z = 3; // same bar as ANOMALY_Z — ≥3 robust SDs is an exception
export const MIN_BASELINE_POINTS = 4; // fewer and "typical" isn't yet meaningful, per side

export interface Changepoint {
  index: number; // the index where the AFTER segment begins
  beforeMedian: number;
  afterMedian: number;
  direction: 'up' | 'down';
  z: number;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function evaluateSplit(
  values: (number | null)[],
  index: number,
  minScale: number,
): Changepoint | null {
  const before = values.slice(0, index).filter((v): v is number => v != null);
  const after = values.slice(index).filter((v): v is number => v != null);
  if (before.length < MIN_BASELINE_POINTS || after.length < MIN_BASELINE_POINTS) return null;
  const beforeMedian = medianOf(before)!;
  const afterMedian = medianOf(after)!;
  // Pooled residuals against each value's OWN segment median: the spread that remains once
  // the hypothesised step is accounted for. A true step change leaves small residuals on both
  // sides, so the z is large; noise leaves large residuals and the z collapses.
  const residuals = [
    ...before.map((v) => Math.abs(v - beforeMedian)),
    ...after.map((v) => Math.abs(v - afterMedian)),
  ];
  const mad = medianOf(residuals)!;
  const sigma = Math.max(1.4826 * mad, minScale);
  const z = Math.abs(afterMedian - beforeMedian) / sigma;
  if (z < CHANGEPOINT_Z) return null;
  return {
    index,
    beforeMedian,
    afterMedian,
    direction: afterMedian > beforeMedian ? 'up' : 'down',
    z,
  };
}

/**
 * Detect changepoints in a weekly series. With `anchors` (candidate split indices — e.g. the
 * weeks of known config events) only those splits are evaluated and every significant one is
 * returned, in index order. Without anchors, every valid split is scanned and only the single
 * BEST split comes back (zero or one element): one series, one strongest claim — reporting
 * every index over the bar would list the same step three times as the window slides past it.
 */
export function detectChangepoints(
  values: (number | null)[],
  opts: { anchors?: number[]; minScale: number },
): Changepoint[] {
  if (opts.anchors) {
    const out: Changepoint[] = [];
    for (const index of [...opts.anchors].sort((a, b) => a - b)) {
      if (index <= 0 || index >= values.length) continue;
      const cp = evaluateSplit(values, index, opts.minScale);
      if (cp) out.push(cp);
    }
    return out;
  }
  let best: Changepoint | null = null;
  for (let index = 1; index < values.length; index++) {
    const cp = evaluateSplit(values, index, opts.minScale);
    if (cp && (best == null || cp.z > best.z)) best = cp;
  }
  return best ? [best] : [];
}
