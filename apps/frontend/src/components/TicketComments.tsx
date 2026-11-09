// THE TICKET'S COMMENTS — the people's discussion under a ticket (docs/TRACKERS.md § Ticket comments).
// Two mounts of one row (`CommentRow`: author · date · markdown body), oldest first. Bots never reach
// the wire. Nothing here fetches.
//
//   StoryComments   — the STORY VIEW's "Comments (n)" (Activity/TicketStorySection.tsx), always open:
//                     the newest STORY_COMMENTS_SHOWN, "Show all n", "New since the check". Its comments
//                     ride the story view's own stored read (`GET /api/ticket-story` `comments`), so a
//                     ticket with no PR has them too. The story view's "As written in …" disclosure
//                     leaves its copy out (`StoryDisclosure withComments={false}`): shown once.
//   TicketComments  — collapsed, under the ticket as written in a Story check block's disclosure
//                     (TicketStory.tsx); its comments ride `GET /api/prs/:id/tracker-ticket`, click-gated.
//
// A "Met outside code changes" citation (lib/ticketReview.ts `showTicketComment`) opens whichever list
// holds the comment, scrolls to it and focuses it. A comment the list does not hold is ignored.
// Links in a body go through `Markdown` (sanitised; it opens them in a new tab).
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { TicketComment } from '@pierre-review/shared';
import { dateTime, formatDate, relativeTime } from '../lib/ui.js';
import { SHOW_TICKET_COMMENT_EVENT } from '../lib/ticketReview.js';
import { STORY_COMMENTS_SHOWN, citedIsHidden, shownStoryComments } from '../lib/ticketComments.js';
import { ChevronIcon } from './Icons.js';
import { Markdown } from './Markdown.js';

const MUTED = 'text-ui-mute';

/** Listen for a citation of one of `comments`; `onCite` gets its id. */
function useCommentCitation(comments: readonly TicketComment[] | undefined, onCite: (id: string) => void): void {
  const cite = useRef(onCite);
  cite.current = onCite;
  useEffect(() => {
    const on = (e: Event): void => {
      const id = (e as CustomEvent<{ commentId?: string }>).detail?.commentId;
      if (id == null || !(comments ?? []).some((c) => c.id === id)) return;
      cite.current(id);
    };
    window.addEventListener(SHOW_TICKET_COMMENT_EVENT, on);
    return () => window.removeEventListener(SHOW_TICKET_COMMENT_EVENT, on);
  }, [comments]);
}

/** Scroll to and focus the cited comment once it is drawn (`tick` repeats it for a second click). */
function useFocusComment(listRef: RefObject<HTMLOListElement | null>, visible: boolean, focusId: string | null, tick: number): void {
  useEffect(() => {
    if (!visible || focusId == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(focusId)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }, [listRef, visible, focusId, tick]);
}

function CommentRow({
  c,
  focused,
  relative = false,
  isNew = false,
}: {
  c: TicketComment;
  focused: boolean;
  /** "3 days ago" (the full date on hover) instead of the date. */
  relative?: boolean;
  /** Written after the latest story check. */
  isNew?: boolean;
}): JSX.Element {
  return (
    <li
      data-comment-id={c.id}
      tabIndex={-1}
      className={`rounded-ui border px-2 py-1.5 focus:outline-none ${focused ? 'border-ui-accent' : 'border-ui-line'}`}
    >
      <div className={`flex flex-wrap items-baseline gap-x-1 text-meta ${MUTED}`}>
        <span className="font-medium text-ui-ink">{c.author !== '' ? c.author : 'Someone'}</span>
        <span aria-hidden className="decorative-mark text-ui-faint">
          ·
        </span>
        <time dateTime={c.createdAt} title={dateTime(c.createdAt)}>
          {relative ? relativeTime(c.createdAt) : formatDate(c.createdAt)}
        </time>
        {isNew && (
          <span data-testid="comment-new" className="ml-1 rounded-full bg-ui-raise px-1.5 text-meta font-medium text-ui-ink">
            New since the check
          </span>
        )}
      </div>
      <div className="mt-0.5 max-h-56 overflow-y-auto text-meta">
        <Markdown>{c.body}</Markdown>
      </div>
    </li>
  );
}

/** The story view's comments: always open, the newest few, then "Show all n". Nothing when none. */
export function StoryComments({
  comments,
  newIds,
}: {
  comments: readonly TicketComment[] | undefined;
  /** Comments written after the latest story check (lib/ticketComments.ts `newSinceCheckIds`). */
  newIds: ReadonlySet<string>;
}): JSX.Element | null {
  const [all, setAll] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const headingId = useId();
  const listId = useId();
  const listRef = useRef<HTMLOListElement | null>(null);
  const list = comments ?? [];
  useCommentCitation(comments, (id) => {
    if (citedIsHidden(list, id)) setAll(true);
    setFocusId(id);
    setTick((n) => n + 1);
  });
  useFocusComment(listRef, true, focusId, tick);
  if (list.length === 0) return null;
  const shown = shownStoryComments(list, all);
  return (
    <section aria-labelledby={headingId} data-testid="story-comments" className="space-y-1.5">
      <h5 id={headingId} className="text-meta font-medium text-ui-ink">
        Comments ({list.length})
      </h5>
      <ol ref={listRef} id={listId} aria-labelledby={headingId} className="space-y-2">
        {shown.map((c) => (
          <CommentRow key={c.id} c={c} focused={c.id === focusId} relative isNew={newIds.has(c.id)} />
        ))}
      </ol>
      {list.length > STORY_COMMENTS_SHOWN && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll((v) => !v)}
          className="px-1 text-meta text-ui-ink hover:underline touch:min-h-10"
        >
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}

/** Collapsed "Comments (n)" under the ticket as written (a Story check block's disclosure). */
export function TicketComments({ comments }: { comments: readonly TicketComment[] | undefined }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLOListElement | null>(null);
  useCommentCitation(comments, (id) => {
    setOpen(true);
    setFocusId(id);
    setTick((n) => n + 1);
  });
  useFocusComment(listRef, open, focusId, tick);
  if (comments == null || comments.length === 0) return null;
  return (
    <div data-testid="ticket-comments">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="hit inline-flex items-center gap-1 text-meta font-medium text-ui-ink hover:text-ui-ink"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} className="shrink-0" />
        Comments ({comments.length})
      </button>
      <ol ref={listRef} id={listId} hidden={!open} aria-label="Ticket comments" className="mt-1.5 space-y-2">
        {comments.map((c) => (
          <CommentRow key={c.id} c={c} focused={c.id === focusId} />
        ))}
      </ol>
    </div>
  );
}
