import type { MouseEvent, ReactNode } from 'react';
import { useStoryLinkOpener } from '../lib/ticketTab.js';
import { safeExternalUrl } from '../lib/ui.js';
import { ExternalLinkIcon } from './Icons.js';

// A ticket named in a ticket's text (lib/ticketLinks.ts marks it): the words open the ticket's story
// view in Limn (`useStoryLinkOpener`: the page's own opener, e.g. This Sprint's tray, else the story
// tab); the small icon beside them still opens it in the tracker. Both stop
// the click there, so a highlighted passage around the link is not selected as well.

export function TicketRefLink({
  ident,
  ticketKey,
  title,
  href,
  children,
}: {
  ident: string;
  ticketKey: string;
  title: string | null;
  href: string | null;
  children: ReactNode;
}): JSX.Element {
  const open = useStoryLinkOpener();
  const external = href != null ? safeExternalUrl(href) : undefined;
  const stop = (e: MouseEvent): void => e.stopPropagation();
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          open({ ident, key: ticketKey, title });
        }}
        title={title != null ? `${ticketKey} ${title}` : `Open ${ticketKey}`}
        className="hit text-left text-ui-accent underline decoration-ui-accent underline-offset-2 hover:decoration-ui-accent"
        data-testid="ticket-ref-link"
      >
        {children}
      </button>
      {external != null && (
        <a
          href={external}
          target="_blank"
          rel="noreferrer noopener"
          onClick={stop}
          aria-label={`Open ${ticketKey} in the tracker`}
          className="hit self-center text-ui-mute hover:text-ui-accent"
        >
          <ExternalLinkIcon size={10} />
        </a>
      )}
    </span>
  );
}
