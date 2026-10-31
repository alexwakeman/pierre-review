import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useInteractions,
} from '@floating-ui/react';
import { claimActivePopover } from '../../lib/activePopover.js';
import { usePlacedFloating } from '../ui/floating.js';

// EVENT MARKERS for any chart with an x-axis: a vertical line through the plot at each event, and a
// head above the plot carrying the event's icon. First used by Chronology "Over time"; written to be
// reused by any chart that wants to say "this happened here".
//
// ⚠ TWO HALVES, ON PURPOSE. The LINES are SVG and live inside the chart's own <svg> (so they share
// its coordinate system and sit under the hover layer). The HEADS are real <button>s in an HTML row
// above the plot, so a marker reaches keyboard, touch and a screen reader — an SVG <g> with an
// onClick reaches none of them.
//
// ⚠ ONE INTERACTIVE RAIL PER ACTION. When several charts share an x-axis, draw the lines on every
// chart; a rail is interactive only where its click does something of its own (`onSelect` on one,
// an explaining popover — `renderPopover` — on another). A rail that would only repeat another's
// action is a decorative copy (`interactive={false}`), so a keyboard user never tabs through the
// same action twice.
//
// ⚠ EVERY BOX FLOATS. The hover box and the click popover are portalled to <body> and placed
// `fixed` against the marker (flip + shift, `usePlacedFloating`, never `transform`): the charts sit
// in a sideways scroller on a phone, and an `absolute` box inside it was cut off by the scroller's
// edge and by the chart above it.
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
    // `pointer-events: none`: a line is drawn over the plot, and must never steal the hover from
    // the week or cell beneath it.
    <g aria-hidden="true" className="decorative-mark" pointerEvents="none">
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

/** The rail's height: the heads sit `HEAD_TOP` px down so a count badge (which pokes above its head)
 *  stays inside the rail and is never cut by the chart or heading above it. */
const HEAD_TOP = 6;

/** The marker heads, in a row the same width as the chart, placed directly above it. */
export function EventMarkerRail({
  markers,
  width,
  interactive = true,
  renderPopover,
  popoverTestId,
}: {
  markers: ChartEventMarker[];
  width: number;
  interactive?: boolean;
  /** A click opens this beside the marker (and a second click, Escape or a press elsewhere closes
   *  it) instead of calling `onSelect`. */
  renderPopover?: (marker: ChartEventMarker, close: () => void) => ReactNode;
  popoverTestId?: string;
}): JSX.Element {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const pinned = renderPopover != null ? markers.find((m) => m.key === pinnedKey) : undefined;
  const hovered = pinned == null ? markers.find((m) => m.key === hoverKey) : undefined;
  const active = pinned ?? hovered;
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Closing from inside the popover hands focus back to its marker, so a keyboard reader is not
  // left at the top of the page.
  const close = (): void => {
    const button = pinnedKey != null ? buttons.current.get(pinnedKey) : undefined;
    setPinnedKey(null);
    button?.focus();
  };

  const { refs, floatingStyles, context } = usePlacedFloating({
    open: interactive && active != null,
    onOpenChange: (next) => {
      if (!next) setPinnedKey(null);
    },
    strategy: 'fixed',
    placement: 'bottom',
    // On a phone the busiest week's popover can be taller than the room either side of the marker:
    // it then takes the larger side and scrolls inside itself, never past the screen's edge.
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, availableHeight)}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  // Escape is ours (captured below), so the global keyboard hook does not ALSO leave the page.
  const dismiss = useDismiss(context, { enabled: pinned != null, escapeKey: false });
  const { getFloatingProps } = useInteractions([dismiss]);

  useLayoutEffect(() => {
    refs.setReference(active != null ? (buttons.current.get(active.key) ?? null) : null);
  }, [active, refs]);

  // One popover open at a time across the page (lib/activePopover.ts).
  useEffect(() => {
    if (pinned == null) return;
    return claimActivePopover(() => setPinnedKey(null));
  }, [pinned]);

  useEffect(() => {
    if (pinned == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      const button = buttons.current.get(pinned.key);
      setPinnedKey(null);
      button?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pinned]);

  return (
    <div className="relative h-7" style={{ width }} aria-hidden={interactive ? undefined : true}>
      {markers.map((m) => {
        const cls = `absolute flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border ${
          m.selected || m.key === pinned?.key
            ? 'border-ui-accent bg-ui-sel text-ui-accent'
            : 'border-ui-line bg-ui-surface text-ui-mute'
        } ${m.dashed ? 'border-dashed' : ''}`;
        const badge =
          m.count > 1 ? (
            <span className="absolute -right-1.5 -top-1 rounded-full bg-ui-ink px-1 text-meta leading-[13px] text-ui-bg">
              {m.count}
            </span>
          ) : null;
        if (!interactive) {
          return (
            <span key={m.key} className={cls} style={{ left: m.x, top: HEAD_TOP }}>
              {m.icon}
              {badge}
            </span>
          );
        }
        return (
          <button
            key={m.key}
            ref={(el) => {
              if (el) buttons.current.set(m.key, el);
              else buttons.current.delete(m.key);
            }}
            type="button"
            data-marker={m.key}
            className={`${cls} hit cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent`}
            style={{ left: m.x, top: HEAD_TOP }}
            aria-label={m.label}
            aria-pressed={renderPopover == null && m.selected ? true : undefined}
            aria-expanded={renderPopover != null ? m.key === pinned?.key : undefined}
            aria-haspopup={renderPopover != null ? 'dialog' : undefined}
            onMouseEnter={() => setHoverKey(m.key)}
            onMouseLeave={() => setHoverKey((k) => (k === m.key ? null : k))}
            onFocus={() => setHoverKey(m.key)}
            onBlur={() => setHoverKey((k) => (k === m.key ? null : k))}
            onClick={() => {
              if (renderPopover != null) setPinnedKey((k) => (k === m.key ? null : m.key));
              else m.onSelect?.();
            }}
          >
            {m.icon}
            {badge}
          </button>
        );
      })}
      {interactive && pinned != null && renderPopover != null && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              role="dialog"
              aria-label={pinned.label}
              data-testid={popoverTestId}
              {...getFloatingProps()}
              className="z-[70] w-80 max-w-[92vw] overflow-y-auto overscroll-contain rounded-ui bg-ui-surface px-3 py-2.5 text-meta leading-snug text-ui-ink shadow-lg ring-1 ring-ui-line"
            >
              {renderPopover(pinned, close)}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
      {interactive && hovered != null && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            role="tooltip"
            className="pointer-events-none z-[70] max-w-[min(280px,92vw)] rounded-ui bg-ui-raise px-2 py-1 text-meta leading-snug text-ui-ink shadow-lg ring-1 ring-ui-line"
          >
            {hovered.lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
