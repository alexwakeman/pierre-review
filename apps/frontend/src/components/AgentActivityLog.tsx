// THE AGENT'S LIVE LOG — one component for every agentic run's rolling log (AI Review, AI Fix and its
// plan, the story build's plan and build). docs/FRONTEND.md § The agent's live log.
//
// Collapsed: a short box under the run's status line that follows the newest line. "Expand" makes it
// tall (most of the scroll pane's height):
//   - in a two-column rail layout's RAIL (the AI Review tab's run block) it widens LEFTWARDS over the
//     reading column — <RailWideLeft>, the mirror of the design diagram's <RailWide>;
//   - elsewhere it grows in place and reaches the pane's right edge (<PaneWide>).
// "Collapse" or Escape puts it back. Expanded or not it keeps streaming and follows the newest line,
// unless the reader has scrolled up; scrolling back to the bottom resumes following.
//
// The server sends only the run's last lines (a rolling window); the panel keeps every line it has seen
// since it mounted (lib/agentActivityLog.ts `mergeActivityWindow`), so the expanded log holds more.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { expandedLogHeight, isScrolledToBottom, mergeActivityWindow } from '../lib/agentActivityLog.js';
import { onEscapeFirst, PaneWide, RailWideLeft, useRailWideControl, WideToggleButton } from './RailLayout.js';

/** The widest the log grows over the reading column (a log line wants more than a card's measure). */
const LOG_LEFT_MAX_PX = 1100;

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface AgentActivityLogProps {
  /** The server's latest window of the run's log, newest last. */
  lines: readonly string[] | null | undefined;
  /** The run these lines belong to: a new key starts a fresh log. */
  runKey?: string | number | null;
  /** The box's paint: `surface` on the page, `raise` inside a card that is already a surface. */
  tone?: 'surface' | 'raise';
  className?: string;
}

/** Every line seen since mount (or since `runKey` changed), merged from the server's rolling windows. */
function useHeldLines(lines: readonly string[], runKey: string | number | null): readonly string[] {
  const [state, setState] = useState<{ key: string | number | null; held: readonly string[] }>(() => ({ key: runKey, held: lines }));
  const base = state.key === runKey ? state.held : [];
  const held = mergeActivityWindow(base, lines);
  // Derived state, updated during render (React re-renders at once). Only on a real change, so a fresh
  // `[]` from the caller on every render never loops.
  if (held !== state.held || state.key !== runKey) setState({ key: runKey, held });
  return held;
}

/** The expanded log's height while `active` (null otherwise): fitted to the scroll pane it sits in. */
function useExpandedHeight(el: HTMLElement | null, active: boolean): number | null {
  const [h, setH] = useState<number | null>(null);
  useIsoLayoutEffect(() => {
    if (!active || el == null) {
      setH(null);
      return;
    }
    let pane: HTMLElement | null = null;
    for (let node = el.parentElement; node != null; node = node.parentElement) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === 'auto' || oy === 'scroll') {
        pane = node;
        break;
      }
    }
    const host = pane;
    const read = (): void => {
      const paneTop = host != null ? host.getBoundingClientRect().top : 0;
      const paneHeight = host != null ? host.clientHeight : window.innerHeight;
      const next = expandedLogHeight(paneHeight, paneTop + paneHeight - el.getBoundingClientRect().top);
      setH((prev) => (prev === next ? prev : next));
    };
    read();
    if (host == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(host);
    return () => ro.disconnect();
    // Read once per expand (and on a pane resize): the log's own growth must not feed back.
  }, [el, active]);
  return h;
}

export function AgentActivityLog({ lines, runKey = null, tone = 'surface', className = 'mt-2' }: AgentActivityLogProps): JSX.Element | null {
  const held = useHeldLines(lines ?? EMPTY, runKey);
  if (held.length === 0) return null;
  const bg = tone === 'raise' ? 'bg-ui-raise' : 'bg-ui-surface';
  return (
    <RailWideLeft className={`relative rounded-ui ${bg} ${className}`} maxPx={LOG_LEFT_MAX_PX}>
      <LogBox lines={held} bg={bg} />
    </RailWideLeft>
  );
}

const EMPTY: readonly string[] = [];

function LogBox({ lines, bg }: { lines: readonly string[]; bg: string }): JSX.Element {
  // In the rail, the enclosing <RailWideLeft> owns the state (and Escape); elsewhere this box does.
  const rail = useRailWideControl();
  const [ownExpanded, setOwnExpanded] = useState(false);
  const expanded = rail != null ? rail.expanded : ownExpanded;
  const toggle = rail != null ? rail.toggle : () => setOwnExpanded((v) => !v);

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useEffect(
    () => (rail == null && ownExpanded ? onEscapeFirst(() => setOwnExpanded(false), scroller) : undefined),
    [rail, ownExpanded, scroller],
  );
  const height = useExpandedHeight(scroller, expanded);
  // Follow the newest line unless the reader scrolled up; back at the bottom, follow again.
  const following = useRef(true);
  useIsoLayoutEffect(() => {
    if (scroller != null && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [scroller, lines, expanded, height]);

  const style: CSSProperties | undefined = expanded ? { height: height ?? undefined } : undefined;
  // In the rail the enclosing <RailWideLeft> widens it (and paints its shadow); elsewhere, expanded, it
  // reaches the pane's edge. The same elements either way, so the scroll position survives the toggle.
  return (
    <PaneWide enabled={rail == null && expanded}>
      <div className={`rounded-ui ${bg}${rail == null && expanded ? ' shadow-lg ring-1 ring-ui-line' : ''}`}>
        <div className="flex justify-end px-1 pt-1">
          <WideToggleButton
            expanded={expanded}
            onToggle={toggle}
            expandTitle={rail != null ? 'Show over the main column' : 'Show more of the log'}
            collapseTitle="Back to the short log (Esc)"
          />
        </div>
        <div
          ref={setScroller}
          role="log"
          aria-live="off"
          aria-label="Live activity"
          tabIndex={0}
          data-testid="agent-activity-log"
          data-expanded={expanded ? 'true' : 'false'}
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current = isScrolledToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
          }}
          className={`${expanded ? (height == null ? 'h-[70vh] ' : '') : 'max-h-28 '}overflow-y-auto rounded-ui px-2 pb-1.5 font-mono text-meta leading-snug text-ui-mute focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent`}
          style={style}
        >
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {l === '' ? ' ' : l}
            </div>
          ))}
        </div>
      </div>
    </PaneWide>
  );
}
