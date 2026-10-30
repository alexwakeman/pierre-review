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
//   MARKS    (lib/laneBoard.ts `ticketCardMarks`, the redesign) an ICON beside the key, never a border
//            colour: the route (`CriticalPathIcon`, in the arrows' vermilion — the paths are the
//            model's) = on a critical path; the hourglass (`WaitingIcon`) = waiting on another
//            unfinished ticket. A ticket outside the sprint sits RECESSED (`ticketCardSurface`: the
//            page's ground with a faint ring; it sits in the "Outside the sprint" column too). A card
//            with an open or merged pull request wears the pull-request icon before its key and sits
//            first in its cell. Every mark is also in the accessible name and the mark's `title`; the
//            board's key (`BorderKey`, components/LaneBoard.tsx) names each one.
//   CODE     "needs code" (lib/laneBoard.ts `ticketCodeNote`): the judgement and its reason are the card
//            button's tooltip and in its accessible name; under the board's Needs code filter a ticket
//            not judged yet wears a muted "Not judged yet" beside its key (`codeMarker`).
//   CLICK    the card opens the STORY TRAY beside the board (Sprint/SprintStoryTray.tsx — the story
//            view's own body; `onSelect`). The open card wears the accent ring (the selection colour).
//            The small arrow in the corner opens the story TAB (`onOpen` — `useOpenStory`).
import type { SprintGraphNode } from '@pierre-review/shared';
import {
  hasLivePr,
  TICKET_CARD_MARK_LABEL,
  ticketCardCriteria,
  ticketCardMarks,
  ticketCardSurface,
  ticketCardTags,
  ticketCodeNote,
} from '../lib/laneBoard.js';
import { cx, FOCUS_RING } from './ui/cx.js';
import { ArrowIcon, CriticalPathIcon, PullRequestIcon, RefreshIcon, WaitingIcon, WarningIcon } from './Icons.js';

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
  codeMarker = false,
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
  /** The board's Needs code filter is on: a ticket not judged yet says so beside its key. */
  codeMarker?: boolean;
}): JSX.Element {
  // "No owner" and "Unassigned" would say one thing twice on the person line's views.
  const tags = ticketCardTags(node).filter((t) => !(show === 'person' && t === 'No owner'));
  const criteria = ticketCardCriteria(node);
  const withPr = !node.ghost && hasLivePr(node);
  const oneLiner = node.brief.oneLiner != null && node.brief.oneLiner.trim() !== '' ? node.brief.oneLiner : null;
  const title = node.title !== '' ? node.title : 'Not read';
  const code = ticketCodeNote(node);
  const marker = codeMarker ? (code?.marker ?? null) : null;
  // 'outside' is the recessed ground (and the column it sits in), not an icon.
  const marks = ticketCardMarks({ critical, waiting, ghost: node.ghost }).filter((m) => m !== 'outside');

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
    code?.tooltip ?? null,
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
      data-marks={marks.length > 0 ? marks.join(' ') : undefined}
      className={cx(
        'group relative flex w-full min-w-0 flex-col rounded-ui',
        'motion-safe:transition-colors motion-safe:duration-ui-fast',
        ticketCardSurface({ ghost: node.ghost }),
        !node.ghost && 'hover:bg-ui-hover',
        selected && 'ring-2 ring-ui-accent',
      )}
    >
      <button
        type="button"
        aria-label={name}
        aria-pressed={selected}
        aria-controls={selected ? trayId : undefined}
        title={code?.tooltip}
        data-card-button
        onClick={() => onSelect(node)}
        className={cx('hit flex w-full min-w-0 flex-col rounded-ui px-2.5 py-2 text-left', FOCUS_RING)}
      >
        <span className="flex h-4 min-w-0 items-center gap-1 pr-5 [@media(hover:hover)]:pr-0">
          {/* Has an open or merged pull request: the pull-request mark, before the key. */}
          {withPr && (
            <span aria-hidden data-testid="ticket-pr-dot" title="Has a pull request" className="flex shrink-0 text-ui-mute">
              <PullRequestIcon size={11} />
            </span>
          )}
          <span className="min-w-0 truncate font-mono text-meta font-medium text-ui-mute [@media(hover:hover)]:shrink-0">{node.key}</span>
          {marks.map((m) => (
            <span
              key={m}
              aria-hidden
              data-testid={`ticket-mark-${m}`}
              title={TICKET_CARD_MARK_LABEL[m]}
              className={cx('flex shrink-0', m === 'critical' ? 'text-ai-signal' : 'text-ui-mute')}
            >
              {m === 'critical' ? <CriticalPathIcon size={12} /> : <WaitingIcon size={12} />}
            </span>
          ))}
          {marker != null && (
            <span aria-hidden data-testid="ticket-code-marker" className="ml-auto shrink-0 truncate text-meta italic text-ui-mute">
              {marker}
            </span>
          )}
        </span>
        {/* Two lines held open (13px / 20px), so a one-line title is as tall as a two-line one. */}
        <span aria-hidden className="mt-1 line-clamp-2 min-h-[40px] break-words text-body font-medium text-ui-ink">
          {title}
        </span>
        {/* The brief's one line: always one line held open, so a card without one is as tall. */}
        <span aria-hidden data-testid="ticket-one-liner" title={oneLiner ?? undefined} className="mt-0.5 block h-4 truncate text-meta text-ui-mute">
          {oneLiner}
        </span>
        {/* Acceptance criteria: "3 of 4 criteria met" (the latest ticket check) or "4 criteria" (the
            brief). Italic when the check predates the latest pull-request changes (the tray and the
            accessible name say so in words). One line, held open. */}
        <span aria-hidden data-testid="ticket-criteria" className="mt-0.5 flex h-4 min-w-0 items-center gap-1 text-meta">
          {criteria != null && criteria.text !== '' && (
            <span className={cx('truncate', criteria.stale ? 'italic text-ui-faint' : 'text-ui-mute')}>{criteria.text}</span>
          )}
          {criteria?.running === true && <RefreshIcon size={10} className="shrink-0 animate-spin text-ui-faint motion-reduce:animate-none" />}
        </span>
        {/* One line, never wrapping: only the PR-count tag shrinks and truncates, so "CI failing" and
            "No owner" can never fall off the face. */}
        <span aria-hidden className="mt-1.5 flex h-5 w-full items-center gap-x-1.5 text-meta">
          <span className="flex h-5 min-w-0 flex-1 flex-nowrap items-center gap-x-1.5 overflow-hidden">
            {tags.map((t) => (
              <span
                key={t}
                className={cx(
                  'flex h-5 items-center',
                  t === 'CI failing' || t === 'No owner' ? 'shrink-0' : 'min-w-0 truncate',
                  // CI failing BLOCKS: the one red on the card, with its icon and its words.
                  t === 'CI failing' ? 'gap-0.5 font-medium text-ui-danger' : 'text-ui-faint',
                )}
              >
                {t === 'CI failing' && <WarningIcon size={10} />}
                <span className="truncate">{t}</span>
              </span>
            ))}
          </span>
          {/* Bottom right: the person pill (or the theme on People), as long as the name, capped so
              the tags keep room; a longer name truncates with an ellipsis. */}
          <span data-testid="ticket-person-line" className="flex h-5 min-w-0 max-w-[60%] shrink-0 items-center">
            {show === 'theme' ? (
              node.theme != null && <span className="truncate rounded-ui bg-ui-raise px-1.5 text-ui-mute">{node.theme}</span>
            ) : person != null ? (
              <span data-testid="ticket-person" title={person} className="min-w-0 truncate rounded-ui bg-ui-raise px-1.5 text-ui-ink">
                {person}
              </span>
            ) : (
              <span data-testid="ticket-person" className="truncate text-ui-faint">
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
        className={cx(
          'absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-ui text-ui-faint hover:bg-ui-raise hover:text-ui-ink touch:h-10 touch:w-10',
          // On a mouse it shows on hover or focus (the key and its marks get the whole line); on touch it is always there.
          'group-hover:bg-ui-hover [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100',
          FOCUS_RING,
        )}
      >
        <ArrowIcon size={11} />
      </button>
    </div>
  );
}
