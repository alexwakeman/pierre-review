import { useState } from 'react';
import { useChartWidth, FloatingTip, PALETTE } from './common.js';

// Activity heatmap: weekday (rows) × hour-of-day (cols), colour intensity ∝ count.
// `cells` is row-major dow*24+hour with dow 0=Sunday (the API's UTC convention);
// rows are reordered to Mon→Sun for reading. Hover a cell for its exact count.
const ROW_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun (source dow indices)
const ROW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Heatmap({
  cells,
  height,
  color,
}: {
  cells: number[];
  height?: number;
  // Cell hue (default the toolkit blue) — lets a per-bot heatmap use that bot's brand colour.
  color?: string;
}): JSX.Element {
  const hue = color ?? PALETTE.blue;
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);

  const PAD_L = 26;
  const PAD_T = 2;
  const cellH = 14;
  const gridW = Math.max(w - PAD_L - 2, 1);
  const cellW = gridW / 24;
  const H = height ?? PAD_T + 7 * cellH + 14;
  const max = Math.max(1, ...cells);

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const col = Math.floor((e.nativeEvent.offsetX - PAD_L) / cellW);
    const row = Math.floor((e.nativeEvent.offsetY - PAD_T) / cellH);
    if (col < 0 || col > 23 || row < 0 || row > 6) {
      setHover(null);
      return;
    }
    setHover({ row, col });
  };

  const countAt = (row: number, col: number): number => cells[ROW_ORDER[row]! * 24 + col] ?? 0;

  return (
    <div>
      <div ref={ref} className="relative" style={{ height: H }}>
        {w > 0 && (
          <svg width={w} height={H} className="block">
            {ROW_LABELS.map((d, row) => (
              <text
                key={d}
                x={PAD_L - 4}
                y={PAD_T + row * cellH + cellH - 4}
                textAnchor="end"
                className="fill-gray-400 text-[8px]"
              >
                {d}
              </text>
            ))}
            {ROW_ORDER.map((_, row) =>
              Array.from({ length: 24 }, (_, col) => {
                const c = countAt(row, col);
                const isHover = hover?.row === row && hover?.col === col;
                return (
                  <rect
                    key={`${row}-${col}`}
                    x={PAD_L + col * cellW}
                    y={PAD_T + row * cellH}
                    width={Math.max(cellW - 1, 1)}
                    height={cellH - 1}
                    rx={1.5}
                    fill={c > 0 ? hue : 'currentColor'}
                    className={c > 0 ? '' : 'text-gray-100 dark:text-gray-800'}
                    fillOpacity={c > 0 ? 0.15 + 0.85 * (c / max) : 1}
                    stroke={isHover ? hue : 'none'}
                    strokeWidth={isHover ? 1.5 : 0}
                  />
                );
              }),
            )}
            {[0, 6, 12, 18].map((hr) => (
              <text
                key={hr}
                x={PAD_L + hr * cellW}
                y={H - 3}
                className="fill-gray-400 text-[8px]"
              >
                {hr}:00
              </text>
            ))}
            <rect
              x={0}
              y={0}
              width={w}
              height={H}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hover && w > 0 && (
          <FloatingTip
            x={PAD_L + hover.col * cellW + cellW / 2}
            y={PAD_T + hover.row * cellH}
            width={w}
          >
            {FULL_DAY[ROW_ORDER[hover.row]!]} {String(hover.col).padStart(2, '0')}:00 ·{' '}
            {countAt(hover.row, hover.col)} events
          </FloatingTip>
        )}
      </div>
    </div>
  );
}
