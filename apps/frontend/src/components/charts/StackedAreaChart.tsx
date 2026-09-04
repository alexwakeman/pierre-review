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

// Stacked-area chart over a weekly x-axis (labels are ISO bucket-starts). Series
// stack from the baseline up; hover snaps to a week and lists each band's value.
export function StackedAreaChart({
  labels,
  series,
  formatValue = fmtNum,
  height = 132,
}: {
  labels: string[];
  series: Series[];
  formatValue?: (n: number) => string;
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
  const at = (s: Series, i: number): number => s.values[i] ?? 0;
  const colTotal = (i: number): number => series.reduce((sum, s) => sum + at(s, i), 0);
  const maxV = niceMax(Math.max(1, ...labels.map((_, i) => colTotal(i))));
  const x = (i: number): number => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number): number => PAD_T + innerH * (1 - v / maxV);
  const baseY = PAD_T + innerH;

  // Cumulative lower edge per series, so each band is the ribbon between the
  // running total below it and that total plus its own value.
  const lower: number[][] = [];
  {
    const running = labels.map(() => 0);
    for (const s of series) {
      lower.push([...running]);
      labels.forEach((_, i) => (running[i] = (running[i] ?? 0) + at(s, i)));
    }
  }

  const bandPath = (s: Series, k: number): string => {
    const lo = lower[k]!;
    const top = labels.map((_, i) => [x(i), y(lo[i]! + at(s, i))] as const);
    const bot = labels.map((_, i) => [x(i), y(lo[i]!)] as const).reverse();
    return (
      `M ${top.map(([px, py]) => `${px},${py}`).join(' L ')} ` +
      `L ${bot.map(([px, py]) => `${px},${py}`).join(' L ')} Z`
    );
  };

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const i = n <= 1 ? 0 : Math.round(((e.nativeEvent.offsetX - PAD_L) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div>
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} className="block">
            {[0, maxV].map((v) => (
              <g key={v}>
                <line
                  x1={PAD_L}
                  y1={y(v)}
                  x2={w - PAD_R}
                  y2={y(v)}
                  className="decorative-mark text-gray-200 dark:text-gray-700"
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <text x={PAD_L - 4} y={y(v) + 3} textAnchor="end" className="fill-gray-400 text-[8px]">
                  {fmtNum(v)}
                </text>
              </g>
            ))}
            {series.map((s, k) => (
              <path key={s.key} d={bandPath(s, k)} fill={s.color} opacity={0.85} />
            ))}
            {hover != null && (
              <line
                x1={x(hover)}
                y1={PAD_T}
                x2={x(hover)}
                y2={baseY}
                className="text-gray-400 dark:text-gray-300"
                stroke="currentColor"
                strokeWidth={1}
              />
            )}
            <text x={PAD_L} y={height - 4} className="fill-gray-400 text-[8px]">
              {labels[0] ? fmtDate(labels[0]) : ''}
            </text>
            <text x={w - PAD_R} y={height - 4} textAnchor="end" className="fill-gray-400 text-[8px]">
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
                {s.label}: {formatValue(at(s, hover))}
              </div>
            ))}
            <div className="mt-0.5 border-t border-gray-200 pt-0.5 dark:border-gray-700">
              total: {formatValue(colTotal(hover))}
            </div>
          </FloatingTip>
        )}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </div>
  );
}
