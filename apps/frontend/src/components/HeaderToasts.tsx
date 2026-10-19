import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { CloseIcon } from './Icons.js';

// ── THE ONE HEADER TOAST STRIP ───────────────────────────────────────────────────────────────
//
// Every toast in the app renders as a HORIZONTAL CARD in the top header, between the wordmark
// and the right-hand controls (App.tsx mounts `<HeaderToastStrip>` exactly once). It replaced
// the bottom-right toast column; ⚠ never add an independent `fixed` toast element anywhere else,
// and never a second strip.
//
// The rules a card keeps:
//
//  • ONE LINE BY DEFAULT. The slot has a fixed width and height, so a card appearing, changing
//    or disappearing never moves the header's other controls; many cards scroll the strip
//    sideways.
//  • IT EXPANDS ON HOVER AND ON KEYBOARD FOCUS, only when its content is longer than the line,
//    and the expanded panel OVERLAYS THE PAGE (`position: fixed` at the slot's own rect) rather
//    than growing the header. Fixed, not absolute, because the strip is a horizontal scroller and
//    a scroller clips both axes. Any scroll or resize collapses it (the measured rect is stale).
//  • THE X IS THE TOAST'S OWN DISMISS — `onDismiss` absent means the toast is not dismissible
//    (an indicator, or one whose dismiss is gated, like a running AI fix) and gets no X.
//  • A PROGRESS BAR STAYS VISIBLE ON THE COLLAPSED LINE.
//  • THE STRIP IS THE POLITE LIVE REGION; cards are not. `aria-relevant="additions"` announces a
//    card (or a row inside one) appearing, never a percentage ticking in place.

const ExpandedCtx = createContext<{
  openId: string | null;
  setOpenId: (id: string | null) => void;
} | null>(null);

export function HeaderToastStrip({ children }: { children: ReactNode }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <ExpandedCtx.Provider value={{ openId, setOpenId }}>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions"
        aria-label="Notifications"
        className="min-w-0 flex-1"
      >
        <div
          data-testid="header-toast-strip"
          className="flex min-w-0 items-center gap-2 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
        >
          {children}
        </div>
      </div>
    </ExpandedCtx.Provider>
  );
}

export interface HeaderToastProgress {
  /** 0–100. */
  value: number;
  /** Names the bar for assistive tech ("Loading data"). */
  label: string;
}

interface CommonProps {
  /** What the card is about, in a few words. Leads the line; names the card and its X. */
  label: string;
  /** A component from `Icons.tsx`. Always visible, including at narrow widths. */
  icon: ReactNode;
  testId?: string;
  /** Extra classes on the slot (e.g. a fade-out opacity). */
  className?: string;
}

interface HeaderToastProps extends CommonProps {
  /** The rest of the one line, after the label. */
  summary?: ReactNode;
  /** One compact control kept ON the line (Undo, Reopen) — an action hidden behind a hover is
   *  an action nobody finds. */
  action?: ReactNode;
  /** The toast's own dismiss. Absent = not dismissible, no X. */
  onDismiss?: () => void;
  /** The X's accessible name. Default "Dismiss <label>". */
  dismissLabel?: string;
  progress?: HeaderToastProgress | null;
  /** Detail shown when the card expands. */
  children?: ReactNode;
}

let nextId = 0;
function useToastId(): string {
  const ref = useRef<string | null>(null);
  if (ref.current == null) ref.current = `hdr-toast-${++nextId}`;
  return ref.current;
}

const PANEL_MIN_W = 320;
const GUTTER = 8;

/**
 * The expand/collapse mechanics shared by both card shapes: the slot holds the place in the strip,
 * the panel is the card, and it lifts out to `position: fixed` while expanded.
 */
function useExpandable(): {
  slotRef: React.RefObject<HTMLDivElement>;
  panelRef: React.RefObject<HTMLDivElement>;
  expanded: boolean;
  panelStyle: CSSProperties | undefined;
  handlers: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: (e: React.FocusEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
} {
  const id = useToastId();
  const ctx = useContext(ExpandedCtx);
  const [localOpen, setLocalOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);

  // Only one card is expanded at a time across the strip.
  const expanded = localOpen && rect != null && (ctx == null || ctx.openId === id);

  const collapse = useCallback(() => {
    setLocalOpen(false);
    setRect(null);
    if (ctx && ctx.openId === id) ctx.setOpenId(null);
  }, [ctx, id]);

  const tryExpand = (): void => {
    const slot = slotRef.current;
    const panel = panelRef.current;
    if (!slot || !panel) return;
    // "Longer than its line": vertical overflow (detail rows), or a line truncated sideways
    // (any element inside with scrollWidth > clientWidth), or text hidden at a narrow width.
    let longer = panel.scrollHeight > slot.clientHeight + 1;
    if (!longer) {
      for (const el of Array.from(panel.querySelectorAll<HTMLElement>('[data-toast-line]'))) {
        if (el.scrollWidth > el.clientWidth + 1 || el.clientWidth === 0) {
          longer = true;
          break;
        }
      }
    }
    if (!longer) return;
    setRect(slot.getBoundingClientRect());
    setLocalOpen(true);
    ctx?.setOpenId(id);
  };

  // A measured rect goes stale on any scroll (the strip, the page) or resize — collapse rather
  // than float in the wrong place. A scroll INSIDE the expanded panel is the reader reading.
  useEffect(() => {
    if (!expanded) return;
    const onScroll = (e: Event): void => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      collapse();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', collapse);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', collapse);
    };
  }, [expanded, collapse]);

  // Another card took the expansion: forget ours.
  useLayoutEffect(() => {
    if (localOpen && ctx && ctx.openId !== id) {
      setLocalOpen(false);
      setRect(null);
    }
  }, [ctx, ctx?.openId, id, localOpen]);

  let panelStyle: CSSProperties | undefined;
  if (expanded && rect) {
    const vw = window.innerWidth;
    const width = Math.min(Math.max(rect.width, PANEL_MIN_W), vw - GUTTER * 2);
    // Grow LEFTWARDS from the slot's right edge: the X (and an action) sit at the right of the line,
    // so a card that widened to the right moved them out from under the pointer that opened it, and
    // the click meant for the X landed on nothing.
    const left = Math.max(GUTTER, Math.min(rect.right - width, vw - width - GUTTER));
    panelStyle = {
      position: 'fixed',
      top: rect.top,
      left,
      width,
      maxHeight: Math.max(120, window.innerHeight - rect.top - GUTTER),
    };
  }

  return {
    slotRef,
    panelRef,
    expanded,
    panelStyle,
    handlers: {
      onMouseEnter: () => {
        hoverRef.current = true;
        tryExpand();
      },
      onMouseLeave: () => {
        hoverRef.current = false;
        if (!focusRef.current) collapse();
      },
      onFocus: () => {
        focusRef.current = true;
        if (!expanded) tryExpand();
      },
      onBlur: (e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && panelRef.current?.contains(next)) return;
        focusRef.current = false;
        if (!hoverRef.current) collapse();
      },
      onKeyDown: (e) => {
        if (e.key === 'Escape' && expanded) {
          e.stopPropagation();
          collapse();
        }
      },
    },
  };
}

const SLOT =
  'relative h-7 shrink-0 sm:w-56 lg:w-64';
const PANEL_BASE =
  'rounded-md border border-gray-200 bg-white text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';
const PANEL_COLLAPSED = 'absolute inset-0 overflow-hidden';
const PANEL_EXPANDED = 'z-50 overflow-y-auto shadow-lg';

/** A toast card. */
export function HeaderToast({
  label,
  icon,
  summary,
  action,
  onDismiss,
  dismissLabel,
  progress,
  children,
  testId,
  className = '',
}: HeaderToastProps): JSX.Element {
  const { slotRef, panelRef, expanded, panelStyle, handlers } = useExpandable();
  // Narrow widths: the icon (and the X, and an action) only; the line's words return on expand.
  const narrowW = onDismiss != null || action != null ? 'w-[4.5rem]' : 'w-10';
  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.value))) : 0;
  return (
    <div
      ref={slotRef}
      data-testid={testId}
      className={`${SLOT} ${action != null ? 'w-24' : narrowW} ${className}`}
    >
      <div
        ref={panelRef}
        role="group"
        aria-label={label}
        tabIndex={0}
        style={panelStyle}
        className={`${PANEL_BASE} ${expanded ? PANEL_EXPANDED : PANEL_COLLAPSED}`}
        {...handlers}
      >
        <div className="relative flex h-[26px] items-center gap-1.5 px-2">
          <span className="flex shrink-0 items-center text-gray-600 dark:text-gray-300">{icon}</span>
          <span
            data-toast-line
            className={`${expanded ? 'block' : 'hidden sm:block'} min-w-0 flex-1 truncate text-[12px]`}
          >
            <span className="font-semibold">{label}</span>
            {summary != null && (
              <span className="text-gray-600 dark:text-gray-300"> · {summary}</span>
            )}
          </span>
          {!expanded && <span className="flex-1 sm:hidden" aria-hidden />}
          {action != null && <span className="shrink-0">{action}</span>}
          {onDismiss != null && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={dismissLabel ?? `Dismiss ${label}`}
              title={dismissLabel ?? `Dismiss ${label}`}
              className="-mr-1 shrink-0 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            >
              <CloseIcon size={12} />
            </button>
          )}
          {progress != null && (
            <div
              role="progressbar"
              aria-label={progress.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="absolute inset-x-1 bottom-0 h-[3px] overflow-hidden rounded bg-gray-200 dark:bg-gray-800"
            >
              <div
                className="h-full rounded bg-yellow-500 transition-all duration-500 dark:bg-yellow-400"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
        {children != null && (
          <div className="border-t border-gray-100 px-2 pb-2 pt-1.5 text-[12px] dark:border-gray-800">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * The "N more" line under a card's capped list, as a control: it reveals every row inside the
 * expanded panel (which scrolls within its max height), then offers "Show fewer". It lives INSIDE
 * the panel, so focusing it keeps the card open and Escape still collapses the card.
 */
export function ToastShowMore({
  hidden,
  showAll,
  onToggle,
  controls,
}: {
  /** Rows the cap hides (0 when nothing is hidden). */
  hidden: number;
  showAll: boolean;
  onToggle: () => void;
  /** The id of the list this control expands. */
  controls?: string;
}): JSX.Element | null {
  if (!showAll && hidden <= 0) return null;
  return (
    <div className="border-t border-gray-100 pt-1 dark:border-gray-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={showAll}
        aria-controls={controls}
        className="rounded text-[11px] font-medium text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300"
      >
        {showAll ? 'Show fewer' : `Show ${hidden} more`}
      </button>
    </div>
  );
}
