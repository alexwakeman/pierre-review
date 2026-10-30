// THE TICKET'S COMMENTS — the people's discussion under a ticket (docs/TRACKERS.md § Ticket comments),
// under the ticket as written. Collapsed by default: a "Comments (n)" toggle, then each comment's author,
// date and body (markdown), oldest first. Bots never reach the wire. Nothing here fetches: the comments
// ride the stored ticket read (`GET /api/prs/:id/tracker-ticket`), which is itself click-gated.
import { useId, useState } from 'react';
import type { TicketComment } from '@pierre-review/shared';
import { dateTime, formatDate } from '../lib/ui.js';
import { ChevronIcon } from './Icons.js';
import { Markdown } from './Markdown.js';

const MUTED = 'text-ui-mute';

export function TicketComments({ comments }: { comments: readonly TicketComment[] | undefined }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const listId = useId();
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
      <ol id={listId} hidden={!open} aria-label="Ticket comments" className="mt-1.5 space-y-2">
        {comments.map((c) => (
          <li key={c.id} className="rounded-ui border border-ui-line px-2 py-1.5">
            <div className={`text-meta ${MUTED}`}>
              <span className="font-medium text-ui-ink">{c.author !== '' ? c.author : 'Someone'}</span>
              <span aria-hidden className="decorative-mark text-ui-faint">
                {' · '}
              </span>
              <time dateTime={c.createdAt} title={dateTime(c.createdAt)}>
                {formatDate(c.createdAt)}
              </time>
            </div>
            <div className="mt-0.5 max-h-56 overflow-y-auto text-meta">
              <Markdown>{c.body}</Markdown>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
