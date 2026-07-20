import { useState } from 'react';
import {
  useChartWidth,
  fmtDate,
  fmtNum,
  niceMax,
  Legend,
  FloatingTip,
  ANOMALY_RING,
  type Series,
} from './common.js';

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
}: {
  labels: string[];
  series: Series[];
  area?: boolean;
  curved?: boolean;
  formatY?: (n: number) => string;
  height?: number;
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const PAD_L = 30;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 16;
  const n = labels.length;
  const innerW = Math.max(w - PAD_L - PAD_R, 1);
  const innerH = height - PAD_T - PAD_B;
  const maxV = niceMax(
    Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))),
  );
  const x = (i: number): number => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number): number => PAD_T + innerH * (1 - v / maxV);
  const baseY = PAD_T + innerH;

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

  // --- Smooth (Catmull-Rom → cubic-bezier, tension 1/6) variants, used only
  // when `curved`. bezierSegments emits the `C …` commands for a contiguous
  // point run (no leading `M`); endpoints are clamped (P−1=P0, Pn+1=Pn).
  const bezierSegments = (pts: readonly (readonly [number, number])[]): string => {
    let d = '';
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[i + 2] ?? p2;
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2[0]} ${p2[1]}`;
    }
    return d;
  };

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
    return runs
      .map((r) => {
        const head = `M ${r[0]![0]} ${r[0]![1]}`;
        return r.length < 2 ? head : head + bezierSegments(r);
      })
      .join(' ');
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
      bezierSegments(pts) +
      ` L ${last[0]} ${baseY} Z`
    );
  };

  const linePathFor = curved ? smoothLinePath : linePath;
  const areaPathFor = curved ? smoothAreaPath : areaPath;

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
            {/* y gridline + labels at 0 and max */}
            {[0, maxV].map((v) => (
              <g key={v}>
                <line
                  x1={PAD_L}
                  y1={y(v)}
                  x2={w - PAD_R}
                  y2={y(v)}
                  className="text-gray-200 dark:text-gray-700"
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <text
                  x={PAD_L - 4}
                  y={y(v) + 3}
                  textAnchor="end"
                  className="fill-gray-400 text-[8px]"
                >
                  {formatY(v)}
                </text>
              </g>
            ))}
            {area && series[0] && areaPathFor(series[0]) && (
              <path d={areaPathFor(series[0])} fill={series[0].color} opacity={0.12} />
            )}
            {hover != null && (
              <line
                x1={x(hover)}
                y1={PAD_T}
                x2={x(hover)}
                y2={baseY}
                className="text-gray-300 dark:text-gray-600"
                stroke="currentColor"
                strokeWidth={1}
              />
            )}
            {series.map((s) => (
              <path
                key={s.key}
                d={linePathFor(s)}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {series.map((s) =>
              s.values.map((v, i) => {
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
            {/* x ticks: first + last */}
            <text x={PAD_L} y={height - 4} className="fill-gray-400 text-[8px]">
              {labels[0] ? fmtDate(labels[0]) : ''}
            </text>
            <text
              x={w - PAD_R}
              y={height - 4}
              textAnchor="end"
              className="fill-gray-400 text-[8px]"
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
        {hover != null && w > 0 && (
          <FloatingTip x={x(hover)} y={PAD_T} width={w}>
            <div className="font-medium">{labels[hover] ? fmtDate(labels[hover]!) : ''}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-[1px]" style={{ background: s.color }} />
                {s.label}: {s.values[hover] == null ? '—' : formatY(s.values[hover]!)}
              </div>
            ))}
          </FloatingTip>
        )}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </div>
  );
}
