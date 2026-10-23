// ONE TICKET CARD for every This Sprint view (Critical path, Theme, People) on the lane board
// (components/LaneBoard.tsx). The key (mono), the short title (two lines, always reserved), the
// brief's ONE-LINE summary (one line, truncated; the full line is in the accessible name and the
// card's `title`), the acceptance-criteria line ("3 of 4 criteria met" from the latest ticket check,
// else "4 criteria" from the brief — lib/laneBoard.ts `ticketCardCriteria`), then ONE PERSON-OR-THEME
// line, then its tags as WORDS (lib/laneBoard.ts `ticketCardTags`: "CI failing", "No PR" or
// "n PRs · m open", "No owner" — dropped where the person line says "Unassigned" instead).
//
//   PERSON   Critical path and Theme: the assignee's name in a PILL at the BOTTOM RIGHT, beside the
//            tags, as wide as the name up to 60% of the card, then truncated with an ellipsis. The spelling is the People lane's (lib/laneBoard.ts
//            `assigneeLabel`), so one person never reads two ways on one page. The full name is in the
//            card's accessible name AND the pill's `title`. Nobody assigned holds the line open
//            ("Unassigned"). People (the lane IS the person): the same slot carries the ticket's theme.
//   HEIGHT   every card is the same height whatever it carries: the title keeps two lines, the
//            one-liner, criteria, and tags + person/theme one each. An empty slot stays open. Cards fill
//            their slot, so a grid row's cards line up.
//   BORDER   (lib/laneBoard.ts `ticketCardBorder`) solid accent, 2px = on a critical path; dashed =
//            waiting on another unfinished ticket; both = dashed accent. A card with an open or merged
//            pull request wears a violet dot before its key and sits first in its cell. A ticket outside
//            the sprint is FAINT: a light dashed border on a tinted ground (its text stays at full
//            contrast). The state is also in the accessible name. The board's key (`BorderKey`,
//            components/LaneBoard.tsx) names each style.
//   CLICK    the card opens the STORY TRAY beside the board (Sprint/SprintStoryTray.tsx — the story
//            view's own body; `onSelect`). The open card wears a ring (never the border, which carries
//            meaning). The small arrow in the corner opens the story TAB (`onOpen` — `useOpenStory`).
import type { SprintGraphNode } from '@pierre-review/shared';
import { hasLivePr, ticketCardBorder, ticketCardCriteria, ticketCardTags } from '../lib/laneBoard.js';
import { ArrowIcon, RefreshIcon, WarningIcon } from './Icons.js';

export function TicketCard({
  node,
  critical,
  waiting,
  show,
  person,
  selected,
  trayId,
  onSelect,
  onOpen,
  cardRef,
}: {
  node: SprintGraphNode;
  critical: boolean;
  waiting: boolean;
  /** 'person' = the assignee's pill (Critical path, Theme); 'theme' = the ticket's theme (People). */
  show: 'person' | 'theme';
  /** The assignee as the page spells them (`assigneeLabel`); null = nobody assigned. */
  person: string | null;
  /** This card's story is open in the tray. */
  selected: boolean;
  /** The tray's element id (`aria-controls` while this card's story is in it). */
  trayId?: string;
  /** Show the ticket's story in the tray beside the board. */
  onSelect: (node: SprintGraphNode) => void;
  /** Open the ticket's story tab. */
  onOpen: (node: SprintGraphNode) => void;
  cardRef?: (el: HTMLElement | null) => void;
}): JSX.Element {
  // "No owner" and "Unassigned" would say one thing twice on the person line's views.
  const tags = ticketCardTags(node).filter((t) => !(show === 'person' && t === 'No owner'));
  const criteria = ticketCardCriteria(node);
  const withPr = !node.ghost && hasLivePr(node);
  const oneLiner = node.brief.oneLiner != null && node.brief.oneLiner.trim() !== '' ? node.brief.oneLiner : null;
  const title = node.title !== '' ? node.title : 'Not read';

  const name = [
    `${node.key}: ${title}`,
    oneLiner,
    node.status != null ? node.status.name : null,
    node.ghost ? 'outside the sprint' : null,
    person != null ? `assigned to ${person}` : 'unassigned',
    show === 'theme' && node.theme != null ? `theme ${node.theme}` : null,
    criteria != null && criteria.text !== '' ? (criteria.stale ? `${criteria.text}, checked before the latest changes` : criteria.text) : null,
    criteria?.running === true ? 'being checked' : null,
    ...tags,
    withPr ? 'has a pull request' : null,
    critical ? 'on a critical path' : null,
    waiting ? 'waiting on another ticket' : null,
    'shows its story beside the board',
  ]
    .filter(Boolean)
    .join('; ');
  return (
    <div
      ref={cardRef}
      data-ticket={node.key}
      data-ident={node.ident}
      data-pr={withPr ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={`relative flex w-full min-w-0 flex-col rounded-md hover:shadow-md ${
        selected ? 'shadow-md ring-2 ring-sky-500 ring-offset-1 ring-offset-white dark:ring-sky-400 dark:ring-offset-gray-950' : ''
      } ${ticketCardBorder({
        critical,
        waiting,
        ghost: node.ghost,
      })}`}
    >
      <button
        type="button"
        aria-label={name}
        aria-pressed={selected}
        aria-controls={selected ? trayId : undefined}
        data-card-button
        onClick={() => onSelect(node)}
        // A 2px (critical) border takes 1px of the padding back, so every card is the same size.
        className={`flex w-full min-w-0 flex-col rounded-md text-left ${critical && !node.ghost ? 'px-[7px] py-[5px]' : 'px-2 py-1.5'} focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500`}
      >
        <span className="flex min-w-0 items-center gap-1 pr-4">
          {/* Has an open or merged pull request: a violet dot (the merge family), top left. */}
          {withPr && <span aria-hidden data-testid="ticket-pr-dot" className="h-2 w-2 shrink-0 rounded-full bg-violet-500 dark:bg-violet-400" />}
          <span className="truncate font-mono text-[11px] font-semibold leading-snug text-gray-700 dark:text-gray-200">{node.key}</span>
        </span>
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
            brief). Italic and muted when the check predates the latest pull-request changes (the tray
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
        {/* One line, always 20px, never wrapping: only the PR-count tag shrinks and truncates, so
            "CI failing" and "No owner" can never fall off the face. */}
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
          {/* Bottom right: the person pill (or the theme on People), as long as the name, capped so
              the tags keep room; a longer name truncates with an ellipsis. */}
          <span data-testid="ticket-person-line" className="flex h-5 min-w-0 max-w-[60%] shrink-0 items-center">
            {show === 'theme' ? (
              node.theme != null && (
                <span className="truncate rounded bg-gray-100 px-1 text-gray-700 dark:bg-gray-800 dark:text-gray-200">{node.theme}</span>
              )
            ) : person != null ? (
              <span
                data-testid="ticket-person"
                title={person}
                className="min-w-0 truncate rounded-full bg-gray-200 px-1.5 font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-100"
              >
                {person}
              </span>
            ) : (
              <span data-testid="ticket-person" className="truncate text-gray-600 dark:text-gray-300">
                Unassigned
              </span>
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onOpen(node)}
        aria-label={`Open ${node.key}'s story tab`}
        title="Open story tab"
        className="absolute right-0.5 top-0.5 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-50"
      >
        <ArrowIcon size={11} />
      </button>
    </div>
  );
}
