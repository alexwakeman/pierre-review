import { useState } from 'react';
import { useChartWidth, fmtNum, Legend, FloatingTip, PALETTE } from './common.js';

export interface ScatterPoint {
  x: number;
  y: number;
  label: string;
  merged?: boolean;
}

// Scatter on log–log axes (both x = LOC and y = hours are heavy-tailed, so a
// linear scale would clump everything at the origin). log10(1+v) keeps v=0 at the
// origin. Hover snaps to the nearest point.
export function ScatterChart({
  points,
  xLabel,
  yLabel,
  formatX = fmtNum,
  formatY = fmtNum,
  height = 150,
}: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  formatX?: (n: number) => string;
  formatY?: (n: number) => string;
  height?: number;
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const PAD_L = 32;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 18;
  const innerW = Math.max(w - PAD_L - PAD_R, 1);
  const innerH = height - PAD_T - PAD_B;
  const lg = (v: number): number => Math.log10(1 + Math.max(0, v));
  const xMax = lg(Math.max(1, ...points.map((p) => p.x)));
  const yMax = lg(Math.max(1, ...points.map((p) => p.y)));
  const X = (v: number): number => PAD_L + (lg(v) / (xMax || 1)) * innerW;
  const Y = (v: number): number => PAD_T + innerH * (1 - lg(v) / (yMax || 1));

  // Gridline ticks at the powers of ten that fall inside each axis range.
  const ticks = (maxLg: number): number[] =>
    [0, 1, 10, 100, 1000, 10000].filter((v) => lg(v) <= maxLg + 0.01);

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const mx = e.nativeEvent.offsetX;
    const my = e.nativeEvent.offsetY;
    let best = -1;
    let bestD = 14 * 14;
    points.forEach((p, i) => {
      const dx = X(p.x) - mx;
      const dy = Y(p.y) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best >= 0 ? best : null);
  };

  const hp = hover != null ? points[hover] : null;

  return (
    <div>
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} className="block">
            {ticks(yMax).map((v) => (
              <g key={`y${v}`}>
                <line
                  x1={PAD_L}
                  y1={Y(v)}
                  x2={w - PAD_R}
                  y2={Y(v)}
                  className="text-gray-200 dark:text-gray-700"
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <text x={PAD_L - 4} y={Y(v) + 3} textAnchor="end" className="fill-gray-400 text-[8px]">
                  {formatY(v)}
                </text>
              </g>
            ))}
            {ticks(xMax).map((v) => (
              <text
                key={`x${v}`}
                x={X(v)}
                y={height - 8}
                textAnchor="middle"
                className="fill-gray-400 text-[8px]"
              >
                {formatX(v)}
              </text>
            ))}
            {points.map((p, i) => (
              <circle
                key={i}
                cx={X(p.x)}
                cy={Y(p.y)}
                r={hover === i ? 4 : 2.2}
                fill={p.merged ? PALETTE.green : PALETTE.gray}
                opacity={hover == null || hover === i ? 0.75 : 0.3}
              />
            ))}
            <text x={PAD_L} y={height - 1} className="fill-gray-400 text-[8px]">
              {xLabel} →
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
        {hp && w > 0 && (
          <FloatingTip x={X(hp.x)} y={Y(hp.y)} width={w}>
            <div className="font-medium">{hp.label}</div>
            <div>
              {xLabel}: {formatX(hp.x)}
            </div>
            <div>
              {yLabel}: {formatY(hp.y)}
            </div>
          </FloatingTip>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-gray-400">{yLabel} (log) ↑</span>
        <Legend
          series={[
            { label: 'merged', color: PALETTE.green },
            { label: 'closed', color: PALETTE.gray },
          ]}
        />
      </div>
    </div>
  );
}
