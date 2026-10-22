import { useEffect, useRef } from 'react';
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
//   ESCAPE   closes the tray (capture phase, so the global "Escape leaves the tab" does not also run),
//            and focus returns to the card that opened it — unless an open popover, a modal or a
//            control that owns Escape is the one being dismissed, or the reader is typing.

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

  return (
    <aside
      id={id}
      aria-label={`${ticketKey} story`}
      data-testid="sprint-story-tray"
      data-noactivate
      className="fixed inset-y-0 right-0 z-30 flex w-[min(36rem,92vw)] flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-950 lg:sticky lg:inset-y-auto lg:right-auto lg:top-0 lg:z-auto lg:max-h-[calc(100vh-7rem)] lg:w-[min(36rem,42%)] lg:shrink-0 lg:self-start lg:rounded-md lg:border lg:shadow-none"
    >
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
