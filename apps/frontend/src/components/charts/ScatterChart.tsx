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
  fit = false,
  height = 150,
}: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  formatX?: (n: number) => string;
  formatY?: (n: number) => string;
  // Overlay a power-law fit (least-squares on the log–log points, x>0 & y>0): a
  // straight line on log–log iff time ∝ LOCᵏ, so slope k > 1 = bigger PRs are
  // disproportionately slower to land. The slope is annotated on the chart.
  fit?: boolean;
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

  // Power-law fit: least-squares on log10(x)/log10(y) over points with x>0 & y>0,
  // then a sampled polyline (the plot maps via log1p, so sample rather than draw a
  // single segment). slope = the exponent k in time ∝ LOCᵏ.
  const fitLine = ((): { d: string; slope: number } | null => {
    if (!fit) return null;
    const ps = points.filter((p) => p.x > 0 && p.y > 0);
    if (ps.length < 4) return null;
    const lxs = ps.map((p) => Math.log10(p.x));
    const lys = ps.map((p) => Math.log10(p.y));
    const N = ps.length;
    const mx = lxs.reduce((a, b) => a + b, 0) / N;
    const my = lys.reduce((a, b) => a + b, 0) / N;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < N; i++) {
      sxx += (lxs[i]! - mx) ** 2;
      sxy += (lxs[i]! - mx) * (lys[i]! - my);
    }
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const lxMin = Math.min(...lxs);
    const lxMax = Math.max(...lxs);
    if (lxMax <= lxMin) return null;
    const steps = 24;
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const lxv = lxMin + (i / steps) * (lxMax - lxMin);
      const xv = 10 ** lxv;
      const yv = 10 ** (intercept + slope * lxv);
      d += `${i === 0 ? 'M' : ' L'} ${X(xv).toFixed(1)} ${Y(yv).toFixed(1)}`;
    }
    return { d, slope };
  })();

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
            {fitLine && (
              <path
                d={fitLine.d}
                fill="none"
                stroke={PALETTE.amber}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                opacity={0.95}
              />
            )}
            {fitLine && (
              <text
                x={PAD_L + 5}
                y={PAD_T + 9}
                fill={PALETTE.amber}
                className="text-[8px] font-semibold"
              >
                ≈ {yLabel} ∝ {xLabel}^{fitLine.slope.toFixed(1)}
              </text>
            )}
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
