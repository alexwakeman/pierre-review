// db/forecast.ts — the next-period estimator, tested the way a pure numbers module should be:
// literal arrays in, exact figures out, NO database, NO fixtures, NO clock.
//
// THE FIVE PROPERTIES THIS FILE EXISTS FOR, each of which is a way the forecast could ship a
// confident wrong number that nothing else in the stack would catch:
//  • ROBUSTNESS. One wild period must not move the answer. The outlier cases below carry the
//    OLS figure they would have produced, computed by hand — that contrast IS the test.
//  • THE NULL POLICY. A period with no data is a GAP, not a zero and not a shorter series.
//  • THE HISTORY FLOOR. Too few real points ⇒ a named refusal, never a two-point line.
//  • THE VOLATILITY REFUSAL. A band wider than the number it surrounds says nothing; it must
//    refuse rather than render.
//  • THE COUNT CLAMP. A declining count forecasts 0, not a negative — and says it clamped.
import { describe, expect, it } from 'vitest';
import { forecastNext, MIN_FORECAST_POINTS, type ForecastResult } from './forecast.js';

/** Narrow to the available branch — every assertion below reads fields the refusal lacks. */
function ok(r: ReturnType<typeof forecastNext>): ForecastResult {
  if ('refused' in r) throw new Error(`expected a forecast, got refusal: ${r.refused}`);
  return r;
}

describe('forecastNext — a clean trend', () => {
  it('extends a perfectly linear series to the next slot with a zero-width band', () => {
    // slope 2/period, intercept 10 ⇒ x=5 is 20. Every residual is 0, so the MAD band is 0:
    // "the last five periods were exactly linear" is a real claim, and the band says so.
    const r = ok(forecastNext([10, 12, 14, 16, 18]));
    expect(r.point).toBe(20);
    expect(r.low).toBe(20);
    expect(r.high).toBe(20);
    expect(r.periodsUsed).toBe(5);
    // `basis` is rendered beside the number — it must name the estimator and the band width.
    expect(r.basis).toBe('Theil–Sen over 5 periods; band = ±2 MAD');
  });

  it('predicts the slot AFTER the array, so a trailing no-data period still consumes its slot', () => {
    // [10,12,14,16] alone would forecast x=4 = 18. With a fifth, empty period the next slot is
    // x=5 = 20 — the empty period happened, it just produced nothing.
    expect(ok(forecastNext([10, 12, 14, 16])).point).toBe(18);
    expect(ok(forecastNext([10, 12, 14, 16, null])).point).toBe(20);
  });
});

describe('forecastNext — resistance to a single wild period (why NOT least squares)', () => {
  it('ignores an outlier in the MIDDLE, where OLS keeps the slope but loses the intercept', () => {
    const clean = ok(forecastNext([10, 12, 14, 16, 18]));
    const wild = ok(forecastNext([10, 12, 900, 16, 18]));
    // ⚠ THE WHOLE ARGUMENT IN ONE ASSERTION: 900 in the middle changes NOTHING.
    expect(wild.point).toBe(clean.point);
    expect(wild.point).toBe(20);
    // Least squares on this series: x̄=2, ȳ=191.2, Sxy=20, Sxx=10 ⇒ slope 2.0 (the outlier sits
    // at zero leverage, so OLS gets the SLOPE right) but intercept 187.2 ⇒ x=5 forecasts 197.2.
    // Nearly 10× the truth, from a line whose slope is correct — which is exactly why the
    // intercept is a median residual here and not a mean.
    expect(wild.point).not.toBeCloseTo(197.2, 1);
    // The MAD band is 0 because four of the five points fit the line exactly. A robust band does
    // not widen for one outlier — that is the point of it, and it is why the outlier cannot
    // manufacture a plausible-looking interval around a wrong number.
    expect(wild.low).toBe(20);
    expect(wild.high).toBe(20);
  });

  it('ignores an outlier at the END, where OLS has maximum leverage', () => {
    // OLS here: slope 178.4, intercept −166.4 ⇒ x=5 forecasts 725.6, i.e. 36× the truth.
    const r = ok(forecastNext([10, 12, 14, 16, 900]));
    expect(r.point).toBe(20);
    expect(r.periodsUsed).toBe(5);
  });
});

describe('forecastNext — nulls are SKIPPED, never imputed', () => {
  it('keeps the x axis on the original index, so a gap stays a gap', () => {
    // Real points at x = 0, 2, 4, 6 with y = 10, 30, 50, 70 ⇒ slope 10 PER PERIOD, next slot
    // x=7 ⇒ 80.
    const r = ok(forecastNext([10, null, 30, null, 50, null, 70]));
    expect(r.point).toBe(80);
    expect(r.periodsUsed).toBe(4); // the four real periods, NOT the seven slots

    // ⚠ COMPACTING the indices to 0,1,2,3 would double the slope to 20 and forecast 90 at x=4.
    expect(r.point).not.toBe(90);
  });

  it('does not impute a null as 0 — the invented crash moves the answer', () => {
    const skipped = ok(forecastNext([100, null, 90, 80, 70]));
    const imputed = ok(forecastNext([100, 0, 90, 80, 70]));
    expect(skipped.periodsUsed).toBe(4);
    expect(imputed.periodsUsed).toBe(5); // a period that never produced data, counted as evidence
    expect(imputed.point).not.toBe(skipped.point);
    // (On the evenly-spaced series above, the robust estimator happens to shrug the fabricated
    // zeros off and reach the SAME point — which is why the null policy needs its own test
    // rather than being assumed visible in every series.)
  });

  it('counts only real points against the history floor', () => {
    // Seven slots, three real values — still short of MIN_FORECAST_POINTS.
    expect(forecastNext([10, null, 30, null, 50, null, null])).toEqual({
      refused: 'insufficient_history',
    });
  });
});

describe('forecastNext — the named refusals', () => {
  it('refuses insufficient_history below the floor and answers at exactly the floor', () => {
    expect(MIN_FORECAST_POINTS).toBe(4);
    expect(forecastNext([])).toEqual({ refused: 'insufficient_history' });
    expect(forecastNext([1, 2, 3])).toEqual({ refused: 'insufficient_history' });
    expect(forecastNext([5, null, 7, null])).toEqual({ refused: 'insufficient_history' });
    // Exactly four real points is enough — the floor is inclusive.
    const r = ok(forecastNext([1, 2, 3, 4]));
    expect(r.periodsUsed).toBe(4);
    expect(r.point).toBe(5);
  });

  it('refuses too_volatile when the band is wider than the number it surrounds', () => {
    // A sawtooth: Theil–Sen slope 0, intercept 25 ⇒ point 25, every residual 25 ⇒ MAD 25 ⇒
    // half-band 1.4826 × 25 × 2 = 74.13, so the interval is 148.3 wide around 25. A "forecast"
    // of 25 ± 74 is not a forecast; it is a blank slot with a number written on it.
    expect(forecastNext([50, 0, 50, 0, 50, 0])).toEqual({ refused: 'too_volatile' });
  });

  it('tests volatility on the RAW band, so clamping cannot smuggle a chaotic series through', () => {
    // Same sawtooth shifted so the fitted point is small and negative-ish; if the clamp ran
    // first, `low` would rise to 0, the interval would narrow and this would render.
    expect(forecastNext([30, -30, 30, -30, 30, -30])).toEqual({ refused: 'too_volatile' });
  });

  it('a NaN or an Infinity is treated as no-data rather than poisoning every median', () => {
    // Three usable points once the two poison values are dropped ⇒ below the floor. Without the
    // isFinite guard this would return a NaN point, which still type-checks as a number.
    expect(forecastNext([10, Number.NaN, 30, Number.POSITIVE_INFINITY, 50])).toEqual({
      refused: 'insufficient_history',
    });
  });
});

describe('forecastNext — the count-like clamp', () => {
  it('clamps a declining count at 0 and SAYS SO in the basis', () => {
    // 40, 30, 21, 10, 1: Theil–Sen slope −9.875, intercept 40 ⇒ x=5 is −9.375, and the whole
    // ±1.11 band sits below zero. A count cannot go negative, so all three bounds clamp — and
    // a 0 the reader cannot tell from a fitted 0 is a different claim, hence the basis suffix.
    const r = ok(forecastNext([40, 30, 21, 10, 1]));
    expect(r.point).toBe(0);
    expect(r.low).toBe(0);
    expect(r.high).toBe(0);
    expect(r.basis).toContain('clamped at 0');
    // Never an inverted band: clamping only the point would have left `high` at −8.26.
    expect(r.high).toBeGreaterThanOrEqual(r.point);
    expect(r.point).toBeGreaterThanOrEqual(r.low);
  });

  it('does NOT clamp a series that legitimately goes negative', () => {
    // A delta-style metric with observed negative values is not count-like, so nothing is
    // clamped and the forecast is allowed to be below zero.
    const r = ok(forecastNext([4, 2, 0, -2, -4]));
    expect(r.point).toBe(-6);
    expect(r.basis).not.toContain('clamped');
  });

  it('leaves a healthy non-negative forecast untouched', () => {
    const r = ok(forecastNext([12, 9, 6, 3]));
    expect(r.point).toBe(0); // the line genuinely lands on 0 at x=4
    expect(r.basis).not.toContain('clamped'); // …by fitting, not by clamping
  });
});

// ── The DECLARED ceiling ─────────────────────────────────────────────────────────────────────
//
// Three of the twelve period metrics are percentages on a 0–100 scale. Nothing about a rising
// series stops the fitted line at 100, so a healthy CI-success trend projected "≈ 104% (98–110%)"
// — a number that cannot exist, printed beside eleven that can.
//
// The ceiling is DECLARED by the caller, never inferred, and these tests pin both halves of that:
// a percentage metric gets capped, and a count metric whose values merely happen to sit under 100
// does NOT.
describe('forecastNext — a declared ceiling', () => {
  it('caps a percentage forecast at 100 and says so', () => {
    // Rises 4 points a period from 92 → the unclamped fit lands at 108 for x=4.
    const r = ok(forecastNext([92, 96, 100, 104], { max: 100 }));
    expect(r.point).toBe(100);
    expect(r.high).toBe(100);
    expect(r.basis).toContain('clamped at 100');
    // All three bounds move together, so the band can never come back inverted.
    expect(r.high).toBeGreaterThanOrEqual(r.point);
    expect(r.point).toBeGreaterThanOrEqual(r.low);
  });

  it('leaves a count metric alone even when every value is under 100', () => {
    // THE REASON THE CEILING IS DECLARED RATHER THAN INFERRED. `median_pr_size_lines` on a team
    // with small PRs looks exactly like a percentage to a data-inferred rule, and capping it would
    // silently truncate a real forecast.
    const r = ok(forecastNext([80, 88, 96, 104]));
    expect(r.point).toBe(112);
    expect(r.basis).not.toContain('clamped');
  });

  it('does not mention the ceiling when the forecast is comfortably below it', () => {
    const r = ok(forecastNext([40, 42, 44, 46], { max: 100 }));
    expect(r.point).toBe(48);
    expect(r.basis).not.toContain('clamped');
  });
});
