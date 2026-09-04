import { useEffect, useRef, useState } from 'react';

// Shared foundation for the zero-dependency SVG charts used by the Insights
// drill-down panel. Conventions: data marks use explicit palette hexes (which read
// on both light + dark, like the timeline's inline-SVG glyphs); axes / gridlines /
// labels use Tailwind `text-*` classes via currentColor so they track the theme.

// Measure the host element's width (px) so SVGs render at a 1:1 coordinate system —
// crisp strokes/dots at any panel width, no viewBox scaling.
export function useChartWidth(): [React.RefObject<HTMLDivElement>, number] {
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

// App-aligned categorical palette (timeline marker hues + a few extensions).
export const PALETTE = {
  blue: '#3b82f6',
  green: '#22c55e',
  gray: '#9ca3af',
  orange: '#f97316',
  amber: '#f59e0b',
  purple: '#8957e5',
  indigo: '#6366f1',
  red: '#ef4444',
  teal: '#14b8a6',
  pink: '#ec4899',
  slate: '#64748b',
  violet: '#a78bfa',
} as const;

// The colour for an anomaly marker (a divergence from a bot's own typical) — shared so the
// LineChart rings and the coverage-strip silent-run highlight read as the same signal.
export const ANOMALY_RING = PALETTE.red;

// A rotating set for series whose count isn't fixed (e.g. reviewers).
export const SERIES_COLORS = [
  PALETTE.blue,
  PALETTE.green,
  PALETTE.amber,
  PALETTE.purple,
  PALETTE.teal,
  PALETTE.pink,
  PALETTE.slate,
];

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  // Optional per-index colour override (BarChart only): when set, bar i uses colors[i]
  // instead of `color` — e.g. a single "acted-on %" series whose bars are tinted by each
  // bot's keep/tune/noisy verdict. Falls back to `color` where an entry is null/absent.
  colors?: (string | null)[];
  // Optional per-index anomaly flag (LineChart): when true, point i is ringed as an outlier
  // (the bot diverged from its own typical that week). Aligned 1:1 with `values`.
  pointFlags?: (boolean | null)[];
  // Optional per-index exception detail (LineChart): a short human explanation of the ringed
  // point (observed vs typical, direction). Non-null only where pointFlags[i] is true; surfaced
  // in the hover tooltip so the anomaly circle explains itself. Aligned 1:1 with `values`.
  pointNotes?: (string | null)[];
  // Render this series as a dashed line with NO point dots (LineChart) — for a fitted/derived
  // overlay like a line-of-best-fit trend, visually distinct from the real data series.
  dashed?: boolean;
}

// Hours → compact human duration (m / h / d), precision shrinking with magnitude.
export function fmtDuration(hours: number): string {
  if (hours <= 0) return '0h';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Compact integer (1234 → "1.2k").
export function fmtNum(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

// A "nice" axis maximum at or above v (1/2/5 × 10ⁿ) so gridlines land on round
// numbers. Returns 1 for non-positive input.
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

// A small swatch + label legend row, shared by every multi-series chart.
export function Legend({
  series,
}: {
  series: { label: string; color: string }[];
}): JSX.Element {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
      {series.map((s) => (
        <span key={s.label} className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ background: s.color }}
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// A floating tooltip pinned within the chart's relative wrapper. Default: follows `x` (clamped so
// the box stays inside the chart) and sits just above `y`. `centered`: ignores `x` and pins the
// box to the chart's horizontal centre, growing DOWNWARD from the top — so a wide/tall tooltip
// never spills past the left/right edges (into a neighbouring panel) or above into the header.
// pointer-events:none throughout.
export function FloatingTip({
  x,
  y,
  width,
  children,
  centered = false,
}: {
  x: number;
  y: number;
  width: number;
  children: React.ReactNode;
  centered?: boolean;
}): JSX.Element {
  const clampedX = centered
    ? width / 2
    : Math.max(58, Math.min(x, Math.max(58, width - 58)));
  return (
    <div
      className={`pointer-events-none absolute z-20 -translate-x-1/2 ${
        centered ? '' : '-translate-y-full'
      } whitespace-nowrap rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-[10px] leading-tight text-gray-700 shadow-md dark:border-gray-700 dark:bg-gray-900/95 dark:text-gray-200`}
      style={{ left: clampedX, top: centered ? 2 : Math.max(y - 6, 0) }}
    >
      {children}
    </div>
  );
}

// A titled chart card: heading (+ optional right-aligned note) over the body.
export function ChartCard({
  title,
  note,
  className,
  children,
}: {
  title: string;
  note?: string;
  // Extra classes on the card's own box — for a card that has to place itself in its host's grid
  // (e.g. a full-width `lg:col-span-3` card sharing a `lg:grid-cols-3` row with three narrow
  // ones). Layout only: the chrome above is not overridable, so every card still reads the same.
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={`rounded-lg border border-gray-200 p-3 dark:border-gray-800${
        className ? ` ${className}` : ''
      }`}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">{title}</h4>
        {note && <span className="text-[10px] text-gray-400">{note}</span>}
      </div>
      {children}
    </div>
  );
}

// Shared empty-state body for a chart with no data in the window.
export function ChartEmpty({ label = 'No data in this window' }: { label?: string }): JSX.Element {
  return (
    <div className="flex h-[120px] items-center justify-center rounded-md border border-dashed border-gray-200 text-[10px] text-gray-400 dark:border-gray-800">
      {label}
    </div>
  );
}
