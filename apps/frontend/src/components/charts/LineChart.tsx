import { useLayoutEffect, useRef, useState } from 'react';
import {
  useChartWidth,
  fmtDate,
  fmtNum,
  niceMax,
  Legend,
  FloatingTip,
  ANOMALY_RING,
  splinePath,
  splineSegments,
  type Series,
} from './common.js';
import { RingIcon } from '../Icons.js';
import { logAxis, type LogTick } from '../../lib/logAxis.js';

// Multi-series line chart over a weekly x-axis (labels are ISO bucket-starts). The
// first series may render a soft area fill (area). Null values break that series'
// line (a gap). Hover snaps to the nearest week and shows every series' value.
export function LineChart({
  labels,
  series,
  area = false,
  curved = false,
  formatY = fmtNum,
  height = 132,
  logY = false,
  logScale,
  yDomain,
  centerTip = false,
  tipBelow = false,
  hideLegend = false,
  noteTone = 'anomaly',
}: {
  labels: string[];
  series: Series[];
  area?: boolean;
  curved?: boolean;
  formatY?: (n: number) => string;
  height?: number;
  // Log (base-10) y-axis with decade gridlines — accentuates small differences at the low end
  // when the series also has large spikes. Zeros/negatives floor to the bottom decade (log has no
  // 0). Falls back to linear when there's no positive value to scale. Opt-in; default linear.
  logY?: boolean;
  // A log y-axis with NAMED ticks (e.g. 1m · 10m · 1h · 6h · 1d for a duration in hours): only the
  // ticks that bracket the data are drawn (`lib/logAxis.ts`). A value under `floor` — a zero
  // included — is DRAWN on the floor; the hover still shows the real value. Null stays a gap.
  // Wins over `logY` and `yDomain`.
  logScale?: { ticks: readonly LogTick[]; floor: number };
  // An EXPLICIT linear y-scale with its own gridlines, for a series whose axis is a fixed
  // ordinal scale rather than a magnitude — e.g. severity nit(1)…critical(4), where the default
  // 0→niceMax(4)=5 would put the ticks at 0 and 5, i.e. on two values the metric cannot take and
  // has no name for. Values outside [min,max] are clamped to the edge rather than drawn off the
  // plot. Ignored when `logY` wins a domain.
  yDomain?: { min: number; max: number; ticks: number[] };
  // Pin the hover tooltip to the chart's horizontal centre (see FloatingTip) so it can't spill
  // into a neighbouring panel at the far edges — for wide, multi-series charts.
  centerTip?: boolean;
  // Render the hover summary as a right-aligned strip BELOW the chart (never overlapping the plot
  // area or a neighbour) instead of the floating in-chart tooltip. Reserves space so no jump.
  tipBelow?: boolean;
  // Suppress the built-in legend (the host renders its own — e.g. an interactive series selector).
  hideLegend?: boolean;
  // How a `pointNotes` entry reads. 'anomaly' (default) is the red ⭘ exception note — THIS POINT
  // DIVERGED. 'muted' is a neutral gray detail line for a note that is just extra context (the
  // counts behind a mean), which must not borrow the exception colour: a note on every point,
  // painted red, says "everything is an outlier".
  noteTone?: 'anomaly' | 'muted';
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);
  // The widest y tick label as the browser actually drew it (0 until measured). The character
  // estimate below is only the first guess: font metrics differ by machine (a CI runner without
  // Archivo draws "100%" ~40px wide), so the pad follows the measured width once it is known.
  const yLabelsRef = useRef<SVGGElement>(null);
  const [measuredLabelW, setMeasuredLabelW] = useState(0);

  const PAD_R = 8;
  // The top tick's label is centred on its gridline (see the <text> below), so half a line of
  // type has to fit above the plot or the top label ("100%") is cut by the SVG's edge.
  const PAD_T = 10;
  const PAD_B = 18;
  const n = labels.length;
  const innerH = height - PAD_T - PAD_B;
  const baseY = PAD_T + innerH;

  // y-scale: linear (0 → niceMax) by default; log10 across whole decades when `logY` and there's
  // positive spread to justify it. Both expose the same `y(v)` mapping + a `yTicks` list for the
  // gridlines/labels, so the rest of the renderer is scale-agnostic.
  const positives = series
    .flatMap((s) => s.values)
    .filter((v): v is number => v != null && v > 0);
  const useLog = logY && positives.length > 0;
  const named = logScale ? logAxis(series.flatMap((s) => s.values), logScale.ticks, logScale.floor) : null;
  let y: (v: number) => number;
  let yTicks: number[];
  let tickLabel: (v: number) => string = formatY;
  if (named && logScale) {
    const loL = Math.log10(named.lo);
    const span = Math.max(Math.log10(named.hi) - loL, 1e-9);
    y = (v: number): number => {
      const cl = Math.min(named.hi, Math.max(logScale.floor, v));
      return PAD_T + innerH * (1 - (Math.log10(cl) - loL) / span);
    };
    // Thin the ticks so no two labels touch (14px type): keep the top one, walk down, and drop a
    // tick closer than MIN_GAP to the last one kept — the bottom tick wins over its upper neighbour.
    const MIN_GAP = 17;
    const kept: number[] = [];
    for (const t of [...named.ticks].reverse()) {
      const last = kept[kept.length - 1];
      if (last == null || y(t.value) - y(last) >= MIN_GAP) kept.push(t.value);
      else if (t === named.ticks[0] && kept.length > 1) kept[kept.length - 1] = t.value;
    }
    yTicks = kept.reverse();
    const byValue = new Map(named.ticks.map((t) => [t.value, t.label]));
    tickLabel = (v: number): string => byValue.get(v) ?? formatY(v);
  } else if (!useLog && yDomain) {
    const span = Math.max(yDomain.max - yDomain.min, 1e-9);
    y = (v: number): number => {
      const cl = Math.min(yDomain.max, Math.max(yDomain.min, v));
      return PAD_T + innerH * (1 - (cl - yDomain.min) / span);
    };
    yTicks = yDomain.ticks;
  } else if (useLog) {
    const hiExp = Math.ceil(Math.log10(Math.max(...positives)) - 1e-9);
    let loExp = Math.floor(Math.log10(Math.min(...positives)) + 1e-9);
    if (loExp >= hiExp) loExp = hiExp - 1; // guarantee at least one decade of range
    const span = hiExp - loExp;
    const floorV = Math.pow(10, loExp);
    y = (v: number): number => {
      const cl = v <= floorV ? floorV : v; // 0 / sub-floor values sit on the bottom decade
      return PAD_T + innerH * (1 - (Math.log10(cl) - loExp) / span);
    };
    yTicks = [];
    for (let e = loExp; e <= hiExp; e++) yTicks.push(Math.pow(10, e));
  } else {
    const maxV = niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
    y = (v: number): number => PAD_T + innerH * (1 - v / maxV);
    yTicks = [0, maxV];
  }

  // The left pad fits the WIDEST y tick. The labels are `text-meta`, 14px in page content (12px
  // only in the compact sidebar), ≈ 8.4px a character in Archivo: at the old 6.6px estimate a
  // word axis ("Critical") lost its first letter and "100%" lost its "1".
  const estimatedLabelW = Math.max(0, ...yTicks.map((v) => tickLabel(v).length)) * 8.4;
  const PAD_L = Math.max(36, Math.ceil(Math.max(estimatedLabelW, measuredLabelW)) + 8);
  const tickKey = yTicks.map((v) => tickLabel(v)).join('|');
  useLayoutEffect(() => {
    const g = yLabelsRef.current;
    if (g == null) return;
    let widest = 0;
    for (const t of Array.from(g.querySelectorAll('text'))) {
      // getBBox is the drawn box; jsdom has none, so a test environment keeps the estimate.
      const bw = typeof t.getBBox === 'function' ? t.getBBox().width : 0;
      if (bw > widest) widest = bw;
    }
    if (Math.abs(widest - measuredLabelW) > 0.5) setMeasuredLabelW(widest);
  }, [tickKey, w, measuredLabelW]);
  const innerW = Math.max(w - PAD_L - PAD_R, 1);
  const x = (i: number): number => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);

  const linePath = (s: Series): string =>
    s.values
      .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
      .reduce<{ d: string; pen: boolean }>(
        (acc, pt) => {
          if (pt == null) return { d: acc.d, pen: false };
          return { d: `${acc.d}${acc.pen ? ' L' : ' M'} ${pt}`, pen: true };
        },
        { d: '', pen: false },
      ).d;

  const areaPath = (s: Series): string => {
    const pts = s.values
      .map((v, i) => (v == null ? null : ([x(i), y(v)] as const)))
      .filter((p): p is readonly [number, number] => p != null);
    if (pts.length < 2) return '';
    return (
      `M ${pts[0]![0]} ${baseY} ` +
      pts.map(([px, py]) => `L ${px} ${py}`).join(' ') +
      ` L ${pts[pts.length - 1]![0]} ${baseY} Z`
    );
  };

  // --- Smooth variants, used only when `curved`. The spline itself is `splinePath` /
  // `splineSegments` in ./common.js — one implementation for every line chart.

  // Each contiguous run of non-null points is its own smooth sub-path (breaks
  // on gaps, mirroring linePath); a run of length 1 is just `M x y`.
  const smoothLinePath = (s: Series): string => {
    const runs: (readonly [number, number])[][] = [];
    let cur: (readonly [number, number])[] = [];
    s.values.forEach((v, i) => {
      if (v == null) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else {
        cur.push([x(i), y(v)] as const);
      }
    });
    if (cur.length) runs.push(cur);
    return runs.map(splinePath).join(' ');
  };

  // Smooth top edge (across-gap contiguous, mirroring areaPath) closed to baseY.
  const smoothAreaPath = (s: Series): string => {
    const pts = s.values
      .map((v, i) => (v == null ? null : ([x(i), y(v)] as const)))
      .filter((p): p is readonly [number, number] => p != null);
    if (pts.length < 2) return '';
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    return (
      `M ${first[0]} ${baseY} L ${first[0]} ${first[1]}` +
      splineSegments(pts) +
      ` L ${last[0]} ${baseY} Z`
    );
  };

  const linePathFor = curved ? smoothLinePath : linePath;
  const areaPathFor = curved ? smoothAreaPath : areaPath;

  // One line's stroke. Dashed series (a fitted trend overlay) render thicker + full-opacity so
  // they stand out, and are painted LAST (over the data lines + dots) by the caller's ordering.
  const renderPath = (s: Series): JSX.Element => (
    <path
      key={s.key}
      d={linePathFor(s)}
      fill="none"
      stroke={s.color}
      strokeWidth={s.dashed ? 2.75 : 1.5}
      strokeOpacity={s.dimmed ? 0.2 : undefined}
      strokeDasharray={s.dashed ? '6 4' : undefined}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  );

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const ox = e.nativeEvent.offsetX;
    const i = n <= 1 ? 0 : Math.round(((ox - PAD_L) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div>
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} className="block">
            {/* y gridlines + labels (0/max for linear; each decade for log) */}
            <g ref={yLabelsRef}>
            {yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={PAD_L}
                  y1={y(v)}
                  x2={w - PAD_R}
                  y2={y(v)}
                  className="decorative-mark text-ui-faint"
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <text
                  x={PAD_L - 4}
                  y={y(v)}
                  dominantBaseline="middle"
                  textAnchor="end"
                  className="fill-ui-faint text-meta"
                >
                  {tickLabel(v)}
                </text>
              </g>
            ))}
            </g>
            {area && series[0] && areaPathFor(series[0]) && (
              <path d={areaPathFor(series[0])} fill={series[0].color} opacity={0.12} />
            )}
            {hover != null && (
              <line
                x1={x(hover)}
                y1={PAD_T}
                x2={x(hover)}
                y2={baseY}
                className="decorative-mark text-ui-faint"
                stroke="currentColor"
                strokeWidth={1}
              />
            )}
            {/* data lines first, then dots, then any dashed trend line ON TOP (below) */}
            {series.filter((s) => !s.dashed).map(renderPath)}
            {series.map((s) =>
              s.dashed || s.dimmed
                ? null // a fitted overlay (trend line) and a dimmed line carry no data dots
                : s.values.map((v, i) => {
                if (v == null) return null;
                const flagged = s.pointFlags?.[i] === true;
                return (
                  <g key={`${s.key}-${i}`}>
                    {/* Anomaly ring: this point diverged from the bot's own typical. */}
                    {flagged && (
                      <circle
                        cx={x(i)}
                        cy={y(v)}
                        r={4.5}
                        fill="none"
                        stroke={ANOMALY_RING}
                        strokeWidth={1.5}
                      />
                    )}
                    <circle
                      cx={x(i)}
                      cy={y(v)}
                      r={hover === i ? 3 : flagged ? 2.4 : 1.8}
                      fill={flagged ? ANOMALY_RING : s.color}
                    />
                  </g>
                );
              }),
            )}
            {/* dashed trend line(s) painted last so they sit above every data line + dot */}
            {series.filter((s) => s.dashed).map(renderPath)}
            {/* x ticks: first + last */}
            <text x={PAD_L} y={height - 4} className="fill-ui-faint text-meta">
              {labels[0] ? fmtDate(labels[0]) : ''}
            </text>
            <text
              x={w - PAD_R}
              y={height - 4}
              textAnchor="end"
              className="fill-ui-faint text-meta"
            >
              {labels[n - 1] ? fmtDate(labels[n - 1]!) : ''}
            </text>
            <rect
              x={0}
              y={0}
              width={w}
              height={height}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
        )}
        {!tipBelow && hover != null && w > 0 && (
          <FloatingTip x={x(hover)} y={PAD_T} width={w} centered={centerTip}>
            <div className="font-medium">{labels[hover] ? fmtDate(labels[hover]!) : ''}</div>
            {series.filter((s) => !s.dashed && !s.dimmed).map((s) => {
              const note = s.pointNotes?.[hover] ?? null;
              return (
                <div key={s.key}>
                  <div className="flex items-center gap-1">
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-[1px]"
                      style={{ background: s.color }}
                    />
                    {s.label}: {s.values[hover] == null ? '—' : formatY(s.values[hover]!)}
                  </div>
                  {/* The ringed-point explanation — why THIS point is an exception (or, in the
                      'muted' tone, plain detail behind the value). */}
                  {note && (
                    <div
                      className={`ml-2.5 mt-0.5 flex max-w-[220px] items-start gap-1 whitespace-normal ${
                        noteTone === 'muted' ? 'text-ui-mute' : ''
                      }`}
                      style={noteTone === 'muted' ? undefined : { color: ANOMALY_RING }}
                    >
                      <span className="mt-px flex shrink-0 items-center">
                        {noteTone === 'muted' ? '·' : <RingIcon size={9} />}
                      </span>
                      <span>{note}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </FloatingTip>
        )}
      </div>
      {/* Below-chart summary strip — the point-in-time breakdown, right-aligned, outside the plot
          so it never covers the lines or a neighbouring panel. Reserves height to avoid a jump. */}
      {tipBelow && (
        <div className="mt-1 flex min-h-[1.75rem] flex-wrap items-baseline justify-end gap-x-3 gap-y-0.5 text-meta leading-tight">
          {hover == null ? (
            <span className="text-ui-faint">hover a week for its point-in-time breakdown</span>
          ) : (
            <>
              <span className="font-medium text-ui-mute">
                {labels[hover] ? fmtDate(labels[hover]!) : ''}
              </span>
              {series
                .filter((s) => !s.dashed && !s.dimmed)
                .map((s) => {
                  const v = s.values[hover!];
                  const note = s.pointNotes?.[hover!] ?? null;
                  return (
                    <span key={s.key} className="flex items-baseline gap-1">
                      <span
                        className="inline-block h-1.5 w-1.5 translate-y-px rounded-[1px]"
                        style={{ background: s.color }}
                      />
                      <span className="text-ui-mute">
                        {s.label}: {v == null ? '—' : formatY(v)}
                      </span>
                      {note &&
                        (noteTone === 'muted' ? (
                          <span className="text-ui-mute">· {note}</span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1"
                            style={{ color: ANOMALY_RING }}
                          >
                            <RingIcon size={9} />
                            {note}
                          </span>
                        ))}
                    </span>
                  );
                })}
            </>
          )}
        </div>
      )}
      {!hideLegend && series.length > 1 && <Legend series={series} />}
    </div>
  );
}
