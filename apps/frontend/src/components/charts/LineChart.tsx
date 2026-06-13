import { useState } from 'react';
import {
  useChartWidth,
  fmtDate,
  fmtNum,
  niceMax,
  Legend,
  FloatingTip,
  type Series,
} from './common.js';

// Multi-series line chart over a weekly x-axis (labels are ISO bucket-starts). The
// first series may render a soft area fill (area). Null values break that series'
// line (a gap). Hover snaps to the nearest week and shows every series' value.
export function LineChart({
  labels,
  series,
  area = false,
  formatY = fmtNum,
  height = 132,
}: {
  labels: string[];
  series: Series[];
  area?: boolean;
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
            {area && series[0] && areaPath(series[0]) && (
              <path d={areaPath(series[0])} fill={series[0].color} opacity={0.12} />
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
                d={linePath(s)}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {series.map((s) =>
              s.values.map((v, i) =>
                v == null ? null : (
                  <circle
                    key={`${s.key}-${i}`}
                    cx={x(i)}
                    cy={y(v)}
                    r={hover === i ? 3 : 1.8}
                    fill={s.color}
                  />
                ),
              ),
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
