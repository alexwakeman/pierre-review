import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import { useOpenTicketTab } from '../lib/ticketTab.js';
import { safeExternalUrl } from '../lib/ui.js';
import { ExternalLinkIcon } from './Icons.js';

// A ticket named in a ticket's text (lib/ticketLinks.ts marks it): the words open the ticket's tab in
// Limn; the small icon beside them still opens it in the tracker. Both stop the click there, so a
// highlighted passage around the link is not selected as well.
//
// A surface may take the click first (`TicketRefOpenContext`): This sprint opens a ticket that is on
// its graph in the graph's drawer; anything it does not handle (returns false) still opens the tab.

export type TicketRefOpener = (t: { ident: string; key: string; title: string | null }) => boolean;
export const TicketRefOpenContext = createContext<TicketRefOpener | null>(null);

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
  const override = useContext(TicketRefOpenContext);
  const external = href != null ? safeExternalUrl(href) : undefined;
  const stop = (e: MouseEvent): void => e.stopPropagation();
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (override?.({ ident, key: ticketKey, title }) === true) return;
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
