import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage.js';
import { escapeOwnedByControl } from '../../lib/escapeOwner.js';
import { hasActivePopover } from '../../lib/activePopover.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { StoryViewBody } from '../Ticket/StoryViewBody.js';
import { ArrowIcon, CloseIcon } from '../Icons.js';

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
//            arrows on resize). Below `lg`: a sheet over the right of the page.
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
      className="fixed inset-y-0 right-0 z-30 flex w-[min(var(--tray-w),92vw)] flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-950 lg:sticky lg:inset-y-auto lg:right-auto lg:top-0 lg:z-auto lg:max-h-[var(--tray-h,calc(100vh-7rem))] lg:w-[min(var(--tray-w),calc(100%-20rem))] lg:shrink-0 lg:self-start lg:rounded-md lg:border lg:shadow-none"
    >
      {/* The width handle: the tray's left edge. Drag, or focus it and use the arrow keys (Home resets). */}
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
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none rounded hover:bg-sky-500/30 focus:outline-none focus-visible:bg-sky-500/40"
      />
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-gray-800 dark:text-gray-100">{ticketKey}</span>
        <button
          type="button"
          onClick={() => openStory({ ident, key: ticketKey, title })}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
        >
          <ArrowIcon size={11} />
          Open story tab
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the story"
          className="shrink-0 rounded p-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-50"
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* Keyed on the ticket, so switching tickets starts the body afresh. */}
        <StoryViewBody key={ident} ident={ident} meta={{ key: ticketKey, title }} />
      </div>
    </aside>
  );
}
