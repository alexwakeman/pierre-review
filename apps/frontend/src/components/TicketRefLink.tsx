import type { MouseEvent, ReactNode } from 'react';
import { useOpenTicketTab } from '../lib/ticketTab.js';
import { safeExternalUrl } from '../lib/ui.js';
import { ExternalLinkIcon } from './Icons.js';

// A ticket named in a ticket's text (lib/ticketLinks.ts marks it): the words open the ticket's tab in
// Limn; the small icon beside them still opens it in the tracker. Both stop the click there, so a
// highlighted passage around the link is not selected as well.

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
  const open = useOpenTicketTab();
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
        className="text-left text-sky-700 underline decoration-sky-700/40 underline-offset-2 hover:decoration-sky-700 dark:text-sky-300 dark:decoration-sky-300/40"
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
          className="self-center text-gray-500 hover:text-sky-700 dark:text-gray-400 dark:hover:text-sky-300"
        >
          <ExternalLinkIcon size={10} />
        </a>
      )}
    </span>
  );
}
