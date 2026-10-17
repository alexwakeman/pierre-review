// ONE TICKET CARD for every This Sprint view (Critical path, Theme, People) on the lane board
// (components/LaneBoard.tsx). The key (mono), the short title (two lines at most), the ticket's theme
// (People), then its tags as WORDS and the assignee's initials (Critical path, Theme)
// (lib/laneBoard.ts `ticketCardTags`: "CI failing", "No PR" or "n PRs · m open", "No owner").
//
//   BORDER   (lib/laneBoard.ts `ticketCardBorder`) solid accent, 2px = on a critical path; dashed = waiting on another unfinished ticket;
//            both = dashed accent. A ticket outside the sprint is FAINT: a light dashed border on a
//            tinted ground (its text stays at full contrast). The state is also in the accessible name.
//   CLICK    the card is a button: it opens the ticket's story view (`onOpen` — the caller's
//            `useOpenStory`), Open PRs style, with its Story section open.
import type { SprintGraphNode } from '@pierre-review/shared';
import { initialsOf } from '../lib/openPrsStacks.js';
import { ticketCardBorder, ticketCardTags } from '../lib/laneBoard.js';
import { WarningIcon } from './Icons.js';

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
  onOpen: (node: SprintGraphNode) => void;
  cardRef?: (el: HTMLElement | null) => void;
}): JSX.Element {
  const tags = ticketCardTags(node);
  const title = node.title !== '' ? node.title : 'Not read';
  const name = [
    `${node.key}: ${title}`,
    node.status != null ? node.status.name : null,
    node.ghost ? 'outside the sprint' : null,
    node.assignee != null ? `assigned to ${node.assignee.name}` : null,
    show === 'theme' && node.theme != null ? `theme ${node.theme}` : null,
    ...tags,
    critical ? 'on a critical path' : null,
    waiting ? 'waiting on another ticket' : null,
    'opens its story',
  ]
    .filter(Boolean)
    .join('; ');
  return (
    <button
      ref={cardRef}
      type="button"
      aria-label={name}
      data-ticket={node.key}
      onClick={() => onOpen(node)}
      className={`block w-full min-w-0 rounded-md px-2 py-1.5 text-left hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${ticketCardBorder({
        critical,
        waiting,
        ghost: node.ghost,
      })}`}
    >
      <span className="block break-all font-mono text-[11px] font-semibold leading-snug text-gray-700 dark:text-gray-200">{node.key}</span>
      <span aria-hidden className="mt-0.5 line-clamp-2 break-words text-[12px] leading-snug text-gray-900 dark:text-gray-50">
        {title}
      </span>
      {show === 'theme' && node.theme != null && (
        <span aria-hidden className="mt-0.5 inline-block max-w-full break-words rounded bg-gray-100 px-1 text-[11px] leading-snug text-gray-700 dark:bg-gray-800 dark:text-gray-200">
          {node.theme}
        </span>
      )}
      <span aria-hidden className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-snug">
        {tags.map((t) => (
          <span
            key={t}
            className={t === 'CI failing' ? 'inline-flex items-center gap-0.5 font-medium text-rose-700 dark:text-rose-300' : 'text-gray-600 dark:text-gray-300'}
          >
            {t === 'CI failing' && <WarningIcon size={10} />}
            {t}
          </span>
        ))}
        {show === 'initials' && node.assignee != null && (
          <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 px-0.5 text-[11px] font-semibold leading-none text-gray-800 dark:bg-gray-700 dark:text-gray-100">
            {initialsOf(node.assignee.name)}
          </span>
        )}
      </span>
    </button>
  );
}
