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
import { anchorToastPanel } from '../lib/toastAnchor.js';

// ── THE ONE HEADER TOAST STRIP ───────────────────────────────────────────────────────────────
//
// Every toast in the app renders as a HORIZONTAL CARD in the slim top bar (components/shell/
// TopBar.tsx; App.tsx mounts `<HeaderToastStrip>` exactly once). It replaced
// the bottom-right toast column; ⚠ never add an independent `fixed` toast element anywhere else,
// and never a second strip.
//
// Every card is the SAME card — one component, one set of rules:
//
//  • ONE LINE WHEN COLLAPSED, ALWAYS: icon · label · summary · [one on-line action] · [X]. The
//    words never wrap (`truncate`: nowrap + ellipsis); the full text is in the expanded panel and in
//    the toggle's accessible name. Every slot has the same width and height, so a card appearing,
//    changing or disappearing never moves the header's other controls, and the header itself has a
//    FIXED height (App.tsx) the strip fits inside. Many cards scroll the strip sideways.
//    ⚠ Below `sm` the words are `max-sm:sr-only`. NEVER `sr-only sm:not-sr-only`: `not-sr-only`
//    sets `white-space: normal` and `overflow: visible`, which beat `truncate` and wrapped a long
//    summary onto a second line inside the one-line card ("Merge when ready · 2 armed · 4 merged").
//  • IT EXPANDS ON CLICK (or Enter / Space on its focused toggle), NEVER ON HOVER OR FOCUS, and
//    only when it has more to show: detail (`children` / `footer`) or a line truncated sideways.
//    The expanded panel is ALWAYS laid out the same way — the card's line again (now wrapping, so
//    the full text shows), then the rows (`children`, built from `ToastList` / `ToastRow`), then
//    the `footer` — and the detail is MOUNTED ONLY WHILE EXPANDED, so nothing focusable hides
//    inside a clipped one-line card. The panel OVERLAYS THE PAGE (`position: fixed`) rather than
//    growing the header. Fixed, not absolute, because the strip is a horizontal scroller and a
//    scroller clips both axes. ⚠ IT ANCHORS AT THE CARD'S TOP-LEFT and grows right and down only
//    (`anchorToastPanel`, lib/toastAnchor.ts), shifting left only as far as the viewport's right
//    gutter demands. It closes on a second click on the card's line, on any press outside the
//    panel, on Escape, and on any scroll or resize (the measured rect is stale). The X and an
//    on-line action never toggle it.
//  • THE PANEL IS ITS OWN ONE SCROLLER, `overscroll-behavior: contain`. ⚠ A `position: fixed`
//    box's scroll parent is the VIEWPORT, not the pane under it: a wheel the panel could not use
//    chained straight to the root, and the root of this app never scrolls — so on macOS the
//    gesture became the root's ELASTIC OVERSCROLL. The whole app (header, rail, content) slid up
//    with a blank band at the bottom, and because a wheel gesture LATCHES to the scroller it began
//    on, wheeling "the page" afterwards kept rubber-banding the root instead of scrolling the
//    content. Rows therefore never carry their own `max-h-* overflow-auto` (a second scroller is a
//    second chain), and the strip is contained too, for a wheel over a collapsed card.
//  • ITS BORDER NAMES ITS SOURCE (`tone`): AI violet, the merge accent, the sync sky, the
//    Pending amber, the resolver's conflict red. Border only — the background stays neutral, and
//    the icon + label still say the same thing in words, so the colour is never the only signal.
//    A PROGRESS BAR wears the SAME tone: `HEADER_TOAST_TONE` is the one mapping for both.
//  • THE X IS THE TOAST'S OWN DISMISS — `onDismiss` absent means the toast is not dismissible
//    (an indicator, or one whose dismiss is gated, like a running AI fix) and gets no X.
//  • A PROGRESS BAR STAYS VISIBLE ON THE COLLAPSED LINE, along the line's bottom edge.
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
          className="flex min-w-0 items-center gap-2 overflow-x-auto overflow-y-hidden overscroll-contain [scrollbar-width:thin]"
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

/** A toast's source, as a colour. Each reuses the accent its home surface already wears. */
export type HeaderToastTone = 'neutral' | 'ai' | 'merge' | 'sync' | 'attention' | 'conflicts';

// THE ONE TONE MAPPING (the redesign's colour rule, docs/redesign/DESIGN.md § 3): a card is a
// toned surface with NO border. Its source shows only on the ICON and the PROGRESS FILL, and only
// where the colour means something: the AI family for a model's run, danger for conflicts (they
// block), the accent for the sync / merge machinery the reader set going, grey for the rest.
// Non-text colours on the fill; the icon colours are the measured `--ui-*` / `--ai-*` inks.
export const HEADER_TOAST_TONE: Record<HeaderToastTone, { mark: string; fill: string }> = {
  neutral: { mark: 'text-ui-mute', fill: 'bg-ui-faint' },
  ai: { mark: 'text-ai-signal', fill: 'bg-ai-signal-fill' },
  merge: { mark: 'text-ui-accent', fill: 'bg-ui-accent' },
  sync: { mark: 'text-ui-accent', fill: 'bg-ui-accent' },
  attention: { mark: 'text-ui-mute', fill: 'bg-ui-faint' },
  conflicts: { mark: 'text-ui-danger', fill: 'bg-ui-danger' },
};

interface HeaderToastProps {
  /** What the card is about, in a few words. Leads the line; names the card and its X. */
  label: string;
  /** A component from `Icons.tsx` at `size={13}`. Always visible, including at narrow widths. */
  icon: ReactNode;
  testId?: string;
  /** Extra classes on the slot (e.g. a fade-out opacity). */
  className?: string;
  /** Where the toast comes from — the card's BORDER and its progress fill. Default `neutral`. */
  tone?: HeaderToastTone;
  /** The rest of the one line, after the label. Plain words: it is truncated, never wrapped. */
  summary?: ReactNode;
  /** One compact control kept ON the line (Undo, Reopen) — an action hidden behind a hover is
   *  an action nobody finds. Use `ToastLineButton`. */
  action?: ReactNode;
  /** The toast's own dismiss. Absent = not dismissible, no X. */
  onDismiss?: () => void;
  /** The X's accessible name. Default "Dismiss <label>". */
  dismissLabel?: string;
  progress?: HeaderToastProgress | null;
  /** The rows shown when the card expands (`ToastList` + `ToastRow`, or a few `ToastRow`s). */
  children?: ReactNode;
  /** The expanded panel's last line: secondary actions ("Show 3 more", "Dismiss finished") and a
   *  short note. */
  footer?: ReactNode;
}

let nextId = 0;
function useToastId(): string {
  const ref = useRef<string | null>(null);
  if (ref.current == null) ref.current = `hdr-toast-${++nextId}`;
  return ref.current;
}

/**
 * The expand/collapse mechanics: the slot holds the place in the strip, the panel is the card, and
 * it lifts out to `position: fixed` while expanded. Opening is a CLICK on the card's line (the
 * toggle button inside it takes Enter / Space natively, and its click bubbles to the same handler).
 */
function useExpandable(hasDetail: boolean): {
  slotRef: React.RefObject<HTMLDivElement>;
  panelRef: React.RefObject<HTMLDivElement>;
  expanded: boolean;
  panelStyle: CSSProperties | undefined;
  toggle: () => void;
} {
  const id = useToastId();
  const ctx = useContext(ExpandedCtx);
  const [localOpen, setLocalOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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
    // "More to show": detail rows / a footer, or the line truncated sideways (its words are wider
    // than their box — which includes the `sr-only` words at a narrow width).
    let longer = hasDetail;
    if (!longer) {
      for (const el of Array.from(panel.querySelectorAll<HTMLElement>('[data-toast-line]'))) {
        if (el.scrollWidth > el.clientWidth + 1 || el.clientWidth <= 1) {
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

  const toggle = (): void => {
    if (expanded) collapse();
    else tryExpand();
  };

  // While open: a press OUTSIDE the panel closes it, and so does Escape wherever focus is. A
  // measured rect goes stale on any scroll (the strip, the page) or resize — collapse rather than
  // float in the wrong place. A scroll INSIDE the expanded panel is the reader reading (and, being
  // `overscroll-behavior: contain`, it never reaches the page).
  // `pointerdown`, not `click`: a press on another card's line closes this one before that card's
  // own click opens it, so the one-open-at-a-time rule never sees two.
  useEffect(() => {
    if (!expanded) return;
    const inside = (t: EventTarget | null): boolean =>
      panelRef.current != null && t instanceof Node && panelRef.current.contains(t);
    const onPointerDown = (e: PointerEvent): void => {
      if (!inside(e.target)) collapse();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        collapse();
      }
    };
    const onScroll = (e: Event): void => {
      if (inside(e.target)) return;
      collapse();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', collapse);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
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
    panelStyle = {
      position: 'fixed',
      ...anchorToastPanel(rect, window.innerWidth, window.innerHeight),
    };
  }

  return { slotRef, panelRef, expanded, panelStyle, toggle };
}

/** Stop a click on the X or an on-line action from reaching the line's toggle. */
function stop(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

// ONE slot size for every card: the words show from `sm` up; below it the icon, the action and the
// X (the words return on expand).
const SLOT = 'relative h-7 w-28 shrink-0 sm:w-56 lg:w-64 touch:h-10';
const PANEL_BASE = 'rounded-ui bg-ui-raise text-ui-ink';
const PANEL_COLLAPSED = 'absolute inset-0 overflow-hidden';
// ⚠ `overscroll-contain` is the scroll-bug fix, not polish — see the header comment.
// z-[60]: above a SidePanel sheet (z-50), which starts under the top bar.
const PANEL_EXPANDED = 'z-[60] overflow-y-auto overscroll-contain shadow-lg';
// The one inner divider every section of an expanded panel uses.
const SECTION = 'border-t border-ui-line/60';

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
  footer,
  testId,
  className = '',
  tone = 'neutral',
}: HeaderToastProps): JSX.Element {
  const hasDetail = children != null || footer != null;
  const { slotRef, panelRef, expanded, panelStyle, toggle } = useExpandable(hasDetail);
  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.value))) : 0;
  const colours = HEADER_TOAST_TONE[tone];
  return (
    <div ref={slotRef} data-testid={testId} className={`${SLOT} ${className}`}>
      <div
        ref={panelRef}
        role="group"
        aria-label={label}
        data-tone={tone}
        data-expanded={expanded ? 'true' : undefined}
        style={panelStyle}
        className={`${PANEL_BASE} ${expanded ? PANEL_EXPANDED : PANEL_COLLAPSED}`}
      >
        {/* THE LINE — the same in both states. It is the click target (icon, words, empty space);
            the button inside it (icon + words) is the keyboard stop and carries aria-expanded. Its own click
            bubbles here, so Enter / Space and a pointer take the one path. Collapsed, the words
            are one truncated line in exactly 26px; expanded, they wrap so the full text shows. */}
        <div
          className="relative flex min-h-[26px] cursor-pointer items-center gap-1.5 px-2 touch:min-h-10"
          onClick={toggle}
        >
          {/* The icon sits INSIDE the toggle, so below `sm` (words visually hidden) the keyboard
              stop still has a body to draw its focus ring around. */}
          <button
            type="button"
            data-toast-toggle
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 self-stretch items-center gap-1.5 rounded-ui text-left outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          >
            <span className={`flex h-[18px] shrink-0 items-center ${colours.mark}`}>
              {icon}
            </span>
            <span
              data-toast-line
              className={`block min-w-0 flex-1 text-meta leading-[18px] ${
                expanded ? 'whitespace-normal break-words py-1' : `truncate${summary == null ? ' max-sm:sr-only' : ''}`
              }`}
            >
              {/* Below `sm` a collapsed card with a summary shows the summary alone ("1 armed"), the
                  label staying in the accessible name; a card without one shows its icon only. */}
              <span className={`font-medium${expanded ? '' : ' max-sm:sr-only'}`}>{label}</span>
              {summary != null && (
                <span className="text-ui-mute">
                  <span className={expanded ? undefined : 'max-sm:sr-only'}> · </span>
                  {summary}
                </span>
              )}
            </span>
          </button>
          {action != null && (
            <span className="flex shrink-0 items-center" onClick={stop}>
              {action}
            </span>
          )}
          {onDismiss != null && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              aria-label={dismissLabel ?? `Dismiss ${label}`}
              title={dismissLabel ?? `Dismiss ${label}`}
              className="hit -mr-1 flex shrink-0 items-center rounded-ui p-0.5 text-ui-faint hover:bg-ui-hover hover:text-ui-ink"
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
              className="absolute inset-x-1 bottom-0 h-[3px] overflow-hidden rounded-[2px] bg-ui-hover"
            >
              <div
                className={`h-full rounded-[2px] ${colours.fill} motion-safe:transition-all motion-safe:duration-500`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
        {/* THE DETAIL — mounted only while expanded: rows, then the footer. */}
        {expanded && children != null && (
          <div className={`${SECTION} px-2 py-1 text-meta`}>{children}</div>
        )}
        {expanded && footer != null && (
          <div
            className={`${SECTION} flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-1.5 text-meta text-ui-mute`}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A card's rows, divided. Rows bleed to the panel's edges; the list is NEVER its own scroller
 * (no `max-h-* overflow-auto`) — the expanded panel is the one scroller (see the header comment).
 */
export function ToastList({ id, children }: { id?: string; children: ReactNode }): JSX.Element {
  return (
    <ul id={id} className="-mx-2 -my-1 divide-y divide-ui-line/60">
      {children}
    </ul>
  );
}

/** One row of a card: the same padding, type size and line layout on every card. */
export function ToastRow({ children }: { children: ReactNode }): JSX.Element {
  return <li className="px-2 py-1.5 text-meta leading-snug">{children}</li>;
}

/** The compact control kept on a card's line (Undo, Reopen) — one look for every card. */
export function ToastLineButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="hit whitespace-nowrap rounded-ui bg-ui-hover px-1.5 text-meta font-medium leading-[18px] text-ui-ink hover:brightness-110 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** A secondary action in a card's footer ("Dismiss finished"). */
export function ToastFooterButton({
  onClick,
  children,
  ...rest
}: {
  onClick: () => void;
  children: ReactNode;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
      className="hit rounded-ui text-meta font-medium text-ui-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
    >
      {children}
    </button>
  );
}

/**
 * The "N more" control under a card's capped list, for its FOOTER: it reveals every row inside the
 * expanded panel (which scrolls within its max height), then offers "Show fewer". It lives INSIDE
 * the panel, so clicking it keeps the card open and Escape still collapses the card.
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
    <ToastFooterButton onClick={onToggle} aria-expanded={showAll} aria-controls={controls}>
      {showAll ? 'Show fewer' : `Show ${hidden} more`}
    </ToastFooterButton>
  );
}
