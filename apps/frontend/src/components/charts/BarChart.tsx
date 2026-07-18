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

// Bar chart over categorical x. Labels that look like ISO dates render as weekly
// ticks (first/last only when crowded); short bin labels render under each bar.
// `mode` is 'grouped' (side-by-side) or 'stacked'. Series values are plain numbers.
export function BarChart({
  labels,
  series,
  mode = 'grouped',
  formatY = fmtNum,
  formatValue = formatY,
  height = 132,
  rotateLabels = false,
}: {
  labels: string[];
  series: Series[];
  mode?: 'grouped' | 'stacked';
  formatY?: (n: number) => string;
  formatValue?: (n: number) => string;
  height?: number;
  // Render the x-axis labels diagonally (−35°) instead of horizontal — for crowded
  // categorical labels (e.g. CI stage names) that would overlap. The chart's overall
  // footprint (`height`) is UNCHANGED: a larger bottom band is reserved for the labels,
  // so the plot area shrinks slightly rather than the card growing.
  rotateLabels?: boolean;
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const PAD_L = 30;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = rotateLabels ? 40 : 16;
  const n = labels.length;
  const innerW = Math.max(w - PAD_L - PAD_R, 1);
  const innerH = height - PAD_T - PAD_B;
  const isDate = /^\d{4}-\d{2}-\d{2}T/.test(labels[0] ?? '');

  const colTotal = (i: number): number => series.reduce((s, ser) => s + (ser.values[i] ?? 0), 0);
  const maxV = niceMax(
    mode === 'stacked'
      ? Math.max(1, ...labels.map((_, i) => colTotal(i)))
      : Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))),
  );
  const bandW = innerW / Math.max(n, 1);
  const barAreaX = (i: number): number => PAD_L + i * bandW + bandW * 0.15;
  const barAreaW = bandW * 0.7;
  const y = (v: number): number => PAD_T + innerH * (1 - v / maxV);
  const baseY = PAD_T + innerH;

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const i = Math.floor((e.nativeEvent.offsetX - PAD_L) / bandW);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const labelFor = (i: number): string => {
    const l = labels[i] ?? '';
    return isDate ? fmtDate(l) : l;
  };
  const showEveryLabel = !isDate || n <= 8;

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
                  className="text-gray-200 dark:text-gray-700"
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <text x={PAD_L - 4} y={y(v) + 3} textAnchor="end" className="fill-gray-400 text-[8px]">
                  {formatY(v)}
                </text>
              </g>
            ))}
            {hover != null && (
              <rect
                x={PAD_L + hover * bandW}
                y={PAD_T}
                width={bandW}
                height={innerH}
                className="text-gray-400/10 dark:text-gray-300/10"
                fill="currentColor"
              />
            )}
            {labels.map((_, i) => {
              if (mode === 'stacked') {
                let acc = 0;
                return series.map((s) => {
                  const v = s.values[i] ?? 0;
                  if (v <= 0) return null;
                  const yTop = y(acc + v);
                  const h = y(acc) - yTop;
                  acc += v;
                  return (
                    <rect
                      key={`${i}-${s.key}`}
                      x={barAreaX(i)}
                      y={yTop}
                      width={barAreaW}
                      height={Math.max(h, 0)}
                      fill={s.colors?.[i] ?? s.color}
                    />
                  );
                });
              }
              const each = barAreaW / Math.max(series.length, 1);
              return series.map((s, si) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                return (
                  <rect
                    key={`${i}-${s.key}`}
                    x={barAreaX(i) + si * each}
                    y={y(v)}
                    width={Math.max(each - 0.5, 0.5)}
                    height={baseY - y(v)}
                    fill={s.colors?.[i] ?? s.color}
                  />
                );
              });
            })}
            {labels.map((_, i) => {
              if (!(showEveryLabel || i === 0 || i === n - 1)) return null;
              const cx = PAD_L + i * bandW + bandW / 2;
              if (rotateLabels) {
                // Anchor the label's END just below the axis at the bar centre, then
                // rotate −35° so it reads diagonally up-left without overlapping neighbours.
                const ly = baseY + 9;
                return (
                  <text
                    key={`lbl-${i}`}
                    x={cx}
                    y={ly}
                    textAnchor="end"
                    transform={`rotate(-35 ${cx} ${ly})`}
                    className="fill-gray-400 text-[8px]"
                  >
                    {labelFor(i)}
                  </text>
                );
              }
              return (
                <text
                  key={`lbl-${i}`}
                  x={cx}
                  y={height - 4}
                  textAnchor="middle"
                  className="fill-gray-400 text-[8px]"
                >
                  {labelFor(i)}
                </text>
              );
            })}
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
          <FloatingTip x={PAD_L + hover * bandW + bandW / 2} y={PAD_T} width={w}>
            <div className="font-medium">{labelFor(hover)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-[1px]"
                  style={{ background: s.colors?.[hover] ?? s.color }}
                />
                {s.label}: {formatValue(s.values[hover] ?? 0)}
              </div>
            ))}
            {mode === 'stacked' && series.length > 1 && (
              <div className="mt-0.5 border-t border-gray-200 pt-0.5 dark:border-gray-700">
                total: {formatValue(colTotal(hover))}
              </div>
            )}
          </FloatingTip>
        )}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </div>
  );
}
