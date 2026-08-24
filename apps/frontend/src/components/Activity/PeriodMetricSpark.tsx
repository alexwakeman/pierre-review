import type { JSX } from 'react';
import { PALETTE } from '../charts/common.js';

// A three-stop sparkline with a forecast band: PRIOR → THIS PERIOD → NEXT (predicted).
//
// Why it is not in `components/charts/` with the rest of the toolkit: the toolkit's charts are
// full-width, ResizeObserver-measured panels (LineChart/BarChart/StackedArea…) and every one of
// them draws a SERIES. This draws at most three stops inside a table cell at a fixed size, and it
// is the only consumer. It follows the toolkit's conventions to the letter — explicit PALETTE
// hexes for the data marks (they read on light and dark alike), `currentColor` + Tailwind
// `text-*` for anything chrome-ish — so it can move next door verbatim the day a second surface
// wants it.
//
// The band is the honest half of this picture: a Theil–Sen point estimate with a ±2-MAD band is
// a claim about uncertainty, and drawing the point without the band would turn a hedge into a
// promise. When the forecast was REFUSED the caller passes none and this renders the two real
// stops only — never a dotted line trailing off to nowhere, which reads as a prediction.

export interface SparkForecast {
  point: number;
  low: number;
  high: number;
}

const W = 104;
const H = 30;
const PAD_X = 7;
const PAD_Y = 5;

export function PeriodMetricSpark({
  prior,
  value,
  forecast,
  format,
  favourableColor,
}: {
  prior: number | null;
  value: number | null;
  forecast: SparkForecast | null;
  format: (n: number) => string;
  // The hue for the observed line. Callers pass the metric's own read of the move (green when the
  // change went the good way, red when it didn't, gray for a neutral metric or an insignificant
  // change) so the spark agrees with the number beside it instead of inventing a second verdict.
  favourableColor: string;
}): JSX.Element | null {
  // Nothing observed this period ⇒ nothing to draw. The caller renders "—"; a chart of one
  // predicted point with no anchor would be pure fabrication.
  if (value == null) return null;

  // The x stops that actually exist. Prior is optional (first stored period), forecast is
  // optional (refused). A single stop still draws — one dot is a legitimate picture of
  // "this is where we are, with nothing to compare it to".
  const stops: { x: number; v: number | null }[] = [];
  if (prior != null) stops.push({ x: 0, v: prior });
  stops.push({ x: 0, v: value });
  if (forecast) stops.push({ x: 0, v: forecast.point });
  const n = stops.length;
  const innerW = W - PAD_X * 2;
  stops.forEach((s, i) => {
    s.x = PAD_X + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  });

  // y domain spans every number the picture contains, band edges included — otherwise a wide band
  // clips against the top of the cell and reads as narrower than it is.
  const all: number[] = stops.map((s) => s.v).filter((v): v is number => v != null);
  if (forecast) all.push(forecast.low, forecast.high);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-9) {
    // A perfectly flat picture: give it a token span so the line lands mid-cell rather than on
    // an edge. (Happens more than you'd think — two identical counts and a flat forecast.)
    const pad = Math.max(Math.abs(hi) * 0.1, 1);
    lo -= pad;
    hi += pad;
  }
  const innerH = H - PAD_Y * 2;
  const y = (v: number): number => PAD_Y + innerH * (1 - (v - lo) / (hi - lo));

  const observed = stops.slice(0, prior != null ? 2 : 1);
  const lastObserved = observed[observed.length - 1]!;
  const fx = forecast ? stops[stops.length - 1]!.x : null;

  const bandTop = forecast ? y(forecast.high) : 0;
  const bandBottom = forecast ? y(forecast.low) : 0;

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      className="overflow-visible text-gray-300 dark:text-gray-700"
      aria-label={
        `this period ${format(value)}` +
        (prior != null ? `, prior ${format(prior)}` : ', no prior period') +
        (forecast
          ? `, next ≈ ${format(forecast.point)} (${format(forecast.low)}–${format(forecast.high)})`
          : '')
      }
    >
      {/* Baseline rule, chrome not data → currentColor so it tracks the theme. */}
      <line x1={0} y1={H - 1} x2={W} y2={H - 1} stroke="currentColor" strokeWidth={1} />

      {forecast && fx != null && (
        <>
          {/* The uncertainty band, drawn UNDER everything: a soft wedge from the last observed
              point out to the predicted interval. Not a rectangle — the uncertainty starts at
              zero (we know where we are) and opens out to ±2 MAD one period ahead. */}
          <path
            d={`M ${lastObserved.x} ${y(lastObserved.v!)} L ${fx} ${bandTop} L ${fx} ${bandBottom} Z`}
            fill={PALETTE.violet}
            fillOpacity={0.18}
          />
          <line
            x1={lastObserved.x}
            y1={y(lastObserved.v!)}
            x2={fx}
            y2={y(forecast.point)}
            stroke={PALETTE.violet}
            strokeWidth={1.5}
            strokeDasharray="3 2"
          />
          <circle cx={fx} cy={y(forecast.point)} r={2.5} fill={PALETTE.violet} />
        </>
      )}

      {/* The observed leg — solid, because it happened. */}
      {observed.length > 1 && (
        <line
          x1={observed[0]!.x}
          y1={y(observed[0]!.v!)}
          x2={observed[1]!.x}
          y2={y(observed[1]!.v!)}
          stroke={favourableColor}
          strokeWidth={1.5}
        />
      )}
      {observed.map((s, i) => (
        <circle
          key={i}
          cx={s.x}
          cy={y(s.v!)}
          r={2.5}
          // The prior is hollow, this period is filled: the reader can tell which end is "now"
          // without a legend, at 30px tall.
          fill={i === observed.length - 1 ? favourableColor : 'transparent'}
          stroke={favourableColor}
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
