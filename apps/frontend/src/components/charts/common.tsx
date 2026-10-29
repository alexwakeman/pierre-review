import { useCallback, useEffect, useRef, useState } from 'react';

// Shared foundation for the zero-dependency SVG charts used by the Insights
// drill-down panel. Conventions: data marks use explicit palette hexes (which read
// on both light + dark, like the timeline's inline-SVG glyphs); axes / gridlines /
// labels use Tailwind `text-*` classes via currentColor so they track the theme.

// Measure the host element's width (px) so SVGs render at a 1:1 coordinate system —
// crisp strokes/dots at any panel width, no viewBox scaling.
/**
 * The width of the element `ref` is attached to, kept current by a ResizeObserver.
 *
 * ⚠ A CALLBACK REF, NOT A RefObject: the observer attaches whenever the element MOUNTS. A
 * mount-only effect over `useRef` saw `null` when the chart's container rendered after a loading
 * state (Story health printed "Loading…" first), never re-ran, and left the width at 0 — so the
 * chart drew nothing, with no error.
 */
export function useChartWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw != null) setW(cw);
    });
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [el]);
  return [ref, w];
}

// App-aligned categorical palette (timeline marker hues + a few extensions).
export const PALETTE = {
  // One hex per hue that reads on BOTH themes' surfaces (#F7F7F8 / #131417). The categorical
  // order in SERIES_COLORS was run through the dataviz palette validator in both modes (CVD and
  // normal-vision separation pass; teal and amber sit just under 3:1 on the light surface, so
  // every chart carrying them keeps its legend and hover values).
  blue: '#3381e0',
  green: '#1a8f1a',
  gray: '#8b909a',
  orange: '#e2612d',
  amber: '#c48200',
  purple: '#7a6ae0',
  indigo: '#5b6be0',
  red: '#e45858',
  teal: '#1aa676',
  pink: '#df6693',
  slate: '#6b7280',
  violet: '#9085e9',
} as const;

// The colour for an anomaly marker (a divergence from a bot's own typical) — shared so the
// LineChart rings and the coverage-strip silent-run highlight read as the same signal.
export const ANOMALY_RING = PALETTE.red;

// A rotating set for series whose count isn't fixed (e.g. reviewers).
export const SERIES_COLORS = [
  PALETTE.blue,
  PALETTE.orange,
  PALETTE.teal,
  PALETTE.amber,
  PALETTE.pink,
  PALETTE.green,
  PALETTE.purple,
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
  /** `shape: 'hollow-square'` draws an outlined swatch, for a series whose mark is a hollow square. */
  series: { label: string; color: string; shape?: 'hollow-square' }[];
}): JSX.Element {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
      {series.map((s) => (
        <span key={s.label} className="flex items-center gap-1 text-meta text-ui-mute">
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={s.shape === 'hollow-square' ? { border: `1.5px solid ${s.color}` } : { background: s.color }}
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
      } whitespace-nowrap rounded-ui bg-ui-raise px-2 py-1 text-meta leading-tight text-ui-ink shadow-lg ring-1 ring-ui-line`}
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
  info,
  className,
  testId,
  children,
}: {
  title: string;
  note?: string;
  /** The card's explanation: an `<InfoButton>`, rendered straight after the title. */
  info?: React.ReactNode;
  /** Optional hook for the landing-screenshot capture, which crops one card at a time. */
  testId?: string;
  // Extra classes on the card's own box — for a card that has to place itself in its host's grid
  // (e.g. a full-width `lg:col-span-3` card sharing a `lg:grid-cols-3` row with three narrow
  // ones). Layout only: the chrome above is not overridable, so every card still reads the same.
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`min-w-0 rounded-ui bg-ui-surface p-3 sm:p-4${className ? ` ${className}` : ''}`}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <div className="flex min-w-0 items-baseline gap-1">
          <h4 className="text-body font-medium text-ui-ink">{title}</h4>
          {info}
        </div>
        {note && <span className="text-meta text-ui-faint">{note}</span>}
      </div>
      {children}
    </div>
  );
}

// Shared empty-state body for a chart with no data in the window.
export function ChartEmpty({ label = 'No data in this window' }: { label?: string }): JSX.Element {
  return (
    <div className="flex h-[120px] items-center justify-center rounded-ui bg-ui-raise px-3 text-center text-meta text-ui-mute">
      {label}
    </div>
  );
}
