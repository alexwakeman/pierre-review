import { useOpenStory } from '../../lib/ticketTab.js';
import { StoryViewBody } from '../Ticket/StoryViewBody.js';
import { ArrowIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';

// THE PR VIEW'S STORY TAB (`?prTab=story`; docs/FRONTEND.md § PrDetail → The Story tab): the story view
// of one of the PR's linked tickets, inside the PR — the SAME body the story tab and This Sprint's tray
// mount (`StoryViewBody`), never a copy, so its layout measures THIS pane (two columns full-screen on a
// wide screen, one in the drawer or on a phone) and its reads are the story view's own two DB reads,
// made when the tab is opened and not before. Listed only while the PR names a ticket Limn can open as
// a story (a `TicketRef.ident` — the "Open story" menu item's condition). A PR naming several stories
// gets one tab each ("Story BMD-1182", "Story BMD-1190", PrDetail). "Open story tab" opens the full
// story tab (`useOpenStory`, the one way in).

export interface PrStoryTicket {
  ident: string;
  key: string;
}

export function PrStoryTab({
  ticket,
  oneColumn = false,
}: {
  ticket: PrStoryTicket;
  /** The PR drawer: always one column. */
  oneColumn?: boolean;
}): JSX.Element {
  const openStory = useOpenStory();
  return (
    <div className="space-y-3 px-5 py-2 max-md:px-3" data-testid="pr-story-tab" data-story={ticket.key}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowIcon size={11} />}
          onClick={() => openStory({ ident: ticket.ident, key: ticket.key, title: null })}
        >
          Open story tab
        </Button>
      </div>
      {/* Keyed on the ticket, so switching stories starts the body afresh. */}
      <StoryViewBody key={ticket.ident} ident={ticket.ident} meta={{ key: ticket.key, title: null }} embedded oneColumn={oneColumn} />
    </div>
  );
}
