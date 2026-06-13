import { useEffect, useRef, useState } from 'react';
import type { InsightsTimePoint } from '@pierre-review/shared';

// A tiny zero-dependency SVG trend chart for the Insights panel: the per-repo
// "average time a PR stays open" series (cycle time by close week). Themed with
// Tailwind via `currentColor` so the line/area/dots track the app's blue accent in
// light and dark. Hovering reveals a vertical guide + the hovered week's values in
// the header line (no floating box — robust against the modal's overflow clip).

// Hours → a compact human duration: m / h / d, scaling the precision down as the
// magnitude grows so a value reads cleanly at a glance.
function fmtDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Measure the host element's width (px) so the SVG renders at a 1:1 coordinate
// system — no viewBox scaling, so the stroke + dots stay crisp at any card width.
function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw != null) setW(cw);
    });
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const H = 72; // chart drawing height (px)
const PAD_X = 4;
const PAD_TOP = 6;
const PAD_BOTTOM = 6;

export function OpenDurationChart({
  points,
}: {
  points: InsightsTimePoint[];
}): JSX.Element {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const defined = points.filter((p) => p.avgOpenHours != null);
  // The header value: the hovered week if any, else the most recent week with data.
  const latest = [...defined].reverse()[0] ?? null;
  const shown = hover != null ? points[hover] : null;
  const headerRight =
    shown && shown.avgOpenHours != null
      ? `${fmtDate(shown.bucketStart)}: ${fmtDuration(shown.avgOpenHours)} · ${shown.count} PR${shown.count === 1 ? '' : 's'}`
      : shown
        ? `${fmtDate(shown.bucketStart)}: no PRs closed`
        : latest && latest.avgOpenHours != null
          ? `latest ${fmtDuration(latest.avgOpenHours)}`
          : '';

  const weeks = points.length;

  return (
    <div className="mt-2">
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
          Avg time a PR stays open · {weeks}-wk
        </span>
        <span className="truncate text-[10px] tabular-nums text-gray-500 dark:text-gray-400">
          {headerRight}
        </span>
      </div>

      {defined.length === 0 ? (
        <div
          ref={ref}
          className="flex items-center justify-center rounded-md border border-dashed border-gray-200 text-[10px] text-gray-400 dark:border-gray-800"
          style={{ height: H }}
        >
          No PRs merged/closed in the last {weeks} weeks
        </div>
      ) : (
        <div ref={ref} className="relative" style={{ height: H }}>
          {w > 0 && <Plot points={points} w={w} hover={hover} onHover={setHover} />}
        </div>
      )}

      {defined.length > 0 && (
        <div className="mt-0.5 flex justify-between text-[9px] text-gray-400">
          <span>{fmtDate(points[0]!.bucketStart)}</span>
          <span>{fmtDate(points[points.length - 1]!.bucketStart)}</span>
        </div>
      )}
    </div>
  );
}

function Plot({
  points,
  w,
  hover,
  onHover,
}: {
  points: InsightsTimePoint[];
  w: number;
  hover: number | null;
  onHover: (i: number | null) => void;
}): JSX.Element {
  const n = points.length;
  const innerW = Math.max(w - 2 * PAD_X, 1);
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const maxV = Math.max(1, ...points.map((p) => p.avgOpenHours ?? 0));
  const x = (i: number): number => PAD_X + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number): number => PAD_TOP + innerH * (1 - v / maxV);
  const baseY = PAD_TOP + innerH;

  // Defined points in order; the line bridges null weeks rather than breaking.
  const pts = points
    .map((p, i) => ({ p, i }))
    .filter((d) => d.p.avgOpenHours != null)
    .map((d) => [x(d.i), y(d.p.avgOpenHours!)] as const);

  const line = pts
    .map(([px, py], k) => `${k === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`)
    .join(' ');
  const area =
    pts.length > 0
      ? `M ${pts[0]![0].toFixed(1)} ${baseY.toFixed(1)} ` +
        pts.map(([px, py]) => `L ${px.toFixed(1)} ${py.toFixed(1)}`).join(' ') +
        ` L ${pts[pts.length - 1]![0].toFixed(1)} ${baseY.toFixed(1)} Z`
      : '';

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const ox = e.nativeEvent.offsetX;
    const i =
      n <= 1 ? 0 : Math.round(((ox - PAD_X) / innerW) * (n - 1));
    onHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <svg width={w} height={H} className="block">
      {/* baseline */}
      <line
        x1={PAD_X}
        y1={baseY}
        x2={w - PAD_X}
        y2={baseY}
        className="text-gray-200 dark:text-gray-700"
        stroke="currentColor"
        strokeWidth={1}
      />
      {area && <path d={area} fill="currentColor" className="text-blue-500/15 dark:text-blue-400/15" />}
      {line && (
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-blue-500 dark:text-blue-400"
        />
      )}
      {/* hover guide */}
      {hover != null && (
        <line
          x1={x(hover)}
          y1={PAD_TOP}
          x2={x(hover)}
          y2={baseY}
          className="text-blue-400/50 dark:text-blue-300/40"
          stroke="currentColor"
          strokeWidth={1}
        />
      )}
      {/* data dots (hovered one enlarged) */}
      {points.map((p, i) =>
        p.avgOpenHours == null ? null : (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.avgOpenHours)}
            r={hover === i ? 3 : 2}
            fill="currentColor"
            className="text-blue-500 dark:text-blue-400"
          />
        ),
      )}
      {/* transparent capture layer for hover */}
      <rect
        x={0}
        y={0}
        width={w}
        height={H}
        fill="transparent"
        onMouseMove={onMove}
        onMouseLeave={() => onHover(null)}
      />
    </svg>
  );
}
