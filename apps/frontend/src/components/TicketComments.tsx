// THE TICKET'S COMMENTS — the people's discussion under a ticket (docs/TRACKERS.md § Ticket comments),
// under the ticket as written. Collapsed by default: a "Comments (n)" toggle, then each comment's author,
// date and body (markdown), oldest first. Bots never reach the wire. Nothing here fetches: the comments
// ride the stored ticket read (`GET /api/prs/:id/tracker-ticket`), which is itself click-gated.
import { useId, useState } from 'react';
import type { TicketComment } from '@pierre-review/shared';
import { dateTime, formatDate } from '../lib/ui.js';
import { ChevronIcon } from './Icons.js';
import { Markdown } from './Markdown.js';

const MUTED = 'text-gray-600 dark:text-gray-300';

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
        className="hit inline-flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} className="shrink-0" />
        Comments ({comments.length})
      </button>
      <ol id={listId} hidden={!open} aria-label="Ticket comments" className="mt-1.5 space-y-2">
        {comments.map((c) => (
          <li key={c.id} className="rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
            <div className={`text-xs ${MUTED}`}>
              <span className="font-medium text-gray-800 dark:text-gray-100">{c.author !== '' ? c.author : 'Someone'}</span>
              <span aria-hidden className="decorative-mark text-gray-400 dark:text-gray-500">
                {' · '}
              </span>
              <time dateTime={c.createdAt} title={dateTime(c.createdAt)}>
                {formatDate(c.createdAt)}
              </time>
            </div>
            <div className="mt-0.5 max-h-56 overflow-y-auto text-xs">
              <Markdown>{c.body}</Markdown>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
