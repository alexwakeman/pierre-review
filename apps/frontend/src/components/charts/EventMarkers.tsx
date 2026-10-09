import { useState, type ReactNode } from 'react';

// EVENT MARKERS for any chart with an x-axis: a vertical line through the plot at each event, and a
// head above the plot carrying the event's icon. First used by Chronology "Over time"; written to be
// reused by any chart that wants to say "this happened here".
//
// ⚠ TWO HALVES, ON PURPOSE. The LINES are SVG and live inside the chart's own <svg> (so they share
// its coordinate system and sit under the hover layer). The HEADS are real <button>s in an HTML row
// above the plot, so a marker reaches keyboard, touch and a screen reader — an SVG <g> with an
// onClick reaches none of them.
//
// ⚠ ONE INTERACTIVE RAIL PER STACK. When several charts share an x-axis, draw the lines on every
// chart but make only ONE rail interactive (`interactive`); the others are decorative copies, so a
// keyboard user tabs through each marker once, not once per chart.
//
// Several events in one slot are ONE stacked marker (the caller clusters them) with a count badge;
// its hover/focus box lists them. Text is 11px and wears grey tokens, never a series colour.

export interface ChartEventMarker {
  key: string;
  /** Px from the chart's left edge, in the chart's own coordinates. */
  x: number;
  /** Drawn dashed — e.g. a detected (inferred) event rather than a recorded one. */
  dashed?: boolean;
  /** The marker the reader picked: drawn heavier. */
  selected?: boolean;
  icon: ReactNode;
  /** Events in the cluster; a badge shows above 1. */
  count: number;
  /** Accessible name of the head. */
  label: string;
  /** One line per event, listed on hover and focus. */
  lines: string[];
  onSelect?: () => void;
}

/** The vertical lines, for inside a chart's <svg>. Decorative: the heads carry the meaning. */
export function EventMarkerLines({
  markers,
  top,
  bottom,
}: {
  markers: ChartEventMarker[];
  top: number;
  bottom: number;
}): JSX.Element {
  return (
    <g aria-hidden="true" className="decorative-mark">
      {markers.map((m) => (
        <line
          key={m.key}
          x1={m.x}
          x2={m.x}
          y1={top}
          y2={bottom}
          className={
            m.selected
              ? 'stroke-sky-600 dark:stroke-sky-400'
              : 'stroke-gray-400 dark:stroke-gray-500'
          }
          strokeWidth={m.selected ? 2 : 1}
          strokeDasharray={m.dashed ? '3 3' : undefined}
        />
      ))}
    </g>
  );
}

/** The marker heads, in a row the same width as the chart, placed directly above it. */
export function EventMarkerRail({
  markers,
  width,
  interactive = true,
}: {
  markers: ChartEventMarker[];
  width: number;
  interactive?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const tip = markers.find((m) => m.key === open);
  return (
    <div className="relative h-6" style={{ width }} aria-hidden={interactive ? undefined : true}>
      {markers.map((m) => {
        const cls = `absolute top-0 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border ${
          m.selected
            ? 'border-sky-600 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-950 dark:text-sky-300'
            : 'border-gray-300 bg-white text-gray-600 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300'
        } ${m.dashed ? 'border-dashed' : ''}`;
        const badge =
          m.count > 1 ? (
            <span className="absolute -right-1.5 -top-1 rounded-full bg-gray-700 px-1 text-[11px] leading-[13px] text-white dark:bg-gray-200 dark:text-gray-900">
              {m.count}
            </span>
          ) : null;
        if (!interactive) {
          return (
            <span key={m.key} className={cls} style={{ left: m.x }}>
              {m.icon}
              {badge}
            </span>
          );
        }
        return (
          <button
            key={m.key}
            type="button"
            className={`${cls} hover:border-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500`}
            style={{ left: m.x }}
            aria-label={m.label}
            aria-pressed={m.selected ? true : undefined}
            onMouseEnter={() => setOpen(m.key)}
            onMouseLeave={() => setOpen((k) => (k === m.key ? null : k))}
            onFocus={() => setOpen(m.key)}
            onBlur={() => setOpen((k) => (k === m.key ? null : k))}
            onClick={() => m.onSelect?.()}
          >
            {m.icon}
            {badge}
          </button>
        );
      })}
      {interactive && tip != null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-6 z-30 max-w-[280px] -translate-x-1/2 rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-[11px] leading-snug text-gray-700 shadow-md dark:border-gray-700 dark:bg-gray-900/95 dark:text-gray-200"
          style={{ left: Math.max(140, Math.min(tip.x, width - 140)) }}
        >
          {tip.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
