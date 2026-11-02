import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './Icons.js';
import { anchorClusterPanel, toastRank, type ToastPanelBox } from '../lib/toastAnchor.js';
import { claimActivePopover } from '../lib/activePopover.js';

// ── THE ONE HEADER TOAST CLUSTER ─────────────────────────────────────────────────────────────
//
// Every toast in the app is ONE CIRCLE in a cluster at the top right (the slim TopBar, or the page
// header's toast seat at ≥ lg; App.tsx mounts `<HeaderToastStrip>` exactly once). ⚠ Never add an
// independent `fixed` toast element anywhere else, and never a second strip or cluster.
//
//  • ONE CIRCLE PER JOB TYPE that is active now (sync, merge when ready, AI reviews, AI fixes, the
//    AI budget pause, dependency results, the resolver reopen, Undo). Each circle is the job's icon,
//    a PROGRESS RING when the job has a known fraction, a COUNT BADGE when it has a count, and a red
//    ring + dot when it needs attention (`alert`). The circles OVERLAP like an avatar stack; the most
//    urgent, then the newest, sits furthest right and on top (`toastRank`). Each circle carries its
//    words for assistive tech (`sr-only`) and a tooltip.
//  • THE CLUSTER IS ONE BUTTON (`aria-expanded`). A click EXPANDS it into ONE PANEL anchored to the
//    cluster's right edge that grows LEFTWARDS as far as its content needs, never past the main
//    content's left edge (`anchorClusterPanel`, lib/toastAnchor.ts; `[data-shell-main]` in App.tsx);
//    past that the panel scrolls (its scroll bar on the right). The panel OVERLAYS the page
//    (`position: fixed`, `z-[60]`: above a SidePanel sheet, below the resolver and modals). It lists
//    every job's full content, in the circles' order (right-most first): the job's line (icon, label,
//    summary, its one on-line action, its X), its progress bar, its rows, its footer.
//  • It closes on a second click on the cluster, on any press outside the panel and the cluster, on
//    Escape (focus returns to the cluster), and on a resize or an outside scroll (the measured rect
//    is stale). Opening moves focus into the panel. The open animation unfolds it from the right and
//    is `motion-safe` only.
//  • THE TOP BAR NEVER SHIFTS: the cluster is 28px tall inside the fixed `h-11` bar, and an empty
//    cluster is `hidden`, not unmounted (the circles portal into it).
//  • THE PANEL IS ITS OWN ONE SCROLLER, `overscroll-behavior: contain`. ⚠ A `position: fixed`
//    box's scroll parent is the VIEWPORT: a wheel the panel could not use chained to the root, and
//    on macOS that became the root's ELASTIC OVERSCROLL (the whole shell slid up). Rows therefore
//    never carry their own `max-h-* overflow-auto` (a second scroller is a second chain).
//  • THE CLUSTER IS THE POLITE LIVE REGION; the panel is not. `aria-relevant="additions"` announces
//    a circle appearing (its sr-only words), never a percentage ticking in place.
//
// Each job is still its own component with its own state (App.tsx); `HeaderToast` PORTALS its circle
// into the cluster and, while the panel is open, its section into the panel. The detail is MOUNTED
// ONLY WHILE OPEN.

interface ClusterCtx {
  circleHost: HTMLElement | null;
  /** The expanded panel's section list. */
  listHost: HTMLElement | null;
  expanded: boolean;
  setLabel: (id: string, label: string | null) => void;
}

const Ctx = createContext<ClusterCtx | null>(null);

/** The main content's left edge (the docked sidebar's right edge; 0 when the sidebar is a drawer). */
function contentLeft(): number {
  const main = document.querySelector<HTMLElement>('[data-shell-main]');
  return main != null ? main.getBoundingClientRect().left : 0;
}

export function HeaderToastStrip({ children }: { children: ReactNode }): JSX.Element {
  const [circleHost, setCircleHost] = useState<HTMLSpanElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const [listHost, setListHost] = useState<HTMLDivElement | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [box, setBox] = useState<ToastPanelBox | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const expanded = box != null;
  const names = Object.values(labels);
  const count = names.length;

  const setLabel = useCallback((id: string, label: string | null) => {
    setLabels((prev) => {
      if (label == null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if (prev[id] === label) return prev;
      return { ...prev, [id]: label };
    });
  }, []);

  const collapse = useCallback((refocus: boolean) => {
    setBox(null);
    if (refocus) buttonRef.current?.focus();
  }, []);

  const toggle = (): void => {
    if (expanded) {
      collapse(false);
      return;
    }
    const b = buttonRef.current;
    if (b == null) return;
    const r = b.getBoundingClientRect();
    setBox(anchorClusterPanel(r, contentLeft(), window.innerWidth, window.innerHeight));
  };

  // ⚠ A NATIVE click listener, not `onClick`: the circles are PORTALLED into this button, and a
  // React event bubbles through the React tree (the job's component), never through the DOM parent
  // it was portalled into — so a click on a circle never reached a React `onClick` here.
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const b = buttonRef.current;
    if (b == null) return;
    const onClick = (): void => toggleRef.current();
    b.addEventListener('click', onClick);
    return () => b.removeEventListener('click', onClick);
  }, []);

  // Nothing left to show: close.
  useEffect(() => {
    if (expanded && count === 0) collapse(false);
  }, [expanded, count, collapse]);

  // Opening moves focus into the panel (after the sections have portalled in).
  useEffect(() => {
    if (expanded) panelHost?.focus({ preventScroll: true });
  }, [expanded, panelHost]);

  useEffect(() => {
    if (!expanded) return;
    const inside = (t: EventTarget | null): boolean =>
      t instanceof Node &&
      ((panelHost != null && panelHost.contains(t)) ||
        (buttonRef.current != null && buttonRef.current.contains(t)));
    // `pointerdown`, capture: a press anywhere else closes the panel; a press on the cluster is
    // left to its own click (which toggles).
    const onPointerDown = (e: PointerEvent): void => {
      if (!inside(e.target)) collapse(false);
    };
    // ⚠ The panel HOLDS THE ONE POPOVER SLOT (lib/activePopover.ts) and takes Escape in the CAPTURE
    // phase on window, stopped — as every layer above the page does. A bubble-phase listener ran
    // after a drawer's capture-phase Escape (the drawer closed, the panel stayed), and the slot is
    // what makes the page's single-letter shortcuts stand down while the reader is in the panel.
    const release = claimActivePopover(() => collapse(false));
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        collapse(true);
      }
    };
    const onScroll = (e: Event): void => {
      if (panelHost != null && e.target instanceof Node && panelHost.contains(e.target)) return;
      collapse(false);
    };
    const onResize = (): void => collapse(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      release();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [expanded, collapse, panelHost]);

  const panelStyle: CSSProperties | undefined =
    box != null
      ? {
          position: 'fixed',
          top: box.top,
          right: box.right,
          minWidth: box.minWidth,
          maxWidth: box.maxWidth,
          maxHeight: box.maxHeight,
        }
      : undefined;

  const name =
    count === 0 ? 'Notifications' : `Notifications: ${names.join(', ')}`;

  return (
    <Ctx.Provider value={{ circleHost, listHost, expanded, setLabel }}>
      <div className="flex min-w-0 flex-1 justify-end">
        <div role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions" aria-label="Notifications">
          <button
            ref={buttonRef}
            type="button"
            data-testid="header-toast-cluster"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={name}
            title={count === 0 ? undefined : expanded ? 'Hide details' : names.join(' · ')}
            className={`${count === 0 ? 'hidden' : 'flex'} h-8 items-center rounded-full py-0.5 pl-2.5 pr-0.5 outline-none hover:bg-ui-hover focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 ${
              expanded ? 'bg-ui-hover' : ''
            }`}
          >
            <span ref={setCircleHost} data-testid="header-toast-strip" className="isolate flex items-center" />
          </button>
        </div>
        <div
          ref={setPanelHost}
          id={panelId}
          role="region"
          aria-label="Notifications"
          tabIndex={-1}
          data-testid="header-toast-panel"
          style={panelStyle}
          className={
            expanded
              ? 'z-[60] flex w-max flex-col overflow-y-auto overflow-x-hidden overscroll-contain rounded-ui bg-ui-raise text-ui-ink shadow-lg outline-none ring-1 ring-ui-line motion-safe:animate-ui-unfold-left'
              : 'hidden'
          }
        >
          {/* -mt-px hides the first section's top divider under the panel's top edge, whatever
              order the sections land in. */}
          <div ref={setListHost} className="-mt-px flex flex-col" />
        </div>
        {children}
      </div>
    </Ctx.Provider>
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

// THE ONE TONE MAPPING (docs/redesign/DESIGN.md § 3): a toast's source shows only on the ICON and
// the PROGRESS FILL (the circle's ring and the panel's bar), and only where the colour means
// something: the AI family for a model's run, danger for conflicts (they block), the accent for the
// sync / merge machinery the reader set going, grey for the rest.
export const HEADER_TOAST_TONE: Record<HeaderToastTone, { mark: string; fill: string; stroke: string }> = {
  neutral: { mark: 'text-ui-mute', fill: 'bg-ui-faint', stroke: 'stroke-ui-faint' },
  ai: { mark: 'text-ai-signal', fill: 'bg-ai-signal-fill', stroke: 'stroke-ai-signal-fill' },
  merge: { mark: 'text-ui-accent', fill: 'bg-ui-accent', stroke: 'stroke-ui-accent' },
  sync: { mark: 'text-ui-accent', fill: 'bg-ui-accent', stroke: 'stroke-ui-accent' },
  attention: { mark: 'text-ui-mute', fill: 'bg-ui-faint', stroke: 'stroke-ui-faint' },
  conflicts: { mark: 'text-ui-danger', fill: 'bg-ui-danger', stroke: 'stroke-ui-danger' },
};

interface HeaderToastProps {
  /** What the job is, in a few words. Names the circle, leads its section, names its X. */
  label: string;
  /** A component from `Icons.tsx` at `size={13}`. */
  icon: ReactNode;
  /** On the circle (the section gets `<testId>-panel`). */
  testId?: string;
  /** Extra classes on the circle (e.g. a fade-out opacity). */
  className?: string;
  /** Where the toast comes from — the icon colour and the progress fill. Default `neutral`. */
  tone?: HeaderToastTone;
  /** The rest of the job's line, after the label. Plain words. */
  summary?: ReactNode;
  /** One compact control on the job's line (Undo, Reopen). Use `ToastLineButton`. */
  action?: ReactNode;
  /** The toast's own dismiss. Absent = not dismissible, no X. */
  onDismiss?: () => void;
  /** The X's accessible name. Default "Dismiss <label>". */
  dismissLabel?: string;
  /** A known fraction: a ring on the circle, a bar in the panel. */
  progress?: HeaderToastProgress | null;
  /** A count badge on the circle (running jobs, armed merges). 0 or absent = no badge. */
  count?: number;
  /** Something failed or needs the reader: a red ring and dot on the circle, and it moves to the
   *  top of the cluster. */
  alert?: boolean;
  /** The rows shown in the expanded panel (`ToastList` + `ToastRow`). */
  children?: ReactNode;
  /** The section's last line: secondary actions ("Show 3 more", "Dismiss finished") and a note. */
  footer?: ReactNode;
}

let nextSeq = 0;

/** Stop a click on the X or an on-line action from reaching anything behind it. */
function stop(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

// The circle: 28px, the icon in the middle, the ring drawn just inside its edge.
const RING_R = 12.5;
const RING_C = 2 * Math.PI * RING_R;

/** One job: a circle in the cluster and, while the panel is open, a section in it. */
export function HeaderToast({
  label,
  icon,
  summary,
  action,
  onDismiss,
  dismissLabel,
  progress,
  count,
  alert = false,
  children,
  footer,
  testId,
  className = '',
  tone = 'neutral',
}: HeaderToastProps): JSX.Element | null {
  const ctx = useContext(Ctx);
  const idRef = useRef<{ id: string; seq: number } | null>(null);
  if (idRef.current == null) {
    const seq = ++nextSeq;
    idRef.current = { id: `hdr-toast-${seq}`, seq };
  }
  const { id, seq } = idRef.current;
  const setLabel = ctx?.setLabel;
  useLayoutEffect(() => {
    setLabel?.(id, label);
  }, [setLabel, id, label]);
  useLayoutEffect(() => () => setLabel?.(id, null), [setLabel, id]);

  if (ctx == null) return null;
  const pct = progress ? Math.max(0, Math.min(100, Math.round(progress.value))) : 0;
  const colours = HEADER_TOAST_TONE[tone];
  const rank = toastRank({ alert, action: action != null, progress: progress != null }, seq);
  const badge = count != null && count > 0 ? (count > 99 ? '99+' : String(count)) : null;

  const circle = (
    <span
      data-testid={testId}
      data-tone={tone}
      data-alert={alert ? 'true' : undefined}
      title={badge != null ? `${label} · ${badge}` : label}
      style={{ order: rank, zIndex: rank }}
      className={`relative -ml-2.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ui-raise ring-2 ${
        alert ? 'ring-ui-danger' : 'ring-ui-bg'
      } ${colours.mark} touch:h-9 touch:w-9 ${className}`}
    >
      {progress != null && (
        <svg aria-hidden viewBox="0 0 28 28" className="pointer-events-none absolute inset-0 h-full w-full -rotate-90">
          <circle cx="14" cy="14" r={RING_R} fill="none" strokeWidth="2" className="stroke-ui-line" />
          <circle
            cx="14"
            cy="14"
            r={RING_R}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - pct / 100)}
            className={`${colours.stroke} motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500`}
          />
        </svg>
      )}
      <span aria-hidden className="flex items-center">
        {icon}
      </span>
      {/* ⚠ The badge and the alert dot sit on the circle's LEFT: each circle overlaps the one to
          its left and paints above it, so anything on a circle's right half is under its neighbour
          (a merge count was hidden under the loading circle). */}
      {badge != null && (
        <span
          aria-hidden
          className="absolute -bottom-1.5 -left-2 min-w-[18px] rounded-full bg-ui-accent-fill px-1 text-center text-meta font-medium leading-[18px] tabular-nums text-ui-on-accent"
        >
          {badge}
        </span>
      )}
      {alert && <span aria-hidden className="absolute -left-0.5 -top-0.5 h-2 w-2 rounded-full bg-ui-danger ring-2 ring-ui-bg" />}
      {/* The words, for the live region and for tests; the button's own name lists every label. */}
      <span className="sr-only">
        {label}
        {summary != null && <> · {summary}</>}
      </span>
    </span>
  );

  const section = (
    <section
      role="group"
      aria-label={label}
      data-testid={testId != null ? `${testId}-panel` : undefined}
      data-tone={tone}
      style={{ order: -rank }}
      className="border-t border-ui-line/60"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span className={`flex h-[18px] shrink-0 items-center ${colours.mark}`}>{icon}</span>
        <p className="min-w-0 flex-1 break-words text-meta leading-[18px]">
          <span className="font-medium">{label}</span>
          {summary != null && (
            <span className="text-ui-mute">
              {' · '}
              {summary}
            </span>
          )}
        </p>
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
      </div>
      {progress != null && (
        <div
          role="progressbar"
          aria-label={progress.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="mx-3 mb-2 h-[3px] overflow-hidden rounded-[2px] bg-ui-hover"
        >
          <div
            className={`h-full rounded-[2px] ${colours.fill} motion-safe:transition-all motion-safe:duration-500`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {children != null && <div className="px-3 pb-1 text-meta">{children}</div>}
      {footer != null && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-ui-line/60 px-3 py-1.5 text-meta text-ui-mute">
          {footer}
        </div>
      )}
    </section>
  );

  return (
    <>
      {ctx.circleHost != null && createPortal(circle, ctx.circleHost)}
      {/* ⚠ ALWAYS MOUNTED, open or shut (the shut panel is `hidden`): a section's rows own live work —
          an AI Fix row drives its run's status stream, which is what turns it into "Fix ready". */}
      {ctx.listHost != null && createPortal(section, ctx.listHost)}
    </>
  );
}

/**
 * A job's rows, divided. Rows bleed to the section's edges; the list is NEVER its own scroller
 * (no `max-h-* overflow-auto`) — the expanded panel is the one scroller (see the header comment).
 */
export function ToastList({ id, children }: { id?: string; children: ReactNode }): JSX.Element {
  return (
    <ul id={id} className="-mx-3 divide-y divide-ui-line/60 border-t border-ui-line/60">
      {children}
    </ul>
  );
}

/** One row of a job: the same padding, type size and line layout everywhere. */
export function ToastRow({ children }: { children: ReactNode }): JSX.Element {
  return <li className="px-3 py-1.5 text-meta leading-snug">{children}</li>;
}

/** The compact control kept on a job's line (Undo, Reopen) — one look for every job. */
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

/** A secondary action in a job's footer ("Dismiss finished"). */
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
 * The "N more" control under a job's capped list, for its FOOTER: it reveals every row inside the
 * expanded panel (which scrolls within its max height), then offers "Show fewer".
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
