import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage.js';
import { escapeOwnedByControl } from '../../lib/escapeOwner.js';
import { hasActivePopover } from '../../lib/activePopover.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { StoryViewBody } from '../Ticket/StoryViewBody.js';
import { ArrowIcon, ChevronIcon, CloseIcon } from '../Icons.js';
import { Button, IconButton } from '../ui/Button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';

// THIS SPRINT'S STORY TRAY (docs/FRONTEND.md § This Sprint, § The story view): a ticket clicked on the
// board (a card, a call-out key, a ticket key in an Ask Claude answer) shows its story HERE, on the
// right of the board, so the reader never leaves the sprint. The body is the story TAB's own
// (`StoryViewBody`), never a copy; "Open story tab" opens the tab itself (`useOpenStory`).
//
//   STATE    `sprintStoryIdent` in the filter store, mirrored to `?sprintStory=` (a navigation key:
//            Back closes the tray). The caller mounts the tray only while it is set, so nothing here
//            fetches until a ticket was clicked (NOTHING ON THE BOARD FETCHES ON MOUNT).
//   LAYOUT   wide screens: a column beside the board, sticky in the overlay's scroll box, scrolling on
//            its own; the board narrows and scrolls sideways in its own box (LaneBoard re-routes its
//            arrows on resize). md–lg: a sheet over the right of the page; a PHONE: a full-screen
//            sheet with Back top left (the redesign; docs/redesign/DESIGN.md § 6).
//            ⚠ Its height is the SCROLL BOX's visible height (measured), never `100vh - Npx`: a tray
//            taller than the box it sticks in stretched the row and left blank space under the board.
//   WIDTH    the left edge is a drag handle (also arrow keys); the width is remembered in localStorage
//            (TRAY_WIDTH_KEY) for every later opening; Home or a double-click goes back to the default,
//            TRAY_WIDTH_DEFAULT_CSS, wide enough for the design diagrams; capped so the board keeps MIN_BOARD_PX beside it.
//   ESCAPE   closes the tray (capture phase, so the global "Escape leaves the tab" does not also run),
//            and focus returns to the card that opened it — unless an open popover, a modal or a
//            control that owns Escape is the one being dismissed, or the reader is typing.

const TRAY_WIDTH_KEY = 'limn:sprintTrayWidth';
// The default until the reader drags: 52rem, or 55% of the row on a narrower screen, so the board keeps
// room for its cards. A drag stores pixels.
const TRAY_WIDTH_DEFAULT_CSS = 'min(52rem, 55%)';
const TRAY_WIDTH_MIN = 360;
const MIN_BOARD_PX = 320;
const KEY_STEP = 32;

/** The nearest ancestor that scrolls vertically (the overlay's scroll box), else null. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p != null; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function SprintStoryTray({
  id,
  ident,
  ticketKey,
  title,
  onClose,
}: {
  /** The tray's element id (the open card's `aria-controls`). */
  id: string;
  ident: string;
  ticketKey: string;
  title: string | null;
  onClose: () => void;
}): JSX.Element {
  const openStory = useOpenStory();
  // The latest close, for the one listener below.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (isTypingTarget(e.target) || escapeOwnedByControl(e.target) || hasActivePopover()) return;
      if (document.querySelector('[aria-modal="true"]') != null) return;
      e.stopImmediatePropagation();
      closeRef.current();
      // Back to the card that opened it, when it is still on the board.
      const card = Array.from(document.querySelectorAll<HTMLElement>('[data-ident]')).find((el) => el.dataset.ident === ident);
      card?.querySelector<HTMLElement>('[data-card-button]')?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ident]);

  const asideRef = useRef<HTMLElement>(null);
  // The remembered width (px); a drag previews in `dragWidth` and commits on release.
  const [savedWidth, setSavedWidth] = useLocalStorage<number | null>(TRAY_WIDTH_KEY, null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const chosen = dragWidth ?? (typeof savedWidth === 'number' && Number.isFinite(savedWidth) ? savedWidth : null);
  const width = chosen != null ? Math.max(TRAY_WIDTH_MIN, chosen) : null;
  // The tray's height, measured against the scroll box it sticks in and the board beside it.
  const [boxHeight, setBoxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const aside = asideRef.current;
    const box = scrollParent(aside);
    const row = aside?.parentElement ?? null;
    if (aside == null || box == null || row == null) return;
    // ⚠ Never let the tray make the page taller than the board. `fullH` is the box's visible height;
    // `fitH` is what fits below the row's own top without scrolling. A short board gets `fitH` (no
    // scroll, no blank space); a tall board lets the tray grow to `fullH`, but never past the board,
    // so it can stick at the top while the reader scrolls.
    const measure = (): void => {
      const cs = getComputedStyle(box);
      const padTop = parseFloat(cs.paddingTop);
      const padBottom = parseFloat(cs.paddingBottom);
      const fullH = box.clientHeight - padTop - padBottom;
      const rowTop = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      const fitH = box.clientHeight - rowTop - padBottom;
      const board = Array.from(row.children).find((c) => c !== aside) as HTMLElement | undefined;
      const boardH = board?.getBoundingClientRect().height ?? 0;
      setBoxHeight(Math.round(Math.max(Math.min(fitH, fullH), Math.min(boardH, fullH), 240)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    for (const c of Array.from(row.children)) if (c !== aside) ro.observe(c);
    return () => ro.disconnect();
  }, []);

  /** The widest the tray may be: its row's width less room for the board (the viewport on a sheet). */
  const maxWidth = (): number => {
    const row = asideRef.current?.parentElement;
    const rowWidth = row != null && getComputedStyle(asideRef.current!).position === 'sticky' ? row.clientWidth : window.innerWidth;
    return Math.max(TRAY_WIDTH_MIN, rowWidth - MIN_BOARD_PX);
  };
  const clampWidth = (w: number): number => Math.round(Math.min(maxWidth(), Math.max(TRAY_WIDTH_MIN, w)));

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = asideRef.current?.getBoundingClientRect().width ?? width ?? TRAY_WIDTH_MIN;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let last = startW;
    const move = (ev: PointerEvent): void => {
      last = clampWidth(startW + (startX - ev.clientX));
      setDragWidth(last);
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setSavedWidth(last);
      setDragWidth(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const current = asideRef.current?.getBoundingClientRect().width ?? width ?? TRAY_WIDTH_MIN;
    if (e.key === 'ArrowLeft') setSavedWidth(clampWidth(current + KEY_STEP));
    else if (e.key === 'ArrowRight') setSavedWidth(clampWidth(current - KEY_STEP));
    else if (e.key === 'Home') setSavedWidth(null);
    else return;
    e.preventDefault();
  };

  const style = {
    '--tray-w': width != null ? `${width}px` : TRAY_WIDTH_DEFAULT_CSS,
    ...(boxHeight != null ? { '--tray-h': `${boxHeight}px` } : {}),
  } as CSSProperties;

  return (
    <aside
      ref={asideRef}
      id={id}
      aria-label={`${ticketKey} story`}
      data-testid="sprint-story-tray"
      data-noactivate
      style={style}
      // Phone: a FULL-SCREEN sheet (Back closes it). md–lg: a sheet over the right of the page. lg+: a
      // sticky column beside the board, the surface tone against the page (no border).
      className={cx(
        'fixed inset-0 z-50 flex flex-col bg-ui-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] motion-safe:animate-ui-sheet-up',
        'md:inset-y-0 md:left-auto md:right-0 md:w-[min(var(--tray-w),92vw)] md:pt-0 md:shadow-2xl md:shadow-black/30 md:motion-safe:animate-ui-slide-in',
        'lg:sticky lg:inset-y-auto lg:right-auto lg:top-0 lg:z-auto lg:max-h-[var(--tray-h,calc(100vh-7rem))] lg:w-[min(var(--tray-w),calc(100%-20rem))] lg:shrink-0 lg:self-start lg:rounded-ui lg:pb-0 lg:shadow-none',
      )}
    >
      {/* The width handle: the tray's left edge. Drag, or focus it and use the arrow keys (Home resets).
          Not on a phone, where the sheet is the whole screen. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the story"
        aria-valuenow={width != null ? Math.round(width) : undefined}
        aria-valuemin={TRAY_WIDTH_MIN}
        tabIndex={0}
        data-testid="sprint-story-tray-resize"
        title="Drag to resize"
        onPointerDown={onHandleDown}
        onKeyDown={onHandleKey}
        onDoubleClick={() => setSavedWidth(null)}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none rounded-ui hover:bg-ui-accent/30 focus:outline-none focus-visible:bg-ui-accent/40 md:block"
      />
      <div className="flex h-12 shrink-0 items-center gap-2 px-2 md:h-11 md:px-4">
        {/* Phone: Back, top left (the sheet's way out); wider: the × on the right. */}
        <button
          type="button"
          onClick={onClose}
          className={cx('hit -ml-1 flex h-10 items-center gap-1 rounded-ui px-2 text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink md:hidden', FOCUS_RING)}
        >
          <ChevronIcon dir="left" size={12} />
          Back
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-body font-medium text-ui-ink">{ticketKey}</span>
        <Button variant="ghost" size="sm" icon={<ArrowIcon size={11} />} onClick={() => openStory({ ident, key: ticketKey, title })}>
          Open story tab
        </Button>
        <IconButton label="Close the story" icon={<CloseIcon size={12} />} size="sm" onClick={onClose} className="hidden md:inline-flex" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1 md:px-4">
        {/* Keyed on the ticket, so switching tickets starts the body afresh. */}
        <StoryViewBody key={ident} ident={ident} meta={{ key: ticketKey, title }} />
      </div>
    </aside>
  );
}
