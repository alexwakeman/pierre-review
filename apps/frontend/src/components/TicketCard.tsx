// ONE TICKET CARD for every This Sprint view (Critical path, Theme, People) on the lane board
// (components/LaneBoard.tsx). The key (mono), the short title (two lines, always reserved), the
// brief's ONE-LINE summary (one line, truncated; the full line is in the accessible name and the
// card's `title`), the acceptance-criteria line ("3 of 4 criteria met" from the latest ticket check,
// else "4 criteria" from the brief — lib/laneBoard.ts `ticketCardCriteria`), the ticket's theme
// (People, one line), then its tags as WORDS and the assignee's initials (Critical path, Theme)
// (lib/laneBoard.ts `ticketCardTags`: "CI failing", "No PR" or "n PRs · m open", "No owner").
//
//   HEIGHT   every card is the same height whatever it carries: the title keeps two lines, the
//            one-liner, criteria and theme one each, and the initials' slot is held open when nobody
//            is assigned. An empty slot stays open. Cards fill their slot, so a grid row's cards line up.
//   BORDER   (lib/laneBoard.ts `ticketCardBorder`) solid accent, 2px = on a critical path; dashed = waiting on another unfinished ticket;
//            both = dashed accent. A card with an open or merged pull request has a violet border and
//            a soft violet glow (a critical-path card keeps its orange border and adds the glow), and
//            sits first in its cell. A ticket outside the sprint is FAINT: a light dashed border on a
//            tinted ground (its text stays at full contrast). The state is also in the accessible name.
//            The board's key (Activity/SprintBoards.tsx `CardBorderKey`) names each style.
//   CLICK    the card opens a POPOVER IN PLACE (Activity/StoryPeek.tsx — the story's summary and its
//            criteria, read on click), dismissed by a click outside or Escape. The small arrow in the
//            corner, and the popover's "Open story", open the story tab (`onOpen` — the caller's
//            `useOpenStory`).
import { useEffect, useId, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import type { SprintGraphNode } from '@pierre-review/shared';
import { claimActivePopover } from '../lib/activePopover.js';
import { initialsOf } from '../lib/openPrsStacks.js';
import { hasLivePr, ticketCardBorder, ticketCardCriteria, ticketCardTags } from '../lib/laneBoard.js';
import { StoryPeek } from './Activity/StoryPeek.js';
import { ArrowIcon, RefreshIcon, WarningIcon } from './Icons.js';

export function TicketCard({
  node,
  critical,
  waiting,
  show,
  onOpen,
  cardRef,
}: {
  node: SprintGraphNode;
  critical: boolean;
  waiting: boolean;
  /** 'initials' = the assignee (Critical path, Theme); 'theme' = the ticket's theme (People). */
  show: 'initials' | 'theme';
  /** Open the ticket's story tab. */
  onOpen: (node: SprintGraphNode) => void;
  cardRef?: (el: HTMLElement | null) => void;
}): JSX.Element {
  const tags = ticketCardTags(node);
  const criteria = ticketCardCriteria(node);
  const withPr = !node.ghost && hasLivePr(node);
  const oneLiner = node.brief.oneLiner != null && node.brief.oneLiner.trim() !== '' ? node.brief.oneLiner : null;
  const title = node.title !== '' ? node.title : 'Not read';
  const [open, setOpen] = useState(false);
  const popId = useId();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ['top-start', 'right-start', 'left-start'] }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(180, Math.min(availableHeight, 480))}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(context);
  // Escape is captured below (the global keyboard hook would otherwise also leave the overlay).
  const dismiss = useDismiss(context, { escapeKey: false });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);
  useEffect(() => {
    if (!open) return;
    return claimActivePopover(() => setOpen(false));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const name = [
    `${node.key}: ${title}`,
    oneLiner,
    node.status != null ? node.status.name : null,
    node.ghost ? 'outside the sprint' : null,
    node.assignee != null ? `assigned to ${node.assignee.name}` : null,
    show === 'theme' && node.theme != null ? `theme ${node.theme}` : null,
    criteria != null && criteria.text !== '' ? (criteria.stale ? `${criteria.text}, checked before the latest changes` : criteria.text) : null,
    criteria?.running === true ? 'being checked' : null,
    ...tags,
    withPr ? 'has a pull request' : null,
    critical ? 'on a critical path' : null,
    waiting ? 'waiting on another ticket' : null,
    'shows its story here',
  ]
    .filter(Boolean)
    .join('; ');
  const openStory = (): void => {
    setOpen(false);
    onOpen(node);
  };
  return (
    <div
      ref={(el) => {
        refs.setReference(el);
        cardRef?.(el);
      }}
      data-ticket={node.key}
      data-pr={withPr ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      className={`relative flex w-full min-w-0 flex-col rounded-md hover:shadow-md ${open ? 'shadow-md' : ''} ${ticketCardBorder({
        critical,
        waiting,
        ghost: node.ghost,
        withPr,
      })}`}
    >
      <button
        type="button"
        aria-label={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        {...getReferenceProps()}
        // A 2px (critical) border takes 1px of the padding back, so every card is the same size.
        className={`flex w-full min-w-0 flex-col rounded-md text-left ${critical && !node.ghost ? 'px-[7px] py-[5px]' : 'px-2 py-1.5'} focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500`}
      >
        <span className="block truncate pr-4 font-mono text-[11px] font-semibold leading-snug text-gray-700 dark:text-gray-200">{node.key}</span>
        {/* Two lines held open (12px × leading-snug), so a one-line title is as tall as a two-line one. */}
        <span aria-hidden className="mt-0.5 line-clamp-2 min-h-[2.75em] break-words text-[12px] leading-snug text-gray-900 dark:text-gray-50">
          {title}
        </span>
        {/* The brief's one line: always one line held open, so a card without one is as tall. */}
        <span
          aria-hidden
          data-testid="ticket-one-liner"
          title={oneLiner ?? undefined}
          className="mt-0.5 block h-[1.375em] truncate text-[11px] leading-snug text-gray-600 dark:text-gray-300"
        >
          {oneLiner}
        </span>
        {/* Acceptance criteria: "3 of 4 criteria met" (the latest ticket check) or "4 criteria" (the
            brief). Italic and muted when the check predates the latest pull-request changes (the popover
            and the accessible name say so in words). One line, held open. */}
        <span aria-hidden data-testid="ticket-criteria" className="mt-0.5 flex h-[1.375em] min-w-0 items-center gap-1 text-[11px] leading-snug">
          {criteria != null && criteria.text !== '' && (
            <span
              className={`truncate ${criteria.stale ? 'italic text-gray-600 dark:text-gray-300' : 'text-gray-700 dark:text-gray-200'}`}
            >
              {criteria.text}
            </span>
          )}
          {criteria?.running === true && (
            <RefreshIcon size={10} className="shrink-0 animate-spin text-gray-500 motion-reduce:animate-none dark:text-gray-400" />
          )}
        </span>
        {show === 'theme' && (
          <span aria-hidden className="mt-0.5 flex h-[1.375em] min-w-0 text-[11px] leading-snug">
            {node.theme != null && (
              <span className="truncate rounded bg-gray-100 px-1 text-gray-700 dark:bg-gray-800 dark:text-gray-200">{node.theme}</span>
            )}
          </span>
        )}
        {/* One line, always 20px (the initials' height), never wrapping: only the PR-count tag
            shrinks and truncates, so "CI failing" and "No owner" can never fall off the face. */}
        <span aria-hidden className="mt-0.5 flex h-5 w-full items-center gap-x-1.5 text-[11px] leading-5">
          <span className="flex h-5 min-w-0 flex-1 flex-nowrap items-center gap-x-1.5 overflow-hidden">
            {tags.map((t) => (
              <span
                key={t}
                className={`h-5 ${t === 'CI failing' || t === 'No owner' ? 'shrink-0' : 'min-w-0 truncate'} ${t === 'CI failing' ? 'inline-flex items-center gap-0.5 font-medium text-rose-700 dark:text-rose-300' : 'text-gray-600 dark:text-gray-300'}`}
              >
                {t === 'CI failing' && <WarningIcon size={10} />}
                {t}
              </span>
            ))}
          </span>
          {show === 'initials' &&
            (node.assignee != null ? (
              <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 px-0.5 text-[11px] font-semibold leading-none text-gray-800 dark:bg-gray-700 dark:text-gray-100">
                {initialsOf(node.assignee.name)}
              </span>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            ))}
        </span>
      </button>
      <button
        type="button"
        onClick={openStory}
        aria-label={`Open ${node.key}'s story`}
        title="Open story"
        className="absolute right-0.5 top-0.5 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-50"
      >
        <ArrowIcon size={11} />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus initialFocus={-1}>
            <div
              ref={refs.setFloating}
              id={popId}
              role="dialog"
              aria-label={`${node.key} story`}
              style={floatingStyles}
              {...getFloatingProps()}
              data-noactivate
              data-testid="story-peek"
              className="z-[60] w-[26rem] max-w-[92vw] overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900"
            >
              <StoryPeek node={node} onOpenStory={openStory} />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  );
}
