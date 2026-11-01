import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { SprintGraphNode } from '@pierre-review/shared';
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
// (`StoryViewBody`), never a copy; "Open story tab" opens the tab itself (`useOpenStory`). The story's
// build action (Implement / Fill gaps / Open build — the board's cards carry only the build MARK) sits
// in the body's action group and reads the board's node handed in here.
//
//   STATE    `sprintStoryIdent` in the filter store, mirrored to `?sprintStory=` (a navigation key:
//            Back closes the tray). The caller mounts the tray only while it is set, so nothing here
//            fetches until a ticket was clicked (NOTHING ON THE BOARD FETCHES ON MOUNT).
//   LAYOUT   wide screens: a panel ON TOP of the board, fixed to the right of the board's scroll box
//            (its visible rect, measured) with a shadow, scrolling on its own. ⚠ It never takes room
//            from the board: opening it must not reflow a card or re-route an arrow. md–lg: a sheet
//            over the right of the page; a PHONE: a full-screen sheet with Back top left (the
//            redesign; docs/redesign/DESIGN.md § 6).
//   WIDTH    the left edge is a drag handle (also arrow keys); the width is remembered in localStorage
//            (TRAY_WIDTH_KEY) for every later opening; Home or a double-click goes back to the default,
//            TRAY_WIDTH_DEFAULT_CSS, wide enough for the design diagrams; capped so MIN_BOARD_PX of the board still shows.
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
  node = null,
  onClose,
}: {
  /** The board's node for this ticket (absent for a ticket the board does not show): the story's build
   *  action reads it, so the tray fetches nothing for it. */
  node?: SprintGraphNode | null;
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
  // The tray's dock: the visible rect of the scroll box the board sits in (measured), so the tray
  // covers the board's right side and never the app's header or sidebar.
  const [dock, setDock] = useState<{ top: number; bottom: number; right: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const aside = asideRef.current;
    const box = scrollParent(aside);
    if (aside == null || box == null) return;
    const measure = (): void => {
      const r = box.getBoundingClientRect();
      setDock({
        top: Math.max(0, Math.round(r.top)),
        bottom: Math.max(0, Math.round(window.innerHeight - r.bottom)),
        right: Math.max(0, Math.round(window.innerWidth - r.right)),
        width: Math.round(r.width),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /** The widest the tray may be: the board's box less a strip of board left showing (the viewport on a sheet). */
  const maxWidth = (): number => {
    const room = dock != null && window.matchMedia('(min-width: 1024px)').matches ? dock.width : window.innerWidth;
    return Math.max(TRAY_WIDTH_MIN, room - MIN_BOARD_PX);
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
    ...(dock != null
      ? {
          '--tray-top': `${dock.top}px`,
          '--tray-bottom': `${dock.bottom}px`,
          '--tray-right': `${dock.right}px`,
          '--tray-room': `${Math.max(TRAY_WIDTH_MIN, dock.width - MIN_BOARD_PX)}px`,
        }
      : {}),
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
      // panel ON TOP of the board, docked to the right of the board's box with a shadow; the board's
      // layout never changes when it opens.
      className={cx(
        'fixed inset-0 z-50 flex flex-col bg-ui-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] motion-safe:animate-ui-sheet-up',
        'md:inset-y-0 md:left-auto md:right-0 md:w-[min(var(--tray-w),92vw)] md:pt-0 md:shadow-2xl md:shadow-black/30 md:motion-safe:animate-ui-slide-in',
        'lg:bottom-[var(--tray-bottom,0px)] lg:right-[var(--tray-right,0px)] lg:top-[var(--tray-top,0px)] lg:z-30 lg:w-[min(var(--tray-w),var(--tray-room,92vw))] lg:border-l lg:border-ui-line lg:pb-0',
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
        <StoryViewBody key={ident} ident={ident} meta={{ key: ticketKey, title }} sprintNode={node} />
      </div>
    </aside>
  );
}
